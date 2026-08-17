/** Public contracts for durable Remote command ownership and control fencing. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Host-global caller idempotency key. */
export type RemoteCommandId = Branded<'RemoteCommandId'>
/** Stable authorization subject minted by the Host security authority. */
export type RemoteDeviceId = Branded<'RemoteDeviceId'>
/** Monotonic per-Session control epoch encoded as canonical uint64 decimal. */
export type RemoteControlEpoch = Branded<'RemoteControlEpoch'>
/** Opaque random lease secret returned only to the authenticated holder. */
export type RemoteControlToken = Branded<'RemoteControlToken'>
/** Opaque command-to-Session correlation stored inside the admitted user message. */
export type RemoteCommandCorrelation = Branded<'RemoteCommandCorrelation'>

/** Stable binding reserved before an effect can begin. */
export interface RemoteCommandBinding {
  readonly commandId: RemoteCommandId
  readonly operation: 'send_input' | 'stop' | 'decide_approval' | 'create_session' | 'select_agent_preset'
    | 'select_model' | 'fork_session' | 'revoke_approval_rule' | 'set_session_budget'
  readonly sessionId: SessionId
  readonly requestFingerprint: string
  readonly deviceId: RemoteDeviceId
  readonly authorityEpoch: string
  readonly controlEpoch?: RemoteControlEpoch
  /** Exact Host-issued active turn for Stop; absent for SendInput. */
  readonly targetTurn?: number
  /** Exact ApprovalService identity for a mobile decision. */
  readonly approvalId?: string
  /** Opaque same-process pending incarnation. */
  readonly approvalRevision?: string
  /** Closed mobile-decidable outcome. */
  readonly approvalOutcome?: 'allowed-once' | 'rejected'
  /**
   * Agent preset id bound at reservation (S-mode-select): required for
   * select_agent_preset, optional for create_session (default applies).
   */
  readonly agentPreset?: string
  /** Exact provider/model/effort triple bound at reservation (S-session-admin select_model). */
  readonly modelSelection?: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string | undefined
  }
  /** Caller-preallocated fork child id (S-session-admin fork_session). */
  readonly childSessionId?: SessionId
  /** Optional fork cut anchor (S-session-admin fork_session). */
  readonly forkAtSeq?: number
  /** Exact active-rule identity bound at reservation (S-policy revoke_approval_rule). */
  readonly ruleId?: string
  /** Token ceiling bound at reservation (S-policy set_session_budget). */
  readonly maxTotalTokens?: number
}

/** Durable correlation pointing at the committed Inbox splice. */
export interface RemoteSendInputCommit {
  readonly sessionEventSeq: number
  readonly messageId: string
}

/** Durable correlation pointing at the exact stopped turn terminal. */
export interface RemoteStopCommit {
  readonly targetTurn: number
  readonly turnEndSeq: number
}

/** Durable correlation pointing at the exact ApprovalService audit terminal. */
export interface RemoteApprovalDecisionCommit {
  readonly approvalId: string
  readonly outcome: 'allowed-once' | 'rejected'
  readonly decidedEventSeq: number
}

/**
 * Durable fact that the caller-preallocated Session exists (S-mode-select).
 * The session id is already the binding's sessionId; the resolved preset is
 * recorded when the deployment composes presets.
 */
export interface RemoteCreateSessionCommit {
  readonly created: true
  readonly agentPreset?: string | undefined
}

/** Durable fact that one blank Session's agent was recomposed (S-mode-select). */
export interface RemoteSelectAgentPresetCommit {
  readonly selectedPreset: string
}

/** Durable fact that a Session's next-step model selection was replaced (S-session-admin). */
export interface RemoteSelectModelCommit {
  readonly selectedModel: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string | undefined
  }
}

/** Durable fact that the caller-preallocated fork child exists (S-session-admin). */
export interface RemoteForkSessionCommit {
  readonly forked: true
  readonly childSessionId: SessionId
}

/** Durable fact that one exact rule's revocation event crossed the session log (S-policy). */
export interface RemoteRevokeApprovalRuleCommit {
  readonly revokedRuleId: string
}

/** Durable fact that the session budget event crossed the session log (S-policy). */
export interface RemoteSetSessionBudgetCommit {
  readonly budgetSet: true
  readonly maxTotalTokens: number
}

/** Operation-specific durable Session fact. */
export type RemoteCommandCommit =
  | RemoteSendInputCommit
  | RemoteStopCommit
  | RemoteApprovalDecisionCommit
  | RemoteCreateSessionCommit
  | RemoteSelectAgentPresetCommit
  | RemoteSelectModelCommit
  | RemoteForkSessionCommit
  | RemoteRevokeApprovalRuleCommit
  | RemoteSetSessionBudgetCommit

/** Durable proof that the exact Stop effect was requested from the Agent owner. */
export interface RemoteStopRequested {
  readonly targetTurn: number
}

/** Stable rejection stored without deployment-varying prose. */
export interface RemoteCommandRejection {
  readonly code: string
}

