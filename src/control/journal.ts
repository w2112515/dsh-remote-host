/** Host-global durable command journal implementation. */

import { createHash, randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  remoteCommandBindingSchema,
  remoteCommandCommitSchema,
  remoteCommandJournalSpec,
  remoteCommandRejectionSchema,
  remoteCommandRowSchema,
} from './spec.ts'
import type {
  RemoteCommandBinding,
  RemoteCommandCommit,
  RemoteCommandCommitted,
  RemoteCommandId,
  RemoteCommandRejected,
  RemoteCommandRequested,
  RemoteCommandRejection,
  RemoteCommandReservation,
  RemoteCommandReserved,
  RemoteCommandRow,
  RemoteStopRequested,
} from './types.ts'

/**
 * Hash an explicit canonical command tuple; arbitrary object serialization is
 * deliberately excluded from this identity boundary.
 * @param input - semantic command fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
export function fingerprintRemoteSendInput(input: {
  readonly sessionId: SessionId
  readonly text: string
  readonly deviceId: string
  readonly authorityEpoch: string
  readonly controlEpoch: string
  /**
   * Committed upload ids attached to the input (S-blob); each id is one
   * canonical field, so identical text with different images never replays.
   */
  readonly attachmentIds?: readonly string[]
}): string {
  const fields = [
    'remote-command-v1', 'send_input', input.sessionId, input.text,
    input.deviceId, input.authorityEpoch, input.controlEpoch,
    ...input.attachmentIds ?? [],
  ]
  const hash = createHash('sha256')
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8')
    hash.update(String(bytes.byteLength)).update(':').update(bytes).update(';')
  }
  return hash.digest('hex')
}

/**
 * Hash the exact Stop target and authenticated fences.
 * @param input - semantic Stop fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
export function fingerprintRemoteStop(input: {
  readonly sessionId: SessionId
  readonly targetTurn: number
  readonly deviceId: string
  readonly authorityEpoch: string
  readonly controlEpoch: string
}): string {
  const fields = [
    'remote-command-v1', 'stop', input.sessionId, String(input.targetTurn),
    input.deviceId, input.authorityEpoch, input.controlEpoch,
  ]
  const hash = createHash('sha256')
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8')
    hash.update(String(bytes.byteLength)).update(':').update(bytes).update(';')
  }
  return hash.digest('hex')
}

/**
 * Hash one exact pending approval revision and authenticated decision-maker.
 * @param input - Exact approval identity, outcome and authenticated authority binding.
 * @returns Canonical SHA-256 request fingerprint.
 */
export function fingerprintRemoteApprovalDecision(input: {
  readonly sessionId: SessionId
  readonly approvalId: string
  readonly approvalRevision: string
  readonly outcome: 'allowed-once' | 'rejected'
  readonly deviceId: string
  readonly authorityEpoch: string
  /**
   * S-policy third decision: the settlement stays `allowed-once`, but the
   * same-kind rule mint is part of the command's semantics, so it joins the
   * identity boundary — a retried command_id flipping this intent conflicts.
   */
  readonly grantSameKind?: boolean
}): string {
  const fields = [
    'remote-command-v1', 'decide_approval', input.sessionId, input.approvalId,
    input.approvalRevision, input.outcome, input.deviceId, input.authorityEpoch,
    ...(input.grantSameKind === true ? ['grant-same-kind'] : []),
  ]
  const hash = createHash('sha256')
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8')
    hash.update(String(bytes.byteLength)).update(':').update(bytes).update(';')
  }
  return hash.digest('hex')
}

