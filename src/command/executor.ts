/** Durable Remote send-input state machine. */

import type { AttachmentIdType } from '@deepseek-ai/dsh-attachment'
import type {
  HostApprovalDecisionInspection, HostApprovalInteractions, HostApprovalRevision,
  HostPromptAdmissions, HostPromptCorrelation, HostPromptCorrelationInspection,
  HostStopAdmissions, HostStopInspection,
} from '@deepseek-ai/dsh-host-apiproxy'
import {
  fingerprintRemoteApprovalDecision,
  fingerprintRemoteCreateSession,
  fingerprintRemoteForkSession,
  fingerprintRemoteRevokeApprovalRule,
  fingerprintRemoteSelectAgentPreset,
  fingerprintRemoteSelectModel,
  fingerprintRemoteSendInput,
  fingerprintRemoteSetSessionBudget,
  fingerprintRemoteStop,
  type RemoteCommandBinding,
  type RemoteCommandCommit,
  type RemoteCommandCommitted,
  type RemoteCommandRequested,
  type RemoteCommandReserved,
  type RemoteControlService,
} from '@w2112515/dsh-remote-host/control'
import type {
  HostApprovalPolicy, HostSessionAdmin,
  RemoteApprovalDecisionCommand, RemoteCommandAuthority, RemoteCommandControlProof,
  RemoteCommandReceived, RemoteCommandService,
  RemoteCommandTerminal, RemoteCreateSessionCommand, RemoteForkSessionCommand,
  RemoteRevokeApprovalRuleCommand,
  RemoteSelectAgentPresetCommand, RemoteSelectModelCommand,
  RemoteSendInputCommand, RemoteSetSessionBudgetCommand,
  RemoteStopCommand, RemoteStopRequestedReceipt, RemoteStopTerminal,
} from './types.ts'

function terminalFromRow(
  row: RemoteCommandCommitted | { readonly commandId: RemoteCommandCommitted['commandId']; readonly phase: 'rejected'; readonly rejection: { readonly code: string } },
  replayed: boolean,
): RemoteCommandTerminal {
  return row.phase === 'committed'
    ? Object.freeze({ outcome: 'committed', commandId: row.commandId, replayed })
    : Object.freeze({
      outcome: 'rejected', commandId: row.commandId, replayed, errorCode: row.rejection.code,
    })
}

function stopTerminalFromRow(
  row: RemoteCommandCommitted | { readonly commandId: RemoteCommandCommitted['commandId']; readonly phase: 'rejected'; readonly rejection: { readonly code: string } },
  expectedActivityRevision: number,
  replayed: boolean,
): RemoteStopTerminal {
  return row.phase === 'committed'
    ? Object.freeze({
      outcome: 'stopped', commandId: row.commandId, expectedActivityRevision, replayed,
    })
    : Object.freeze({
      outcome: 'rejected', commandId: row.commandId, expectedActivityRevision, replayed,
      errorCode: row.rejection.code,
    })
}

/** Package-private command owner mounted behind `ctx.remoteCommands`. */
export class RemoteCommandExecutor implements RemoteCommandService {
  private readonly inFlight = new Map<RemoteCommandBinding['commandId'], Promise<RemoteCommandTerminal>>()
  private readonly stopInFlight = new Map<RemoteCommandBinding['commandId'], Promise<RemoteStopTerminal>>()
  private readonly approvalInFlight = new Map<RemoteCommandBinding['commandId'], Promise<RemoteCommandTerminal>>()
  private readonly adminInFlight = new Map<RemoteCommandBinding['commandId'], Promise<RemoteCommandTerminal>>()
  private admissionOpen = true

  /**
   * @param prompts - Host-only two-phase ApiProxy admission face.
   * @param stops - Host-only exact-turn cancellation and physical terminal inspection.
   * @param control - durable idempotency and control-fence owner.
   * @param logger - contained callback and post-commit wake diagnostics.
   * @param stopSettlementTimeoutMs - caller-visible wait before returning honest UNKNOWN while ownership continues.
   * @param approvals - Host-only approval decision face.
   * @param sessionAdmin - Host-only Session create/preset-select face (S-mode-select).
   * @param policy - lazy Host session-policy face (S-policy); absent keeps policy commands refused.
   */
  constructor(
    private readonly prompts: HostPromptAdmissions,
    private readonly stops: HostStopAdmissions,
    private readonly control: RemoteControlService,
    private readonly logger: { warn(message: string): void },
    private readonly stopSettlementTimeoutMs = 30_000,
    private readonly approvals?: HostApprovalInteractions,
    private readonly sessionAdmin?: HostSessionAdmin,
    private readonly policy?: () => HostApprovalPolicy | undefined,
  ) {}

  async sendInput(
    authority: RemoteCommandAuthority,
    command: RemoteSendInputCommand,
    onReceived?: (receipt: RemoteCommandReceived) => void,
  ): Promise<RemoteCommandTerminal> {
    if (!this.admissionOpen) throw new Error('remote command executor is disposing')
    const requestFingerprint = fingerprintRemoteSendInput({
      sessionId: command.sessionId,
      text: command.text,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      controlEpoch: command.control.epoch,
      ...(command.attachmentIds === undefined ? {} : { attachmentIds: command.attachmentIds }),
    })
    const binding: RemoteCommandBinding = Object.freeze({
      commandId: command.commandId,
      operation: 'send_input',
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      controlEpoch: command.control.epoch,
    })
    const reservation = await this.control.reserveCommand(binding)
    if (reservation.kind === 'conflict') {
      return Object.freeze({
        outcome: 'rejected', commandId: command.commandId, replayed: true, errorCode: 'command-id-reused',
      })
    }
    if (reservation.kind === 'replay') {
      if (reservation.row.phase === 'rejected') return terminalFromRow(reservation.row, true)
      return this.replayCommitted(reservation.row)
    }
    if (reservation.row.phase !== 'reserved') {
      return this.unknown(command, 'journal-operation-conflict', true)
    }

    const replayed = reservation.kind === 'pending'
    this.notifyReceived(onReceived, {
      outcome: 'received', commandId: command.commandId, replayed,
    })
    const existing = this.inFlight.get(command.commandId)
    if (existing !== undefined) return this.withReplay(await existing, true)

    const operation = this.execute(authority, command, reservation.row, replayed)
    this.inFlight.set(command.commandId, operation)
    try {
      return this.withReplay(await operation, replayed)
    } finally {
      if (this.inFlight.get(command.commandId) === operation) this.inFlight.delete(command.commandId)
    }
  }

