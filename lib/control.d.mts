import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { SessionId } from "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-storage-domain";
import { Context } from "@deepseek-ai/cordis";
import { Branded } from "@deepseek-ai/dsh-brand";
//#region src/control/types.d.ts
/** Host-global caller idempotency key. */
type RemoteCommandId = Branded<'RemoteCommandId'>;
/** Stable authorization subject minted by the Host security authority. */
type RemoteDeviceId = Branded<'RemoteDeviceId'>;
/** Monotonic per-Session control epoch encoded as canonical uint64 decimal. */
type RemoteControlEpoch = Branded<'RemoteControlEpoch'>;
/** Opaque random lease secret returned only to the authenticated holder. */
type RemoteControlToken = Branded<'RemoteControlToken'>;
/** Opaque command-to-Session correlation stored inside the admitted user message. */
type RemoteCommandCorrelation = Branded<'RemoteCommandCorrelation'>;
/** Stable binding reserved before an effect can begin. */
interface RemoteCommandBinding {
  readonly commandId: RemoteCommandId;
  readonly operation: 'send_input' | 'stop' | 'decide_approval' | 'create_session' | 'select_agent_preset' | 'select_model' | 'fork_session' | 'revoke_approval_rule' | 'set_session_budget';
  readonly sessionId: SessionId;
  readonly requestFingerprint: string;
  readonly deviceId: RemoteDeviceId;
  readonly authorityEpoch: string;
  readonly controlEpoch?: RemoteControlEpoch;
  /** Exact Host-issued active turn for Stop; absent for SendInput. */
  readonly targetTurn?: number;
  /** Exact ApprovalService identity for a mobile decision. */
  readonly approvalId?: string;
  /** Opaque same-process pending incarnation. */
  readonly approvalRevision?: string;
  /** Closed mobile-decidable outcome. */
  readonly approvalOutcome?: 'allowed-once' | 'rejected';
  /**
   * Agent preset id bound at reservation (S-mode-select): required for
   * select_agent_preset, optional for create_session (default applies).
   */
  readonly agentPreset?: string;
  /** Exact provider/model/effort triple bound at reservation (S-session-admin select_model). */
  readonly modelSelection?: {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string | undefined;
  };
  /** Caller-preallocated fork child id (S-session-admin fork_session). */
  readonly childSessionId?: SessionId;
  /** Optional fork cut anchor (S-session-admin fork_session). */
  readonly forkAtSeq?: number;
  /** Exact active-rule identity bound at reservation (S-policy revoke_approval_rule). */
  readonly ruleId?: string;
  /** Token ceiling bound at reservation (S-policy set_session_budget). */
  readonly maxTotalTokens?: number;
}
/** Durable correlation pointing at the committed Inbox splice. */
interface RemoteSendInputCommit {
  readonly sessionEventSeq: number;
  readonly messageId: string;
}
/** Durable correlation pointing at the exact stopped turn terminal. */
interface RemoteStopCommit {
  readonly targetTurn: number;
  readonly turnEndSeq: number;
}
/** Durable correlation pointing at the exact ApprovalService audit terminal. */
interface RemoteApprovalDecisionCommit {
  readonly approvalId: string;
  readonly outcome: 'allowed-once' | 'rejected';
  readonly decidedEventSeq: number;
}
/**
 * Durable fact that the caller-preallocated Session exists (S-mode-select).
 * The session id is already the binding's sessionId; the resolved preset is
 * recorded when the deployment composes presets.
 */