/**
 * Hash one caller-preallocated Session creation (S-mode-select). Creation is
 * naturally idempotent at the owner (same id returns the same session); the
 * fingerprint still pins the authenticated semantics so a reused command_id
 * with different intent conflicts instead of silently replaying.
 * @param input - semantic create fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
export function fingerprintRemoteCreateSession(input: {
  readonly sessionId: SessionId
  readonly agentPreset?: string | undefined
  readonly workspaceId?: string | undefined
  readonly newWorkspaceName?: string | undefined
  readonly deviceId: string
  readonly authorityEpoch: string
}): string {
  const fields = [
    'remote-command-v1', 'create_session', input.sessionId, input.agentPreset ?? '',
    input.workspaceId ?? '', input.newWorkspaceName ?? '',
    input.deviceId, input.authorityEpoch,
  ]
  const hash = createHash('sha256')
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8')
    hash.update(String(bytes.byteLength)).update(':').update(bytes).update(';')
  }
  return hash.digest('hex')
}

/**
 * Hash one exact blank-session preset selection (S-mode-select).
 * @param input - semantic select fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
export function fingerprintRemoteSelectAgentPreset(input: {
  readonly sessionId: SessionId
  readonly agentPreset: string
  readonly deviceId: string
  readonly authorityEpoch: string
}): string {
  const fields = [
    'remote-command-v1', 'select_agent_preset', input.sessionId, input.agentPreset,
    input.deviceId, input.authorityEpoch,
  ]
  const hash = createHash('sha256')
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8')
    hash.update(String(bytes.byteLength)).update(':').update(bytes).update(';')
  }
  return hash.digest('hex')
}

/**
 * Hash one exact model selection (S-session-admin). The selection is
 * set-valued at the owner (re-selecting the same triple converges), and the
 * presented control epoch pins the fence it was admitted under.
 * @param input - semantic select fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
export function fingerprintRemoteSelectModel(input: {
  readonly sessionId: SessionId
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
  readonly deviceId: string
  readonly authorityEpoch: string
  readonly controlEpoch: string
}): string {
  const fields = [
    'remote-command-v1', 'select_model', input.sessionId, input.provider, input.model,
    input.reasoningEffort ?? '', input.deviceId, input.authorityEpoch, input.controlEpoch,
  ]
  const hash = createHash('sha256')
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8')
    hash.update(String(bytes.byteLength)).update(':').update(bytes).update(';')
  }
  return hash.digest('hex')
}

/**
 * Hash one caller-preallocated Session fork (S-session-admin). The owner
 * converges a retry to the same child, so the fingerprint pins exactly the
 * source, child id, anchor, and authenticated authority.
 * @param input - semantic fork fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
export function fingerprintRemoteForkSession(input: {
  readonly sessionId: SessionId
  readonly childSessionId: SessionId
  readonly atSeq?: number | undefined
  readonly deviceId: string
  readonly authorityEpoch: string
}): string {
  const fields = [
    'remote-command-v1', 'fork_session', input.sessionId, input.childSessionId,
    input.atSeq === undefined ? '' : String(input.atSeq), input.deviceId, input.authorityEpoch,
  ]
  const hash = createHash('sha256')
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8')
    hash.update(String(bytes.byteLength)).update(':').update(bytes).update(';')
  }
  return hash.digest('hex')
}

/**
 * Hash one exact rule revocation (S-policy). Revocation is set-valued at the
 * owner (the rule is gone either way), so the fingerprint pins the exact rule
 * and authenticated authority.
 * @param input - semantic revoke fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
export function fingerprintRemoteRevokeApprovalRule(input: {
  readonly sessionId: SessionId
  readonly ruleId: string
  readonly deviceId: string
  readonly authorityEpoch: string
}): string {
  const fields = [
    'remote-command-v1', 'revoke_approval_rule', input.sessionId, input.ruleId,
    input.deviceId, input.authorityEpoch,
  ]
  const hash = createHash('sha256')
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8')
    hash.update(String(bytes.byteLength)).update(':').update(bytes).update(';')
  }
  return hash.digest('hex')
}

/**
 * Hash one exact session budget ceiling (S-policy). The budget fold is
 * last-wins at the owner, so re-setting the same ceiling converges.
 * @param input - semantic budget fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
export function fingerprintRemoteSetSessionBudget(input: {
  readonly sessionId: SessionId
  readonly maxTotalTokens: number
  readonly deviceId: string
  readonly authorityEpoch: string
}): string {
  const fields = [
    'remote-command-v1', 'set_session_budget', input.sessionId, String(input.maxTotalTokens),
    input.deviceId, input.authorityEpoch,
  ]
  const hash = createHash('sha256')
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8')
    hash.update(String(bytes.byteLength)).update(':').update(bytes).update(';')
  }
  return hash.digest('hex')
}

function sameBinding(row: RemoteCommandRow, binding: RemoteCommandBinding): boolean {
  return row.commandId === binding.commandId
    && row.operation === binding.operation
    && row.sessionId === binding.sessionId
    && row.requestFingerprint === binding.requestFingerprint
    && row.deviceId === binding.deviceId
    && row.authorityEpoch === binding.authorityEpoch
    && row.controlEpoch === binding.controlEpoch
    && row.targetTurn === binding.targetTurn
    && row.approvalId === binding.approvalId
    && row.approvalRevision === binding.approvalRevision
    && row.approvalOutcome === binding.approvalOutcome
    && row.agentPreset === binding.agentPreset
    && row.forkAtSeq === binding.forkAtSeq
    && row.childSessionId === binding.childSessionId
    && row.ruleId === binding.ruleId
    && row.maxTotalTokens === binding.maxTotalTokens
    && sameModelSelection(row.modelSelection, binding.modelSelection)
}

function sameModelSelection(
  left: RemoteCommandBinding['modelSelection'],
  right: RemoteCommandBinding['modelSelection'],
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

function sameCommit(left: RemoteCommandCommit, right: RemoteCommandCommit): boolean {
  if ('turnEndSeq' in left) {
    return 'turnEndSeq' in right
      && left.targetTurn === right.targetTurn
      && left.turnEndSeq === right.turnEndSeq
  }
  if ('decidedEventSeq' in left) {
    return 'decidedEventSeq' in right
      && left.approvalId === right.approvalId
      && left.outcome === right.outcome
      && left.decidedEventSeq === right.decidedEventSeq
  }
  if ('created' in left) {
    return 'created' in right && left.agentPreset === right.agentPreset
  }
  if ('selectedPreset' in left) {
    return 'selectedPreset' in right && left.selectedPreset === right.selectedPreset
  }
  if ('selectedModel' in left) {
    return 'selectedModel' in right
      && left.selectedModel.provider === right.selectedModel.provider
      && left.selectedModel.model === right.selectedModel.model
      && left.selectedModel.reasoningEffort === right.selectedModel.reasoningEffort
  }
  if ('forked' in left) {
    return 'forked' in right && left.childSessionId === right.childSessionId
  }
  if ('revokedRuleId' in left) {
    return 'revokedRuleId' in right && left.revokedRuleId === right.revokedRuleId
  }
  if ('budgetSet' in left) {
    return 'budgetSet' in right && left.maxTotalTokens === right.maxTotalTokens
  }
  return !('turnEndSeq' in right) && !('decidedEventSeq' in right)
    && !('created' in right) && !('selectedPreset' in right)
    && !('selectedModel' in right) && !('forked' in right)
    && !('revokedRuleId' in right) && !('budgetSet' in right)
    && left.sessionEventSeq === right.sessionEventSeq
    && left.messageId === right.messageId
}

function snapshotRow(row: RemoteCommandRow): RemoteCommandRow {
  const base = {
    commandId: row.commandId,
    operation: row.operation,
    sessionId: row.sessionId,
    requestFingerprint: row.requestFingerprint,
    deviceId: row.deviceId,
    authorityEpoch: row.authorityEpoch,
    ...(row.controlEpoch === undefined ? {} : { controlEpoch: row.controlEpoch }),
    ...(row.targetTurn === undefined ? {} : { targetTurn: row.targetTurn }),
    ...(row.approvalId === undefined ? {} : { approvalId: row.approvalId }),
    ...(row.approvalRevision === undefined ? {} : { approvalRevision: row.approvalRevision }),
    ...(row.approvalOutcome === undefined ? {} : { approvalOutcome: row.approvalOutcome }),
    ...(row.agentPreset === undefined ? {} : { agentPreset: row.agentPreset }),
    ...(row.modelSelection === undefined ? {} : {
      modelSelection: Object.freeze({
        provider: row.modelSelection.provider,
        model: row.modelSelection.model,
        ...(row.modelSelection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: row.modelSelection.reasoningEffort }),
      }),
    }),
    ...(row.childSessionId === undefined ? {} : { childSessionId: row.childSessionId }),
    ...(row.forkAtSeq === undefined ? {} : { forkAtSeq: row.forkAtSeq }),
    ...(row.ruleId === undefined ? {} : { ruleId: row.ruleId }),
    ...(row.maxTotalTokens === undefined ? {} : { maxTotalTokens: row.maxTotalTokens }),
    correlation: row.correlation,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  } as const
  if (row.phase === 'reserved') return Object.freeze({ ...base, phase: 'reserved', revision: 0 })
  if (row.phase === 'requested') {
    return Object.freeze({
      ...base,
      phase: 'requested',
      revision: 1,
      requested: Object.freeze({ targetTurn: row.requested.targetTurn }),
    })
  }
  if (row.phase === 'committed') {
    const commit = 'turnEndSeq' in row.commit
      ? Object.freeze({ targetTurn: row.commit.targetTurn, turnEndSeq: row.commit.turnEndSeq })
      : 'decidedEventSeq' in row.commit
        ? Object.freeze({
          approvalId: row.commit.approvalId,
          outcome: row.commit.outcome,
          decidedEventSeq: row.commit.decidedEventSeq,
        })
        : 'created' in row.commit
          ? Object.freeze({
            created: true as const,
            ...(row.commit.agentPreset === undefined ? {} : { agentPreset: row.commit.agentPreset }),
          })
          : 'selectedPreset' in row.commit
            ? Object.freeze({ selectedPreset: row.commit.selectedPreset })
            : 'selectedModel' in row.commit
              ? Object.freeze({
                selectedModel: Object.freeze({
                  provider: row.commit.selectedModel.provider,
                  model: row.commit.selectedModel.model,
                  ...(row.commit.selectedModel.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: row.commit.selectedModel.reasoningEffort }),
                }),
              })
              : 'forked' in row.commit
                ? Object.freeze({ forked: true as const, childSessionId: row.commit.childSessionId })
                : 'revokedRuleId' in row.commit
                  ? Object.freeze({ revokedRuleId: row.commit.revokedRuleId })
                  : 'budgetSet' in row.commit
                    ? Object.freeze({ budgetSet: true as const, maxTotalTokens: row.commit.maxTotalTokens })
                    : Object.freeze({ sessionEventSeq: row.commit.sessionEventSeq, messageId: row.commit.messageId })
    return Object.freeze({
      ...base,
      phase: 'committed',
      revision: row.revision,
      commit,
    })
  }
  return Object.freeze({
    ...base,
    phase: 'rejected',
    revision: 1,
    rejection: Object.freeze({ code: row.rejection.code }),
  })
}

/** Package-private journal owner used by the Remote control service. */
export class RemoteCommandJournal {
  private readonly table: KvTable<RemoteCommandId, RemoteCommandRow>
  private readonly operationTails = new Map<RemoteCommandId, Promise<void>>()
  private admissionOpen = true