  async stop(
    authority: RemoteCommandAuthority,
    command: RemoteStopCommand,
    onRequested?: (receipt: RemoteStopRequestedReceipt) => void,
  ): Promise<RemoteStopTerminal> {
    if (!this.admissionOpen) throw new Error('remote command executor is disposing')
    const requestFingerprint = fingerprintRemoteStop({
      sessionId: command.sessionId,
      targetTurn: command.expectedActivityRevision,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      controlEpoch: command.control.epoch,
    })
    const binding: RemoteCommandBinding = Object.freeze({
      commandId: command.commandId,
      operation: 'stop',
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      controlEpoch: command.control.epoch,
      targetTurn: command.expectedActivityRevision,
    })
    const reservation = await this.control.reserveCommand(binding)
    if (reservation.kind === 'conflict') {
      return this.stopRejected(command, 'command-id-reused', true)
    }
    if (reservation.kind === 'replay') {
      if (reservation.row.phase === 'rejected') {
        return stopTerminalFromRow(reservation.row, command.expectedActivityRevision, true)
      }
      return this.replayStopped(command, reservation.row)
    }
    if (reservation.row.phase === 'requested') {
      this.notifyStopRequested(onRequested, command, true)
    }
    const existing = this.stopInFlight.get(command.commandId)
    if (existing !== undefined) return this.awaitStop(existing, command, true)

    const operation = this.executeStop(authority, command, reservation.row, onRequested)
    this.stopInFlight.set(command.commandId, operation)
    void operation.finally(() => {
      if (this.stopInFlight.get(command.commandId) === operation) this.stopInFlight.delete(command.commandId)
    }).catch(() => {})
    return this.awaitStop(operation, command, reservation.kind === 'pending')
  }

  async decideApproval(
    authority: RemoteCommandAuthority,
    command: RemoteApprovalDecisionCommand,
    onReceived?: (receipt: RemoteCommandReceived) => void,
  ): Promise<RemoteCommandTerminal> {
    if (!this.admissionOpen) throw new Error('remote command executor is disposing')
    const requestFingerprint = fingerprintRemoteApprovalDecision({
      sessionId: command.sessionId,
      approvalId: command.approvalId,
      approvalRevision: command.approvalRevision,
      outcome: command.outcome,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      ...(command.grantSameKind === true ? { grantSameKind: true } : {}),
    })
    const binding: RemoteCommandBinding = Object.freeze({
      commandId: command.commandId,
      operation: 'decide_approval',
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      approvalId: command.approvalId,
      approvalRevision: command.approvalRevision,
      approvalOutcome: command.outcome,
    })
    const reservation = await this.control.reserveCommand(binding)
    if (reservation.kind === 'conflict') {
      return Object.freeze({
        outcome: 'rejected', commandId: command.commandId,
        replayed: true, errorCode: 'command-id-reused',
      })
    }
    if (reservation.kind === 'replay') {
      if (reservation.row.phase === 'rejected') return terminalFromRow(reservation.row, true)
      return this.replayApproval(command, reservation.row)
    }
    if (reservation.row.phase !== 'reserved') {
      return this.unknown(command, 'journal-operation-conflict', true)
    }
    const replayed = reservation.kind === 'pending'
    this.notifyReceived(onReceived, { outcome: 'received', commandId: command.commandId, replayed })
    const existing = this.approvalInFlight.get(command.commandId)
    if (existing !== undefined) return this.withReplay(await existing, true)
    const operation = this.executeApproval(authority, command, reservation.row, replayed)
    this.approvalInFlight.set(command.commandId, operation)
    try {
      return this.withReplay(await operation, replayed)
    } finally {
      if (this.approvalInFlight.get(command.commandId) === operation) {
        this.approvalInFlight.delete(command.commandId)
      }
    }
  }

  async createSession(
    authority: RemoteCommandAuthority,
    command: RemoteCreateSessionCommand,
    onReceived?: (receipt: RemoteCommandReceived) => void,
  ): Promise<RemoteCommandTerminal> {
    if (!this.admissionOpen) throw new Error('remote command executor is disposing')
    const requestFingerprint = fingerprintRemoteCreateSession({
      sessionId: command.sessionId,
      agentPreset: command.agentPreset,
      workspaceId: command.workspaceId,
      newWorkspaceName: command.newWorkspaceName,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
    })
    const binding: RemoteCommandBinding = Object.freeze({
      commandId: command.commandId,
      operation: 'create_session',
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      ...(command.agentPreset === undefined ? {} : { agentPreset: command.agentPreset }),
    })
    return this.runAdminCommand(authority, command, binding, onReceived, async () => {
      if (this.sessionAdmin === undefined) return { ok: false as const, errorCode: 'session-admin-unavailable' }
      try {
        return await this.sessionAdmin.createSession({
          sessionId: command.sessionId,
          ...(command.agentPreset === undefined ? {} : { agentPreset: command.agentPreset }),
          ...(command.workspaceId === undefined ? {} : { workspaceId: command.workspaceId }),
          ...(command.newWorkspaceName === undefined ? {} : { newWorkspaceName: command.newWorkspaceName }),
        })
      } catch {
        return { ok: false as const, errorCode: 'session-admin-unavailable' }
      }
    }, async () => {
      // Replay/reconcile: creation is naturally idempotent at the owner, so
      // re-issuing the exact same create converges whether or not the first
      // attempt's effect landed. A conflict means the preallocated id was
      // taken by different semantics — the commit fact cannot be re-proven.
      if (this.sessionAdmin === undefined) return false
      try {
        const again = await this.sessionAdmin.createSession({
          sessionId: command.sessionId,
          ...(command.agentPreset === undefined ? {} : { agentPreset: command.agentPreset }),
          ...(command.workspaceId === undefined ? {} : { workspaceId: command.workspaceId }),
          ...(command.newWorkspaceName === undefined ? {} : { newWorkspaceName: command.newWorkspaceName }),
        })
        return again.ok
      } catch {
        return false
      }
    }, result => ({
      created: true as const,
      ...(result.agentPreset === undefined ? {} : { agentPreset: result.agentPreset }),
    }))
  }