interface RemoteCreateSessionCommit {
  readonly created: true;
  readonly agentPreset?: string | undefined;
}
/** Durable fact that one blank Session's agent was recomposed (S-mode-select). */
interface RemoteSelectAgentPresetCommit {
  readonly selectedPreset: string;
}
/** Durable fact that a Session's next-step model selection was replaced (S-session-admin). */
interface RemoteSelectModelCommit {
  readonly selectedModel: {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string | undefined;
  };
}
/** Durable fact that the caller-preallocated fork child exists (S-session-admin). */
interface RemoteForkSessionCommit {
  readonly forked: true;
  readonly childSessionId: SessionId;
}
/** Durable fact that one exact rule's revocation event crossed the session log (S-policy). */
interface RemoteRevokeApprovalRuleCommit {
  readonly revokedRuleId: string;
}
/** Durable fact that the session budget event crossed the session log (S-policy). */
interface RemoteSetSessionBudgetCommit {
  readonly budgetSet: true;
  readonly maxTotalTokens: number;
}
/** Operation-specific durable Session fact. */
type RemoteCommandCommit = RemoteSendInputCommit | RemoteStopCommit | RemoteApprovalDecisionCommit | RemoteCreateSessionCommit | RemoteSelectAgentPresetCommit | RemoteSelectModelCommit | RemoteForkSessionCommit | RemoteRevokeApprovalRuleCommit | RemoteSetSessionBudgetCommit;
/** Durable proof that the exact Stop effect was requested from the Agent owner. */
interface RemoteStopRequested {
  readonly targetTurn: number;
}
/** Stable rejection stored without deployment-varying prose. */
interface RemoteCommandRejection {
  readonly code: string;
}
interface RemoteCommandBase extends RemoteCommandBinding {
  readonly correlation: RemoteCommandCorrelation;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
/** Durable reservation with no authoritative terminal fact yet. */
interface RemoteCommandReserved extends RemoteCommandBase {
  readonly phase: 'reserved';
  readonly revision: 0;
}
/** Durable Stop-requested state; it is non-terminal and may still reconcile to UNKNOWN. */
interface RemoteCommandRequested extends RemoteCommandBase {
  readonly phase: 'requested';
  readonly revision: 1;
  readonly requested: RemoteStopRequested;
}
/** Journal index pointing at a durable correlated Session fact. */
interface RemoteCommandCommitted extends RemoteCommandBase {
  readonly phase: 'committed';
  readonly revision: 1 | 2;
  readonly commit: RemoteCommandCommit;
}
/** Durable definitive rejection made before any effect. */
interface RemoteCommandRejected extends RemoteCommandBase {
  readonly phase: 'rejected';
  readonly revision: 1;
  readonly rejection: RemoteCommandRejection;
}
/** Closed durable journal vocabulary; UNKNOWN is intentionally absent. */
type RemoteCommandRow = RemoteCommandReserved | RemoteCommandRequested | RemoteCommandCommitted | RemoteCommandRejected;
/** Reservation result for first admission, live join, replay, or ID conflict. */
type RemoteCommandReservation = {
  readonly kind: 'created';
  readonly row: RemoteCommandReserved;
} | {
  readonly kind: 'pending';
  readonly row: RemoteCommandReserved | RemoteCommandRequested;
} | {
  readonly kind: 'replay';
  readonly row: RemoteCommandCommitted | RemoteCommandRejected;
} | {
  readonly kind: 'conflict';
};
/** Server-verifiable proof presented by an authenticated controller. */
interface RemoteControlProof {
  readonly sessionId: SessionId;
  readonly holderDeviceId: RemoteDeviceId;
  readonly epoch: RemoteControlEpoch;
  readonly token: RemoteControlToken;
}
/** Opaque lease value returned only to its authenticated holder. */
interface RemoteControlLease extends RemoteControlProof {
  readonly expiresAtMs: number;
}
/** Stable negative fence results; none can reach the effect callback. */
type RemoteControlFailure = 'held-by-other' | 'unheld' | 'expired' | 'stale-fence';
/** Result of acquiring, renewing, or transferring control. */
type RemoteControlLeaseResult = {
  readonly ok: true;
  readonly lease: RemoteControlLease;
} | {
  readonly ok: false;
  readonly reason: RemoteControlFailure;
};
/** Result of a fenced synchronous admission. */
type RemoteControlAdmissionResult<T> = {
  readonly ok: true;
  readonly value: T;
} | {
  readonly ok: false;
  readonly reason: RemoteControlFailure;
};
/** Host-side service shared by send, stop, and policy-approved interactions. */
interface RemoteControlService {
  /**
   * Reserve one Host-global caller id before effect admission.
   * @param binding - complete authenticated semantic binding.
   * @returns created, pending, replay, or conflict.
   */
  reserveCommand(binding: RemoteCommandBinding): Promise<RemoteCommandReservation>;
  /**
   * Read one durable command outcome index.
   * @param commandId - Host-global caller identity.
   * @returns current immutable row or absence.
   */
  lookupCommand(commandId: RemoteCommandId): Promise<RemoteCommandRow | undefined>;
  /**
   * Persist that an exact Stop reached the Agent cancellation owner.
   * @param commandId - reserved caller identity.
   * @param expectedFingerprint - exact reservation fingerprint.
   * @param requested - exact turn passed to the owner.
   * @returns non-terminal requested row.
   */
  markCommandRequested(commandId: RemoteCommandId, expectedFingerprint: string, requested: RemoteStopRequested): Promise<RemoteCommandRequested>;
  /**
   * Index an already durable correlated Session fact.
   * @param commandId - reserved caller identity.
   * @param expectedFingerprint - exact reservation fingerprint.
   * @param commit - Session event/message correlation.
   * @returns committed journal row.
   */
  commitCommand(commandId: RemoteCommandId, expectedFingerprint: string, commit: RemoteCommandCommit): Promise<RemoteCommandCommitted>;
  /**
   * Persist one definitive pre-effect rejection.
   * @param commandId - reserved caller identity.
   * @param expectedFingerprint - exact reservation fingerprint.
   * @param rejection - stable machine code.
   * @returns rejected journal row.
   */
  rejectCommand(commandId: RemoteCommandId, expectedFingerprint: string, rejection: RemoteCommandRejection): Promise<RemoteCommandRejected>;
  /**
   * Acquire an unheld or expired Session, or recover the exact live lease when
   * the same authenticated holder lost its prior response.
   * @param sessionId - ordinary Session identity.
   * @param deviceId - authenticated stable device identity.
   * @returns new lease or held conflict.
   */
  acquireControl(sessionId: SessionId, deviceId: RemoteDeviceId): Promise<RemoteControlLeaseResult>;
  /**
   * Extend one exact unexpired lease without changing its fence.
   * @param lease - exact current holder token.
   * @returns renewed lease or stable fence failure.
   */
  renewControl(lease: RemoteControlProof): Promise<RemoteControlLeaseResult>;
  /**
   * Bump the fence and hand control to another device.
   * @param lease - exact current holder token.
   * @param nextDeviceId - authenticated next holder.
   * @returns next lease or stable fence failure.
   */
  transferControl(lease: RemoteControlProof, nextDeviceId: RemoteDeviceId): Promise<RemoteControlLeaseResult>;
  /**
   * Release one exact current lease.
   * @param lease - exact current holder token.
   * @returns released postcondition or stable fence failure.
   */
  releaseControl(lease: RemoteControlProof): Promise<{
    readonly ok: true;
  } | {
    readonly ok: false;
    readonly reason: RemoteControlFailure;
  }>;
  /**
   * Bump and clear every live lease held by one invalidated device.
   * @param deviceId - revoked or reprofiled authorization subject.
   * @returns completion after all matching Session fences are durable.
   */
  invalidateDevice(deviceId: RemoteDeviceId): Promise<void>;
  /**
   * Recheck lease/authorization and synchronously invoke the DSH owner.
   * @param lease - exact current holder token.
   * @param authorize - synchronous exact capability and authority-epoch check.
   * @param effect - synchronous DSH owner admission.
   * @returns effect value or stable lease failure.
   */
  admit<T>(lease: RemoteControlProof, authorize: () => void, effect: () => T): Promise<RemoteControlAdmissionResult<T>>;
}
//#endregion
//#region src/control/journal.d.ts
/**
 * Hash an explicit canonical command tuple; arbitrary object serialization is
 * deliberately excluded from this identity boundary.
 * @param input - semantic command fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
declare function fingerprintRemoteSendInput(input: {
  readonly sessionId: SessionId;
  readonly text: string;
  readonly deviceId: string;
  readonly authorityEpoch: string;
  readonly controlEpoch: string;
  /**
   * Committed upload ids attached to the input (S-blob); each id is one
   * canonical field, so identical text with different images never replays.
   */
  readonly attachmentIds?: readonly string[];
}): string;
/**
 * Hash the exact Stop target and authenticated fences.
 * @param input - semantic Stop fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
declare function fingerprintRemoteStop(input: {
  readonly sessionId: SessionId;
  readonly targetTurn: number;
  readonly deviceId: string;
  readonly authorityEpoch: string;
  readonly controlEpoch: string;
}): string;
/**
 * Hash one exact pending approval revision and authenticated decision-maker.
 * @param input - Exact approval identity, outcome and authenticated authority binding.
 * @returns Canonical SHA-256 request fingerprint.
 */