  /**
   * @param domain - already-open authoritative command domain.
   * @param now - monotonic-enough wall clock for audit timestamps.
   * @param correlation - opaque correlation factory.
   */
  constructor(
    private readonly domain: Domain<typeof remoteCommandJournalSpec>,
    private readonly now: () => number = Date.now,
    private readonly correlation: () => string = randomUUID,
  ) {
    this.table = domain.table('commands')
    for (const [key, row] of this.table.entries()) {
      if (key !== row.commandId) {
        throw new Error(`remote command journal key '${key}' does not match stored commandId '${row.commandId}'`)
      }
    }
  }

  /**
   * Durably reserve a globally unique command before any business effect.
   * @param rawBinding - authenticated semantic identity.
   * @returns created, pending, terminal replay, or conflict.
   */
  reserve(rawBinding: RemoteCommandBinding): Promise<RemoteCommandReservation> {
    const binding = remoteCommandBindingSchema.parse(rawBinding) as RemoteCommandBinding
    return this.enqueue(binding.commandId, async () => {
      const current = this.table.get(binding.commandId)
      if (current !== undefined) {
        if (!sameBinding(current, binding)) return Object.freeze({ kind: 'conflict' })
        const row = snapshotRow(current)
        return row.phase === 'reserved' || row.phase === 'requested'
          ? Object.freeze({ kind: 'pending', row })
          : Object.freeze({ kind: 'replay', row })
      }
      const now = this.checkedNow()
      const row = remoteCommandRowSchema.parse({
        ...binding,
        correlation: this.correlation(),
        phase: 'reserved',
        revision: 0,
        createdAtMs: now,
        updatedAtMs: now,
      }) as RemoteCommandReserved
      await this.table.put(binding.commandId, row)
      return Object.freeze({ kind: 'created', row: snapshotRow(row) as RemoteCommandReserved })
    })
  }