  async selectAgentPreset(
    authority: RemoteCommandAuthority,
    command: RemoteSelectAgentPresetCommand,
    onReceived?: (receipt: RemoteCommandReceived) => void,
  ): Promise<RemoteCommandTerminal> {
    if (!this.admissionOpen) throw new Error('remote command executor is disposing')
    const requestFingerprint = fingerprintRemoteSelectAgentPreset({
      sessionId: command.sessionId,
      agentPreset: command.agentPreset,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
    })
    const binding: RemoteCommandBinding = Object.freeze({
      commandId: command.commandId,
      operation: 'select_agent_preset',
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      agentPreset: command.agentPreset,
    })
    return this.runAdminCommand(authority, command, binding, onReceived, async () => {
      if (this.sessionAdmin === undefined) return { ok: false as const, errorCode: 'session-admin-unavailable' }
      try {
        return await this.sessionAdmin.selectAgentPreset({
          sessionId: command.sessionId,
          agentPreset: command.agentPreset,
        })
      } catch {
        return { ok: false as const, errorCode: 'session-admin-unavailable' }
      }
    }, async () => {
      // Replay/reconcile: re-selecting the same preset on a still-blank
      // session proves the commit fact. agent-preset-locked means a turn has
      // started since, so the fact can no longer be re-proven this way.
      if (this.sessionAdmin === undefined) return false
      try {
        const again = await this.sessionAdmin.selectAgentPreset({
          sessionId: command.sessionId,
          agentPreset: command.agentPreset,
        })
        return again.ok
      } catch {
        return false
      }
    }, () => ({ selectedPreset: command.agentPreset }))
  }

  async selectModel(
    authority: RemoteCommandAuthority,
    command: RemoteSelectModelCommand,
    onReceived?: (receipt: RemoteCommandReceived) => void,
  ): Promise<RemoteCommandTerminal> {
    if (!this.admissionOpen) throw new Error('remote command executor is disposing')
    const modelSelection = Object.freeze({
      provider: command.provider,
      model: command.model,
      ...(command.reasoningEffort === undefined ? {} : { reasoningEffort: command.reasoningEffort }),
    })
    const requestFingerprint = fingerprintRemoteSelectModel({
      sessionId: command.sessionId,
      provider: command.provider,
      model: command.model,
      reasoningEffort: command.reasoningEffort,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      controlEpoch: command.control.epoch,
    })
    const binding: RemoteCommandBinding = Object.freeze({
      commandId: command.commandId,
      operation: 'select_model',
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      controlEpoch: command.control.epoch,
      modelSelection,
    })
    const reservation = await this.control.reserveCommand(binding)
    if (reservation.kind === 'conflict') {
      return Object.freeze({
        outcome: 'rejected', commandId: command.commandId, replayed: true, errorCode: 'command-id-reused',
      })
    }
    if (reservation.kind === 'replay') {
      if (reservation.row.phase === 'rejected') return terminalFromRow(reservation.row, true)
      // Replay/reconcile: the selection is set-valued at the owner, so
      // re-issuing the exact same triple converges whether or not the first
      // attempt's effect landed. model-unavailable now means the fact can no
      // longer be re-proven this way.
      return (await this.reproveSelectModel(command))
        ? terminalFromRow(reservation.row, true)
        : this.unknown(command, 'committed-fact-unavailable', true)
    }
    if (reservation.row.phase !== 'reserved') {
      return this.unknown(command, 'journal-operation-conflict', true)
    }
    const replayed = reservation.kind === 'pending'
    this.notifyReceived(onReceived, { outcome: 'received', commandId: command.commandId, replayed })
    const existing = this.adminInFlight.get(command.commandId)
    if (existing !== undefined) return this.withReplay(await existing, true)

    const operation = this.executeSelectModel(authority, command, reservation.row)
    this.adminInFlight.set(command.commandId, operation)
    try {
      return this.withReplay(await operation, replayed)
    } finally {
      if (this.adminInFlight.get(command.commandId) === operation) {
        this.adminInFlight.delete(command.commandId)
      }
    }
  }