declare function fingerprintRemoteApprovalDecision(input: {
  readonly sessionId: SessionId;
  readonly approvalId: string;
  readonly approvalRevision: string;
  readonly outcome: 'allowed-once' | 'rejected';
  readonly deviceId: string;
  readonly authorityEpoch: string;
  /**
   * S-policy third decision: the settlement stays `allowed-once`, but the
   * same-kind rule mint is part of the command's semantics, so it joins the
   * identity boundary — a retried command_id flipping this intent conflicts.
   */
  readonly grantSameKind?: boolean;
}): string;
/**
 * Hash one caller-preallocated Session creation (S-mode-select). Creation is
 * naturally idempotent at the owner (same id returns the same session); the
 * fingerprint still pins the authenticated semantics so a reused command_id
 * with different intent conflicts instead of silently replaying.
 * @param input - semantic create fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
declare function fingerprintRemoteCreateSession(input: {
  readonly sessionId: SessionId;
  readonly agentPreset?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly newWorkspaceName?: string | undefined;
  readonly deviceId: string;
  readonly authorityEpoch: string;
}): string;
/**
 * Hash one exact blank-session preset selection (S-mode-select).
 * @param input - semantic select fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
declare function fingerprintRemoteSelectAgentPreset(input: {
  readonly sessionId: SessionId;
  readonly agentPreset: string;
  readonly deviceId: string;
  readonly authorityEpoch: string;
}): string;
/**
 * Hash one exact model selection (S-session-admin). The selection is
 * set-valued at the owner (re-selecting the same triple converges), and the
 * presented control epoch pins the fence it was admitted under.
 * @param input - semantic select fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
declare function fingerprintRemoteSelectModel(input: {
  readonly sessionId: SessionId;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
  readonly deviceId: string;
  readonly authorityEpoch: string;
  readonly controlEpoch: string;
}): string;
/**
 * Hash one caller-preallocated Session fork (S-session-admin). The owner
 * converges a retry to the same child, so the fingerprint pins exactly the
 * source, child id, anchor, and authenticated authority.
 * @param input - semantic fork fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
declare function fingerprintRemoteForkSession(input: {
  readonly sessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly atSeq?: number | undefined;
  readonly deviceId: string;
  readonly authorityEpoch: string;
}): string;
/**
 * Hash one exact rule revocation (S-policy). Revocation is set-valued at the
 * owner (the rule is gone either way), so the fingerprint pins the exact rule
 * and authenticated authority.
 * @param input - semantic revoke fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
declare function fingerprintRemoteRevokeApprovalRule(input: {
  readonly sessionId: SessionId;
  readonly ruleId: string;
  readonly deviceId: string;
  readonly authorityEpoch: string;
}): string;
/**
 * Hash one exact session budget ceiling (S-policy). The budget fold is
 * last-wins at the owner, so re-setting the same ceiling converges.
 * @param input - semantic budget fields whose equality permits replay.
 * @returns lower-case SHA-256 hex.
 */