  /**
   * Read after earlier work on the same ID has settled.
   * @param commandId - Host-global identity.
   * @returns immutable row snapshot or absence.
   */
  lookup(commandId: RemoteCommandId): Promise<RemoteCommandRow | undefined> {
    return this.enqueue(commandId, () => {
      const row = this.table.get(commandId)
      return Promise.resolve(row === undefined ? undefined : snapshotRow(row))
    })
  }

  /**
   * Persist that one exact Stop reached the synchronous Agent cancellation owner.
   * @param commandId - reserved Host-global identity.
   * @param expectedFingerprint - fingerprint captured at reservation.
   * @param rawRequested - exact turn passed to the Agent owner.
   * @returns immutable non-terminal requested row.
   */
  markRequested(
    commandId: RemoteCommandId,
    expectedFingerprint: string,
    rawRequested: RemoteStopRequested,
  ): Promise<RemoteCommandRequested> {
    const requested = { targetTurn: rawRequested.targetTurn }
    return this.enqueue(commandId, async () => {
      const current = this.requireBound(commandId, expectedFingerprint)
      if (current.operation !== 'stop' || current.targetTurn !== requested.targetTurn) {
        throw new Error(`remote command '${commandId}' is not the requested Stop target`)
      }
      if (current.phase === 'committed' || current.phase === 'rejected') {
        throw new Error(`remote command '${commandId}' is already terminal`)
      }
      if (current.phase === 'requested') return snapshotRow(current) as RemoteCommandRequested
      const next = await this.table.update(commandId, (observed) => {
        if (observed.phase !== 'reserved' || observed.requestFingerprint !== expectedFingerprint) {
          throw new Error(`remote command '${commandId}' changed before Stop request`)
        }
        return remoteCommandRowSchema.parse({
          ...observed,
          phase: 'requested',
          revision: 1,
          updatedAtMs: Math.max(this.checkedNow(), observed.updatedAtMs),
          requested,
        })
      })
      return snapshotRow(next) as RemoteCommandRequested
    })
  }