  async forkSession(
    authority: RemoteCommandAuthority,
    command: RemoteForkSessionCommand,
    onReceived?: (receipt: RemoteCommandReceived) => void,
  ): Promise<RemoteCommandTerminal> {
    if (!this.admissionOpen) throw new Error('remote command executor is disposing')
    const requestFingerprint = fingerprintRemoteForkSession({
      sessionId: command.sessionId,
      childSessionId: command.childSessionId,
      atSeq: command.atSeq,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
    })
    const binding: RemoteCommandBinding = Object.freeze({
      commandId: command.commandId,
      operation: 'fork_session',
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      childSessionId: command.childSessionId,
      ...(command.atSeq === undefined ? {} : { forkAtSeq: command.atSeq }),
    })
    return this.runAdminCommand(authority, command, binding, onReceived, async () => {
      if (this.sessionAdmin === undefined) return { ok: false as const, errorCode: 'session-admin-unavailable' }
      try {
        return await this.sessionAdmin.forkSession({
          sessionId: command.sessionId,
          childSessionId: command.childSessionId,
          ...(command.atSeq === undefined ? {} : { atSeq: command.atSeq }),
        })
      } catch {
        return { ok: false as const, errorCode: 'session-admin-unavailable' }
      }
    }, async () => {
      // Replay/reconcile: the owner converges the same preallocated child id
      // with the same lineage to the existing child; a conflict means the id
      // was taken by different lineage, so the commit fact cannot be re-proven.
      if (this.sessionAdmin === undefined) return false
      try {
        const again = await this.sessionAdmin.forkSession({
          sessionId: command.sessionId,
          childSessionId: command.childSessionId,
          ...(command.atSeq === undefined ? {} : { atSeq: command.atSeq }),
        })
        return again.ok
      } catch {
        return false
      }
    }, () => ({ forked: true as const, childSessionId: command.childSessionId }))
  }

  async revokeApprovalRule(
    authority: RemoteCommandAuthority,
    command: RemoteRevokeApprovalRuleCommand,
    onReceived?: (receipt: RemoteCommandReceived) => void,
  ): Promise<RemoteCommandTerminal> {
    if (!this.admissionOpen) throw new Error('remote command executor is disposing')
    const requestFingerprint = fingerprintRemoteRevokeApprovalRule({
      sessionId: command.sessionId,
      ruleId: command.ruleId,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
    })
    const binding: RemoteCommandBinding = Object.freeze({
      commandId: command.commandId,
      operation: 'revoke_approval_rule',
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      ruleId: command.ruleId,
    })
    return this.runAdminCommand(authority, command, binding, onReceived, async () => {
      const policy = this.policy?.()
      if (policy === undefined) return { ok: false as const, errorCode: 'approval-policy-unavailable' }
      try {
        return await policy.revokeRule({ sessionId: command.sessionId, ruleId: command.ruleId })
      } catch {
        return { ok: false as const, errorCode: 'approval-policy-unavailable' }
      }
    }, () => {
      // Replay/reconcile: rule ids are minted once and never re-granted, so a
      // committed revocation is re-proven by the rule's absence — no second
      // append is needed to converge.
      const policy = this.policy?.()
      if (policy === undefined) return Promise.resolve(false)
      try {
        return Promise.resolve(!policy.isRuleActive({ sessionId: command.sessionId, ruleId: command.ruleId }))
      } catch {
        return Promise.resolve(false)
      }
    }, () => ({ revokedRuleId: command.ruleId }))
  }

  async setSessionBudget(
    authority: RemoteCommandAuthority,
    command: RemoteSetSessionBudgetCommand,
    onReceived?: (receipt: RemoteCommandReceived) => void,
  ): Promise<RemoteCommandTerminal> {
    if (!this.admissionOpen) throw new Error('remote command executor is disposing')
    const requestFingerprint = fingerprintRemoteSetSessionBudget({
      sessionId: command.sessionId,
      maxTotalTokens: command.maxTotalTokens,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
    })
    const binding: RemoteCommandBinding = Object.freeze({
      commandId: command.commandId,
      operation: 'set_session_budget',
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      maxTotalTokens: command.maxTotalTokens,
    })
    return this.runAdminCommand(authority, command, binding, onReceived, async () => {
      const policy = this.policy?.()
      if (policy === undefined) return { ok: false as const, errorCode: 'approval-policy-unavailable' }
      try {
        return await policy.setBudget({ sessionId: command.sessionId, maxTotalTokens: command.maxTotalTokens })
      } catch {
        return { ok: false as const, errorCode: 'approval-policy-unavailable' }
      }
    }, async () => {
      // Replay/reconcile: the ceiling is last-wins at the owner, so an equal
      // current value proves the fact without appending, and re-issuing the
      // exact bound ceiling converges otherwise (the select_model precedent).
      const policy = this.policy?.()
      if (policy === undefined) return false
      try {
        if (policy.currentBudget(command.sessionId) === command.maxTotalTokens) return true
        const again = await policy.setBudget({
          sessionId: command.sessionId,
          maxTotalTokens: command.maxTotalTokens,
        })
        return again.ok
      } catch {
        return false
      }
    }, () => ({ budgetSet: true as const, maxTotalTokens: command.maxTotalTokens }))
  }

  private async reproveSelectModel(command: RemoteSelectModelCommand): Promise<boolean> {
    if (this.sessionAdmin === undefined) return false
    try {
      const again = await this.sessionAdmin.selectModel({
        sessionId: command.sessionId,
        provider: command.provider,
        model: command.model,
        ...(command.reasoningEffort === undefined ? {} : { reasoningEffort: command.reasoningEffort }),
      })
      return again.ok
    } catch {
      return false
    }
  }

  private async executeSelectModel(
    authority: RemoteCommandAuthority,
    command: RemoteSelectModelCommand,
    row: RemoteCommandReserved,
  ): Promise<RemoteCommandTerminal> {
    const proofFailure = command.control.sessionId !== command.sessionId
      || command.control.holderDeviceId !== authority.deviceId
    if (proofFailure) return this.reject(row, 'invalid-control-proof')

    const preflight = await this.authorizedAdmission(command, authority, () => undefined)
    if (preflight.kind === 'threw') return this.reject(row, 'authorization-denied')
    if (preflight.kind === 'refused') return this.reject(row, preflight.errorCode)

    const sessionAdmin = this.sessionAdmin
    if (sessionAdmin === undefined) return this.reject(row, 'session-admin-unavailable')
    // The lease admit seam is synchronous — a thenable throws
    // `remote control effect admission must be synchronous` and the carrier
    // reports UNKNOWN. Preflight proves the fence; the async ApiProxy
    // mutation runs after that check. The selection is last-wins / set-valued,
    // so a lease drop between the two is a retry, not a split brain.
    let result: Awaited<ReturnType<HostSessionAdmin['selectModel']>>
    try {
      result = await sessionAdmin.selectModel({
        sessionId: command.sessionId,
        provider: command.provider,
        model: command.model,
        ...(command.reasoningEffort === undefined ? {} : { reasoningEffort: command.reasoningEffort }),
      })
    } catch {
      return this.unknown(command, 'session-admin-unavailable')
    }
    if (!result.ok) return this.reject(row, result.errorCode)

    try {
      await this.control.commitCommand(command.commandId, row.requestFingerprint, {
        selectedModel: {
          provider: command.provider,
          model: command.model,
          ...(command.reasoningEffort === undefined ? {} : { reasoningEffort: command.reasoningEffort }),
        },
      })
    } catch (error: unknown) {
      this.logger.warn(`remote-command: durable model selection committed but journal repair is pending: ${String(error)}`)
    }
    return Object.freeze({ outcome: 'committed', commandId: command.commandId, replayed: false })
  }