declare function fingerprintRemoteSetSessionBudget(input: {
  readonly sessionId: SessionId;
  readonly maxTotalTokens: number;
  readonly deviceId: string;
  readonly authorityEpoch: string;
}): string;
//#endregion
//#region src/control/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-side journal and control-fence owner; transports receive only narrow method closures. */
    remoteControl: RemoteControlService;
  }
}
/** Stable Cordis function-plugin name. */
declare const name = "host-remote-control";
/** Durable data-form dependency; the read-only Remote carrier remains independent. */
declare const inject: string[];
/** Deployment policy for short-lived controller ownership. */
interface Config {
  /** Lease lifetime applied to acquire, renew, and transfer. @default 30000 */
  leaseTtlMs?: number;
}
declare const Config: z<Config>;
/**
 * Open both durable authorities atomically with respect to service publication,
 * then retract the service before draining them during plugin disposal.
 * @param ctx - Host Context carrying the routed storage-domain facility.
 * @param config - bounded control-lease policy.
 */
declare function apply(ctx: Context, config: Config): Promise<void>;
//#endregion
export { Config, type RemoteApprovalDecisionCommit, type RemoteCommandBinding, type RemoteCommandCommit, type RemoteCommandCommitted, type RemoteCommandCorrelation, type RemoteCommandId, type RemoteCommandRejected, type RemoteCommandRejection, type RemoteCommandRequested, type RemoteCommandReservation, type RemoteCommandReserved, type RemoteCommandRow, type RemoteControlAdmissionResult, type RemoteControlEpoch, type RemoteControlFailure, type RemoteControlLease, type RemoteControlLeaseResult, type RemoteControlProof, type RemoteControlService, type RemoteControlToken, type RemoteCreateSessionCommit, type RemoteDeviceId, type RemoteForkSessionCommit, type RemoteRevokeApprovalRuleCommit, type RemoteSelectAgentPresetCommit, type RemoteSelectModelCommit, type RemoteSendInputCommit, type RemoteSetSessionBudgetCommit, type RemoteStopCommit, type RemoteStopRequested, apply, fingerprintRemoteApprovalDecision, fingerprintRemoteCreateSession, fingerprintRemoteForkSession, fingerprintRemoteRevokeApprovalRule, fingerprintRemoteSelectAgentPreset, fingerprintRemoteSelectModel, fingerprintRemoteSendInput, fingerprintRemoteSetSessionBudget, fingerprintRemoteStop, inject, name };
//# sourceMappingURL=control.d.mts.map