  /**
   * Index one durable Session fact; repeating the exact terminal fact is safe.
   * @param commandId - reserved Host-global identity.
   * @param expectedFingerprint - fingerprint captured at reservation.
   * @param rawCommit - physically durable Session correlation.
   * @returns immutable committed row.
   */
  commit(
    commandId: RemoteCommandId,
    expectedFingerprint: string,
    rawCommit: RemoteCommandCommit,
  ): Promise<RemoteCommandCommitted> {
    const commit = remoteCommandCommitSchema.parse(rawCommit)
    return this.enqueue(commandId, async () => {
      const current = this.requireBound(commandId, expectedFingerprint)
      if (current.phase === 'rejected') throw new Error(`remote command '${commandId}' is already rejected`)
      if (current.phase === 'committed') {
        if (!sameCommit(current.commit, commit)) {
          throw new Error(`remote command '${commandId}' commit correlation changed`)
        }
        return snapshotRow(current) as RemoteCommandCommitted
      }
      const next = await this.table.update(commandId, (observed) => {
        const expectedPhase = observed.operation === 'stop' ? 'requested' : 'reserved'
        if (observed.phase !== expectedPhase || observed.requestFingerprint !== expectedFingerprint) {
          throw new Error(`remote command '${commandId}' changed before commit`)
        }
        return remoteCommandRowSchema.parse({
          ...observed,
          phase: 'committed',
          revision: observed.operation === 'stop' ? 2 : 1,
          updatedAtMs: Math.max(this.checkedNow(), observed.updatedAtMs),
          commit,
        })
      })
      return snapshotRow(next) as RemoteCommandCommitted
    })
  }