  /**
   * Shared reserve/dedup/execute/replay pipeline for the lease-free session
   * admin commands (S-mode-select, S-session-admin fork). Each owner call is
   * set-valued and idempotent, so a reserved-but-unproven row converges by
   * re-execution and a committed row is re-proven by the same call.
   */
  private async runAdminCommand<TResult extends { readonly ok: true }>(
    authority: RemoteCommandAuthority,
    command: { readonly commandId: RemoteCreateSessionCommand['commandId'] },
    binding: RemoteCommandBinding,
    onReceived: ((receipt: RemoteCommandReceived) => void) | undefined,
    effect: () => Promise<TResult | { readonly ok: false; readonly errorCode: string }>,
    reprove: () => Promise<boolean>,
    commit: (result: TResult) => RemoteCommandCommit,
  ): Promise<RemoteCommandTerminal> {
    const reservation = await this.control.reserveCommand(binding)
    if (reservation.kind === 'conflict') {
      return Object.freeze({
        outcome: 'rejected', commandId: command.commandId, replayed: true, errorCode: 'command-id-reused',
      })
    }
    if (reservation.kind === 'replay') {
      if (reservation.row.phase === 'rejected') return terminalFromRow(reservation.row, true)
      return (await reprove())
        ? terminalFromRow(reservation.row, true)
        : this.unknown(command, 'committed-fact-unavailable', true)
    }
    const reservedRow = reservation.row
    if (reservedRow.phase !== 'reserved') {
      return this.unknown(command, 'journal-operation-conflict', true)
    }
    const replayed = reservation.kind === 'pending'
    this.notifyReceived(onReceived, { outcome: 'received', commandId: command.commandId, replayed })
    const existing = this.adminInFlight.get(command.commandId)
    if (existing !== undefined) return this.withReplay(await existing, true)

    const operation = (async (): Promise<RemoteCommandTerminal> => {
      try {
        authority.authorize()
      } catch {
        return this.reject(reservedRow, 'authorization-denied')
      }
      const result = await effect()
      if (!result.ok) return this.reject(reservedRow, result.errorCode)
      try {
        await this.control.commitCommand(command.commandId, reservedRow.requestFingerprint, commit(result))
      } catch (error: unknown) {
        this.logger.warn(`remote-command: durable session admin effect committed but journal repair is pending: ${String(error)}`)
      }
      return Object.freeze({ outcome: 'committed', commandId: command.commandId, replayed: false })
    })()
    this.adminInFlight.set(command.commandId, operation)
    try {
      return this.withReplay(await operation, replayed)
    } finally {
      if (this.adminInFlight.get(command.commandId) === operation) {
        this.adminInFlight.delete(command.commandId)
      }
    }
  }

  /** Stop new commands and await every accepted owner operation. */
  async close(): Promise<void> {
    this.admissionOpen = false
    await Promise.allSettled([
      ...this.inFlight.values(), ...this.stopInFlight.values(), ...this.approvalInFlight.values(),
      ...this.adminInFlight.values(),
    ])
  }

  private async execute(
    authority: RemoteCommandAuthority,
    command: RemoteSendInputCommand,
    row: RemoteCommandReserved,
    reconcile: boolean,
  ): Promise<RemoteCommandTerminal> {
    const correlation = row.correlation as unknown as HostPromptCorrelation
    if (reconcile) {
      let inspection: HostPromptCorrelationInspection
      try {
        inspection = await this.prompts.inspect(command.sessionId, correlation)
      } catch {
        return this.unknown(command, 'reconciliation-unavailable', true)
      }
      if (inspection.kind === 'conflict') return this.unknown(command, 'correlation-conflict', true)
      if (inspection.kind === 'pending') return this.unknown(command, 'durability-pending', true)
      if (inspection.kind === 'committed') {
        return this.repairCommit(row, inspection)
      }
    }

    const proofFailure = command.control.sessionId !== command.sessionId
      || command.control.holderDeviceId !== authority.deviceId
    if (proofFailure) return this.reject(row, 'invalid-control-proof')

    const preflight = await this.authorizedAdmission(command, authority, () => undefined)
    if (preflight.kind === 'threw') return this.reject(row, 'authorization-denied')
    if (preflight.kind === 'refused') return this.reject(row, preflight.errorCode)

    // S-policy budget gate (ADR-006): the owner's exhaustion decision against
    // the cumulative usage projection refuses NEW turns; an absent budget or
    // an unmeasurable total is never a gate, and the in-flight turn is not
    // killed. Contained: a throwing gate states no fact.
    let budgetGate: { readonly exhausted: boolean } | undefined
    try {
      budgetGate = this.policy?.()?.evaluateBudget(command.sessionId)
    } catch {
      budgetGate = undefined
    }
    if (budgetGate?.exhausted === true) return this.reject(row, 'budget-exhausted')

    const prepared = await this.prompts.prepareText({
      sessionId: command.sessionId,
      text: command.text,
      correlation,
      ...(command.attachmentIds === undefined
        ? {}
        : { images: command.attachmentIds.map(id => id as AttachmentIdType) }),
    })
    if (!prepared.ok) return this.reject(row, prepared.error.code)

    const admitted = await this.authorizedAdmission(command, authority, () => prepared.prepared.admit())
    if (admitted.kind === 'threw') return this.unknown(command, 'admission-outcome-unknown')
    if (admitted.kind === 'refused') return this.reject(row, admitted.errorCode)
    if (!admitted.value.ok) return this.reject(row, admitted.value.error.code)
    const receipt = admitted.value.receipt
    if (receipt.correlation !== correlation) return this.unknown(command, 'correlation-conflict')

    let durable: boolean
    try {
      durable = await receipt.flush()
    } catch {
      return this.unknown(command, 'durability-unavailable')
    }
    if (!durable) return this.unknown(command, 'durability-unavailable')

    const commit = {
      sessionEventSeq: receipt.sessionEventSeq,
      messageId: receipt.messageId,
    }
    try {
      await this.control.commitCommand(command.commandId, row.requestFingerprint, commit)
    } catch (error: unknown) {
      this.logger.warn(`remote-command: durable Session input committed but journal repair is pending: ${String(error)}`)
    }
    try {
      receipt.wake()
    } catch (error: unknown) {
      this.logger.warn(`remote-command: durable Session input could not wake its Agent: ${String(error)}`)
    }
    return Object.freeze({ outcome: 'committed', commandId: command.commandId, replayed: false })
  }