interface RemoteCommandBase extends RemoteCommandBinding {
  readonly correlation: RemoteCommandCorrelation
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

/** Durable reservation with no authoritative terminal fact yet. */
export interface RemoteCommandReserved extends RemoteCommandBase {
  readonly phase: 'reserved'
  readonly revision: 0
}

/** Durable Stop-requested state; it is non-terminal and may still reconcile to UNKNOWN. */
export interface RemoteCommandRequested extends RemoteCommandBase {
  readonly phase: 'requested'
  readonly revision: 1
  readonly requested: RemoteStopRequested
}

/** Journal index pointing at a durable correlated Session fact. */
export interface RemoteCommandCommitted extends RemoteCommandBase {
  readonly phase: 'committed'
  readonly revision: 1 | 2
  readonly commit: RemoteCommandCommit
}

/** Durable definitive rejection made before any effect. */
export interface RemoteCommandRejected extends RemoteCommandBase {
  readonly phase: 'rejected'
  readonly revision: 1
  readonly rejection: RemoteCommandRejection
}

/** Closed durable journal vocabulary; UNKNOWN is intentionally absent. */
export type RemoteCommandRow =
  | RemoteCommandReserved
  | RemoteCommandRequested
  | RemoteCommandCommitted
  | RemoteCommandRejected

/** Reservation result for first admission, live join, replay, or ID conflict. */
export type RemoteCommandReservation =
  | { readonly kind: 'created'; readonly row: RemoteCommandReserved }
  | { readonly kind: 'pending'; readonly row: RemoteCommandReserved | RemoteCommandRequested }
  | { readonly kind: 'replay'; readonly row: RemoteCommandCommitted | RemoteCommandRejected }
  | { readonly kind: 'conflict' }

/** Server-verifiable proof presented by an authenticated controller. */
export interface RemoteControlProof {
  readonly sessionId: SessionId
  readonly holderDeviceId: RemoteDeviceId
  readonly epoch: RemoteControlEpoch
  readonly token: RemoteControlToken
}

/** Opaque lease value returned only to its authenticated holder. */
export interface RemoteControlLease extends RemoteControlProof {
  readonly expiresAtMs: number
}

/** Stable negative fence results; none can reach the effect callback. */
export type RemoteControlFailure = 'held-by-other' | 'unheld' | 'expired' | 'stale-fence'

/** Result of acquiring, renewing, or transferring control. */
export type RemoteControlLeaseResult =
  | { readonly ok: true; readonly lease: RemoteControlLease }
  | { readonly ok: false; readonly reason: RemoteControlFailure }

/** Result of a fenced synchronous admission. */
export type RemoteControlAdmissionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: RemoteControlFailure }

/** Host-side service shared by send, stop, and policy-approved interactions. */
export interface RemoteControlService {
  /**
   * Reserve one Host-global caller id before effect admission.
   * @param binding - complete authenticated semantic binding.
   * @returns created, pending, replay, or conflict.
   */
  reserveCommand(binding: RemoteCommandBinding): Promise<RemoteCommandReservation>
  /**
   * Read one durable command outcome index.
   * @param commandId - Host-global caller identity.
   * @returns current immutable row or absence.
   */
  lookupCommand(commandId: RemoteCommandId): Promise<RemoteCommandRow | undefined>
  /**
   * Persist that an exact Stop reached the Agent cancellation owner.
   * @param commandId - reserved caller identity.
   * @param expectedFingerprint - exact reservation fingerprint.
   * @param requested - exact turn passed to the owner.
   * @returns non-terminal requested row.
   */
  markCommandRequested(
    commandId: RemoteCommandId,
    expectedFingerprint: string,
    requested: RemoteStopRequested,
  ): Promise<RemoteCommandRequested>
  /**
   * Index an already durable correlated Session fact.
   * @param commandId - reserved caller identity.
   * @param expectedFingerprint - exact reservation fingerprint.
   * @param commit - Session event/message correlation.
   * @returns committed journal row.
   */
  commitCommand(
    commandId: RemoteCommandId,
    expectedFingerprint: string,
    commit: RemoteCommandCommit,
  ): Promise<RemoteCommandCommitted>
  /**
   * Persist one definitive pre-effect rejection.
   * @param commandId - reserved caller identity.
   * @param expectedFingerprint - exact reservation fingerprint.
   * @param rejection - stable machine code.
   * @returns rejected journal row.
   */
  rejectCommand(
    commandId: RemoteCommandId,
    expectedFingerprint: string,
    rejection: RemoteCommandRejection,
  ): Promise<RemoteCommandRejected>
  /**
   * Acquire an unheld or expired Session, or recover the exact live lease when
   * the same authenticated holder lost its prior response.
   * @param sessionId - ordinary Session identity.
   * @param deviceId - authenticated stable device identity.
   * @returns new lease or held conflict.
   */
  acquireControl(sessionId: SessionId, deviceId: RemoteDeviceId): Promise<RemoteControlLeaseResult>
  /**
   * Extend one exact unexpired lease without changing its fence.
   * @param lease - exact current holder token.
   * @returns renewed lease or stable fence failure.
   */
  renewControl(lease: RemoteControlProof): Promise<RemoteControlLeaseResult>
  /**
   * Bump the fence and hand control to another device.
   * @param lease - exact current holder token.
   * @param nextDeviceId - authenticated next holder.
   * @returns next lease or stable fence failure.
   */
  transferControl(lease: RemoteControlProof, nextDeviceId: RemoteDeviceId): Promise<RemoteControlLeaseResult>
  /**
   * Release one exact current lease.
   * @param lease - exact current holder token.
   * @returns released postcondition or stable fence failure.
   */
  releaseControl(lease: RemoteControlProof): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: RemoteControlFailure }>
  /**
   * Bump and clear every live lease held by one invalidated device.
   * @param deviceId - revoked or reprofiled authorization subject.
   * @returns completion after all matching Session fences are durable.
   */
  invalidateDevice(deviceId: RemoteDeviceId): Promise<void>
  /**
   * Recheck lease/authorization and synchronously invoke the DSH owner.
   * @param lease - exact current holder token.
   * @param authorize - synchronous exact capability and authority-epoch check.
   * @param effect - synchronous DSH owner admission.
   * @returns effect value or stable lease failure.
   */
  admit<T>(
    lease: RemoteControlProof,
    authorize: () => void,
    effect: () => T,
  ): Promise<RemoteControlAdmissionResult<T>>
}