  /**
   * Store one definitive pre-effect rejection; repeating the same code is safe.
   * @param commandId - reserved Host-global identity.
   * @param expectedFingerprint - fingerprint captured at reservation.
   * @param rawRejection - stable machine-readable rejection.
   * @returns immutable rejected row.
   */
  reject(
    commandId: RemoteCommandId,
    expectedFingerprint: string,
    rawRejection: RemoteCommandRejection,
  ): Promise<RemoteCommandRejected> {
    const rejection = remoteCommandRejectionSchema.parse(rawRejection)
    return this.enqueue(commandId, async () => {
      const current = this.requireBound(commandId, expectedFingerprint)
      if (current.phase === 'committed') throw new Error(`remote command '${commandId}' is already committed`)
      if (current.phase === 'requested') throw new Error(`remote command '${commandId}' already crossed the effect boundary`)
      if (current.phase === 'rejected') {
        if (current.rejection.code !== rejection.code) {
          throw new Error(`remote command '${commandId}' rejection changed`)
        }
        return snapshotRow(current) as RemoteCommandRejected
      }
      const next = await this.table.update(commandId, (observed) => {
        if (observed.phase !== 'reserved' || observed.requestFingerprint !== expectedFingerprint) {
          throw new Error(`remote command '${commandId}' changed before rejection`)
        }
        return remoteCommandRowSchema.parse({
          ...observed,
          phase: 'rejected',
          revision: 1,
          updatedAtMs: Math.max(this.checkedNow(), observed.updatedAtMs),
          rejection,
        })
      })
      return snapshotRow(next) as RemoteCommandRejected
    })
  }

  /** Stop admission and drain all per-ID operations. */
  async close(): Promise<void> {
    this.admissionOpen = false
    await Promise.all(this.operationTails.values())
    await this.domain.close()
  }

  private requireBound(commandId: RemoteCommandId, fingerprint: string): RemoteCommandRow {
    const row = this.table.get(commandId)
    if (row === undefined) throw new Error(`remote command '${commandId}' is not reserved`)
    if (row.commandId !== commandId || row.requestFingerprint !== fingerprint) {
      throw new Error(`remote command '${commandId}' binding mismatch`)
    }
    return row
  }

  private checkedNow(): number {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error(`remote command journal clock is invalid: ${String(now)}`)
    return now
  }

  private enqueue<T>(commandId: RemoteCommandId, operation: () => Promise<T>): Promise<T> {
    if (!this.admissionOpen) return Promise.reject(new Error('remote command journal is disposing'))
    const previous = this.operationTails.get(commandId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.operationTails.set(commandId, tail)
    return result.finally(() => {
      if (this.operationTails.get(commandId) === tail) this.operationTails.delete(commandId)
    })
  }
}