  private async replayCommitted(row: RemoteCommandCommitted): Promise<RemoteCommandTerminal> {
    if (!('sessionEventSeq' in row.commit)) {
      return this.unknown({ commandId: row.commandId }, 'committed-fact-unavailable', true)
    }
    try {
      const inspected = await this.prompts.inspect(
        row.sessionId,
        row.correlation as unknown as HostPromptCorrelation,
      )
      if (inspected.kind !== 'committed'
        || inspected.messageId !== row.commit.messageId
        || inspected.sessionEventSeq !== row.commit.sessionEventSeq) {
        return this.unknown({ commandId: row.commandId }, 'committed-fact-unavailable', true)
      }
      return terminalFromRow(row, true)
    } catch {
      return this.unknown({ commandId: row.commandId }, 'reconciliation-unavailable', true)
    }
  }

  private async repairCommit(
    row: RemoteCommandReserved,
    inspection: Extract<HostPromptCorrelationInspection, { kind: 'committed' }>,
  ): Promise<RemoteCommandTerminal> {
    try {
      await this.control.commitCommand(row.commandId, row.requestFingerprint, {
        sessionEventSeq: inspection.sessionEventSeq,
        messageId: inspection.messageId,
      })
      if (inspection.pending) {
        try {
          await this.prompts.wakeCorrelated(
            row.sessionId,
            row.correlation as unknown as HostPromptCorrelation,
          )
        } catch (error: unknown) {
          this.logger.warn(`remote-command: repaired durable input could not wake its Agent: ${String(error)}`)
        }
      }
      return Object.freeze({ outcome: 'committed', commandId: row.commandId, replayed: true })
    } catch {
      return this.unknown({ commandId: row.commandId }, 'journal-unavailable', true)
    }
  }

  private async executeApproval(
    authority: RemoteCommandAuthority,
    command: RemoteApprovalDecisionCommand,
    row: RemoteCommandReserved,
    reconcile: boolean,
  ): Promise<RemoteCommandTerminal> {
    if (reconcile) {
      const inspection = await this.inspectApproval(command)
      if (inspection.kind === 'conflict') return this.unknown(command, 'approval-settlement-conflict', true)
      if (inspection.kind === 'decided') {
        if (inspection.outcome !== command.outcome) {
          return this.reject(row, 'approval-already-settled')
        }
        return this.repairApprovalCommit(command, row, inspection)
      }
    }

    try {
      authority.authorize()
    } catch {
      return this.reject(row, 'authorization-denied')
    }
    if (this.approvals === undefined) return this.reject(row, 'approval-owner-unavailable')
    const prepared = this.approvals.prepareDecision({
      sessionId: command.sessionId,
      approvalId: command.approvalId as never,
      revision: command.approvalRevision as HostApprovalRevision,
      outcome: command.outcome,
    })
    if (!prepared.ok) return this.reject(row, prepared.error.code)

    if (command.grantSameKind === true) {
      // S-policy third decision: mint the session rule from the still-pending
      // ask's honest facts BEFORE the one-shot admit consumes them. Grant is
      // set-valued at the owner (same-class dedup), so a crash between the
      // durable rule append and the settle converges on retry.
      if (command.outcome !== 'allowed-once') {
        return this.reject(row, 'approval-outcome-not-allowed')
      }
      const policy = this.policy?.()
      if (policy === undefined) return this.reject(row, 'approval-policy-unavailable')
      const pending = this.approvals.list(command.sessionId)
        .find(interaction => String(interaction.approvalId) === command.approvalId)
      if (pending === undefined) return this.reject(row, 'approval-not-pending')
      let granted: Awaited<ReturnType<HostApprovalPolicy['grantForApproval']>>
      try {
        granted = await policy.grantForApproval({
          sessionId: command.sessionId,
          toolName: pending.toolName,
          ...(pending.reason === undefined ? {} : { reason: pending.reason }),
        })
      } catch {
        return this.unknown(command, 'approval-policy-unavailable')
      }
      if (!granted.ok) return this.reject(row, granted.errorCode)
    }

    let admitted: ReturnType<typeof prepared.prepared.admit>
    try {
      authority.authorize()
      admitted = prepared.prepared.admit()
    } catch {
      return this.reject(row, 'authorization-denied')
    }
    if (!admitted.ok) return this.reject(row, admitted.error.code)

    let settled: Awaited<ReturnType<typeof admitted.receipt.settle>>
    try {
      settled = await admitted.receipt.settle()
    } catch {
      return this.unknown(command, 'approval-settlement-unavailable')
    }
    if (!settled.durable
      || settled.inspection.kind !== 'decided'
      || settled.inspection.outcome !== command.outcome) {
      return this.unknown(
        command,
        settled.inspection.kind === 'conflict'
          ? 'approval-settlement-conflict'
          : 'approval-settlement-unavailable',
      )
    }
    try {
      await this.control.commitCommand(row.commandId, row.requestFingerprint, {
        approvalId: command.approvalId,
        outcome: command.outcome,
        decidedEventSeq: settled.inspection.eventSeq,
      })
    } catch (error: unknown) {
      this.logger.warn(`remote-command: durable approval decision committed but journal repair is pending: ${String(error)}`)
    }
    return Object.freeze({ outcome: 'committed', commandId: command.commandId, replayed: false })
  }

  private async replayApproval(
    command: RemoteApprovalDecisionCommand,
    row: RemoteCommandCommitted,
  ): Promise<RemoteCommandTerminal> {
    if (!('decidedEventSeq' in row.commit)
      || row.commit.approvalId !== command.approvalId
      || row.commit.outcome !== command.outcome) {
      return this.unknown(command, 'committed-fact-unavailable', true)
    }
    const inspection = await this.inspectApproval(command)
    if (inspection.kind !== 'decided'
      || inspection.eventSeq !== row.commit.decidedEventSeq
      || inspection.outcome !== command.outcome) {
      return this.unknown(command, 'committed-fact-unavailable', true)
    }
    return terminalFromRow(row, true)
  }

  private async repairApprovalCommit(
    command: RemoteApprovalDecisionCommand,
    row: RemoteCommandReserved,
    inspection: Extract<HostApprovalDecisionInspection, { kind: 'decided' }>,
  ): Promise<RemoteCommandTerminal> {
    try {
      await this.control.commitCommand(row.commandId, row.requestFingerprint, {
        approvalId: command.approvalId,
        outcome: command.outcome,
        decidedEventSeq: inspection.eventSeq,
      })
      return Object.freeze({ outcome: 'committed', commandId: command.commandId, replayed: true })
    } catch {
      return this.unknown(command, 'journal-unavailable', true)
    }
  }

  private async inspectApproval(command: RemoteApprovalDecisionCommand): Promise<HostApprovalDecisionInspection> {
    try {
      if (this.approvals === undefined) return { kind: 'conflict' }
      return await this.approvals.inspect({
        sessionId: command.sessionId,
        approvalId: command.approvalId as never,
      })
    } catch {
      return { kind: 'conflict' }
    }
  }

  private async executeStop(
    authority: RemoteCommandAuthority,
    command: RemoteStopCommand,
    row: RemoteCommandReserved | RemoteCommandRequested,
    onRequested?: (receipt: RemoteStopRequestedReceipt) => void,
  ): Promise<RemoteStopTerminal> {
    const target = Object.freeze({
      sessionId: command.sessionId,
      turn: command.expectedActivityRevision,
    })
    if (row.phase === 'requested') {
      const recovered = await this.inspectStopped(target)
      if (recovered.kind === 'stopped') return this.repairStopCommit(command, row, recovered)
      return this.stopUnknown(command, recovered.kind === 'conflict' ? 'stop-terminal-conflict' : 'stop-settlement-pending', true)
    }

    const proofFailure = command.control.sessionId !== command.sessionId
      || command.control.holderDeviceId !== authority.deviceId
    if (proofFailure) return this.rejectStop(row, command, 'invalid-control-proof')

    const preflight = await this.authorizedAdmission(command, authority, () => undefined)
    if (preflight.kind === 'threw') return this.rejectStop(row, command, 'authorization-denied')
    if (preflight.kind === 'refused') return this.rejectStop(row, command, preflight.errorCode)

    const prepared = await this.stops.prepare(target)
    if (!prepared.ok) {
      const code = prepared.error.code === 'session-not-found' ? 'session-not-found' : 'activity-revision-stale'
      return this.rejectStop(row, command, code)
    }
    const admitted = await this.authorizedAdmission(command, authority, () => prepared.prepared.admit())
    if (admitted.kind === 'threw') return this.stopUnknown(command, 'stop-admission-outcome-unknown')
    if (admitted.kind === 'refused') return this.rejectStop(row, command, admitted.errorCode)
    if (!admitted.value.ok) return this.rejectStop(row, command, 'activity-revision-stale')

    try {
      await this.control.markCommandRequested(
        row.commandId,
        row.requestFingerprint,
        { targetTurn: command.expectedActivityRevision },
      )
    } catch {
      return this.stopUnknown(command, 'journal-unavailable')
    }
    this.notifyStopRequested(onRequested, command, false)

    let settled: Awaited<ReturnType<typeof admitted.value.receipt.settle>>
    try {
      settled = await admitted.value.receipt.settle()
    } catch {
      return this.stopUnknown(command, 'stop-settlement-unavailable')
    }
    if (!settled.durable || settled.inspection.kind !== 'stopped') {
      return this.stopUnknown(
        command,
        settled.inspection.kind === 'conflict' ? 'stop-terminal-conflict' : 'stop-settlement-unavailable',
      )
    }
    try {
      await this.control.commitCommand(row.commandId, row.requestFingerprint, {
        targetTurn: command.expectedActivityRevision,
        turnEndSeq: settled.inspection.turnEndSeq,
      })
    } catch (error: unknown) {
      this.logger.warn(`remote-command: durable Stop terminal committed but journal repair is pending: ${String(error)}`)
    }
    return Object.freeze({
      outcome: 'stopped',
      commandId: command.commandId,
      expectedActivityRevision: command.expectedActivityRevision,
      replayed: false,
      currentRunning: settled.currentRunning,
    })
  }

  private async replayStopped(
    command: RemoteStopCommand,
    row: RemoteCommandCommitted,
  ): Promise<RemoteStopTerminal> {
    if (!('turnEndSeq' in row.commit) || row.commit.targetTurn !== command.expectedActivityRevision) {
      return this.stopUnknown(command, 'committed-fact-unavailable', true)
    }
    const inspection = await this.inspectStopped({
      sessionId: command.sessionId,
      turn: command.expectedActivityRevision,
    })
    if (inspection.kind !== 'stopped' || inspection.turnEndSeq !== row.commit.turnEndSeq) {
      return this.stopUnknown(command, 'committed-fact-unavailable', true)
    }
    return stopTerminalFromRow(row, command.expectedActivityRevision, true)
  }

  private async repairStopCommit(
    command: RemoteStopCommand,
    row: RemoteCommandRequested,
    inspection: Extract<HostStopInspection, { kind: 'stopped' }>,
  ): Promise<RemoteStopTerminal> {
    try {
      await this.control.commitCommand(row.commandId, row.requestFingerprint, {
        targetTurn: command.expectedActivityRevision,
        turnEndSeq: inspection.turnEndSeq,
      })
      return Object.freeze({
        outcome: 'stopped', commandId: command.commandId,
        expectedActivityRevision: command.expectedActivityRevision, replayed: true,
      })
    } catch {
      return this.stopUnknown(command, 'journal-unavailable', true)
    }
  }

  private async inspectStopped(
    target: { readonly sessionId: RemoteStopCommand['sessionId']; readonly turn: number },
  ): Promise<HostStopInspection> {
    try {
      return await this.stops.inspect(target)
    } catch {
      return { kind: 'conflict' }
    }
  }

  private async rejectStop(
    row: RemoteCommandReserved,
    command: RemoteStopCommand,
    errorCode: string,
  ): Promise<RemoteStopTerminal> {
    try {
      const rejected = await this.control.rejectCommand(
        row.commandId, row.requestFingerprint, { code: errorCode },
      )
      return stopTerminalFromRow(rejected, command.expectedActivityRevision, false)
    } catch {
      return this.stopUnknown(command, 'journal-unavailable')
    }
  }

  private async reject(row: RemoteCommandReserved, errorCode: string): Promise<RemoteCommandTerminal> {
    try {
      const rejected = await this.control.rejectCommand(
        row.commandId, row.requestFingerprint, { code: errorCode },
      )
      return terminalFromRow(rejected, false)
    } catch {
      return this.unknown({ commandId: row.commandId }, 'journal-unavailable')
    }
  }

  private async authorizedAdmission<T>(
    command: { readonly control: RemoteCommandControlProof },
    authority: RemoteCommandAuthority,
    effect: () => T,
  ): Promise<
    | { readonly kind: 'admitted'; readonly value: T }
    | { readonly kind: 'refused'; readonly errorCode: string }
    | { readonly kind: 'threw' }
  > {
    try {
      const result = await this.control.admit(command.control, () => { authority.authorize() }, effect)
      return result.ok
        ? { kind: 'admitted', value: result.value }
        : { kind: 'refused', errorCode: `control-${result.reason}` }
    } catch {
      return { kind: 'threw' }
    }
  }

  private notifyReceived(
    callback: ((receipt: RemoteCommandReceived) => void) | undefined,
    receipt: RemoteCommandReceived,
  ): void {
    if (callback === undefined) return
    try {
      callback(Object.freeze({ ...receipt }))
    } catch (error: unknown) {
      this.logger.warn(`remote-command: received receipt delivery failed after durable reservation: ${String(error)}`)
    }
  }

  private notifyStopRequested(
    callback: ((receipt: RemoteStopRequestedReceipt) => void) | undefined,
    command: RemoteStopCommand,
    replayed: boolean,
  ): void {
    if (callback === undefined) return
    try {
      callback(Object.freeze({
        outcome: 'requested',
        commandId: command.commandId,
        expectedActivityRevision: command.expectedActivityRevision,
        replayed,
      }))
    } catch (error: unknown) {
      this.logger.warn(`remote-command: Stop requested delivery failed after durable state: ${String(error)}`)
    }
  }

  private async awaitStop(
    operation: Promise<RemoteStopTerminal>,
    command: RemoteStopCommand,
    replayed: boolean,
  ): Promise<RemoteStopTerminal> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<RemoteStopTerminal>((resolve) => {
      timer = setTimeout(() => {
        resolve(this.stopUnknown(command, 'stop-settlement-timeout', replayed))
      }, this.stopSettlementTimeoutMs)
    })
    try {
      const result = await Promise.race([operation, timeout])
      return Object.freeze({ ...result, replayed: result.replayed || replayed })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private withReplay(result: RemoteCommandTerminal, replayed: boolean): RemoteCommandTerminal {
    return Object.freeze({ ...result, replayed })
  }

  private unknown(
    command: Pick<RemoteSendInputCommand, 'commandId'>,
    errorCode: string,
    replayed = false,
  ): RemoteCommandTerminal {
    return Object.freeze({ outcome: 'unknown', commandId: command.commandId, replayed, errorCode })
  }

  private stopRejected(
    command: RemoteStopCommand,
    errorCode: string,
    replayed = false,
  ): RemoteStopTerminal {
    return Object.freeze({
      outcome: 'rejected', commandId: command.commandId,
      expectedActivityRevision: command.expectedActivityRevision, replayed, errorCode,
    })
  }

  private stopUnknown(
    command: RemoteStopCommand,
    errorCode: string,
    replayed = false,
  ): RemoteStopTerminal {
    return Object.freeze({
      outcome: 'unknown', commandId: command.commandId,
      expectedActivityRevision: command.expectedActivityRevision, replayed, errorCode,
    })
  }
}
