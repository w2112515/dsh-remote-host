import z from "@deepseek-ai/schemastery";
import { SessionId } from "@deepseek-ai/dsh-session";
import { Context } from "@deepseek-ai/cordis";
import { Branded } from "@deepseek-ai/dsh-brand";
//#region src/command/types.d.ts
/** Host-global caller idempotency identity, compatible with the control journal brand. */
type RemoteSendCommandId = Branded<'RemoteCommandId'>;
/** Host-global caller idempotency identity for exact-turn Stop. */
type RemoteStopCommandId = Branded<'RemoteCommandId'>;
/** Host-global caller idempotency identity for an approval decision. */
type RemoteApprovalCommandId = Branded<'RemoteCommandId'>;
/** Host-global caller idempotency identity for a preallocated Session create (S-mode-select). */
type RemoteCreateSessionCommandId = Branded<'RemoteCommandId'>;
/** Host-global caller idempotency identity for a blank-session preset select (S-mode-select). */
type RemoteSelectAgentPresetCommandId = Branded<'RemoteCommandId'>;
/** Host-global caller idempotency identity for a model select (S-session-admin). */
type RemoteSelectModelCommandId = Branded<'RemoteCommandId'>;
/** Host-global caller idempotency identity for a preallocated-child fork (S-session-admin). */
type RemoteForkSessionCommandId = Branded<'RemoteCommandId'>;
/** Host-global caller idempotency identity for an exact-rule revocation (S-policy). */
type RemoteRevokeApprovalRuleCommandId = Branded<'RemoteCommandId'>;
/** Host-global caller idempotency identity for a session budget ceiling set (S-policy). */
type RemoteSetSessionBudgetCommandId = Branded<'RemoteCommandId'>;
/** Authenticated device identity, compatible with the control authority brand. */
type RemoteCommandDeviceId = Branded<'RemoteDeviceId'>;
/** Presented control epoch, compatible with the control authority brand. */
type RemoteCommandControlEpoch = Branded<'RemoteControlEpoch'>;
/** Presented opaque control secret, compatible with the control authority brand. */
type RemoteCommandControlToken = Branded<'RemoteControlToken'>;
/** Client-presented fence after the carrier replaces identity fields with authenticated facts. */
interface RemoteCommandControlProof {
  readonly sessionId: SessionId;
  readonly holderDeviceId: RemoteCommandDeviceId;
  readonly epoch: RemoteCommandControlEpoch;
  readonly token: RemoteCommandControlToken;
}
/** Authentication facts captured by the secure carrier, never supplied by the phone payload. */
interface RemoteCommandAuthority {
  readonly deviceId: RemoteCommandDeviceId;
  readonly authorityEpoch: string;
  /** Recheck the exact operation capability and captured authority epoch synchronously. */
  authorize: () => void;
}
/** Authenticated M1 send-input command after wire parsing: text plus optional committed image references (S-blob). */
interface RemoteSendInputCommand {
  readonly commandId: RemoteSendCommandId;
  readonly sessionId: SessionId;
  readonly text: string;
  readonly control: RemoteCommandControlProof;
  /**
   * Committed upload ids to attach as image blocks (S-blob), wire-validated
   * `sha256:<hex>` references. Unknown or inadmissible ids fail admission at
   * the Host owner with `attachment-error`; the id list joins the command
   * fingerprint, so it can never replay onto different images.
   */
  readonly attachmentIds?: readonly string[];
}
/** Authenticated exact-turn Stop after wire parsing. */
interface RemoteStopCommand {
  readonly commandId: RemoteStopCommandId;
  readonly sessionId: SessionId;
  readonly expectedActivityRevision: number;
  readonly control: RemoteCommandControlProof;
}
/** Authenticated exact-revision approval decision; it intentionally carries no control lease. */
interface RemoteApprovalDecisionCommand {
  readonly commandId: RemoteApprovalCommandId;
  readonly sessionId: SessionId;
  readonly approvalId: string;
  readonly approvalRevision: string;
  readonly outcome: 'allowed-once' | 'rejected';
  /**
   * S-policy third decision (ALLOW_SAME_KIND): settle this ask `allowed-once`
   * AND mint the session rule auto-granting its honestly derived class. Only
   * meaningful with `outcome: 'allowed-once'`; the mint joins the command
   * fingerprint, and an underivable class rejects before any mutation.
   */
  readonly grantSameKind?: true;
}
/**
 * Authenticated exact-rule revocation (S-policy). Lease-free: it shares the
 * approval trust domain (the same capability that creates rules), and the
 * management surface must work without holding the session control lease.
 */
interface RemoteRevokeApprovalRuleCommand {
  readonly commandId: RemoteRevokeApprovalRuleCommandId;
  readonly sessionId: SessionId;
  readonly ruleId: string;
}
/**
 * Authenticated session token-ceiling set (S-policy). Lease-free session
 * administration: capping a session another device controls is exactly the
 * oversight use case, so no in-flight fence is presented. Last-wins at the
 * owner's fold.
 */
interface RemoteSetSessionBudgetCommand {
  readonly commandId: RemoteSetSessionBudgetCommandId;
  readonly sessionId: SessionId;
  readonly maxTotalTokens: number;
}
/**
 * Authenticated preallocated Session create (S-mode-select). It carries no
 * control lease — the session does not exist yet, so there is no in-flight
 * effect to fence — and is naturally idempotent at the owner: retrying the
 * same preallocated id returns the same session instead of creating a twin.
 */
interface RemoteCreateSessionCommand {
  readonly commandId: RemoteCreateSessionCommandId;
  readonly sessionId: SessionId;
  readonly agentPreset?: string;
  /** Existing Host WorkspaceId. Omitted with no new name → Host default cwd. */
  readonly workspaceId?: string;
  /** Single child folder name under workspaceId; never a path. */
  readonly newWorkspaceName?: string;
}
/**
 * Authenticated blank-session preset select (S-mode-select). It carries no
 * control lease: a blank session has no running turn to race, and the owner
 * answers agent-preset-locked the moment any turn exists.
 */
interface RemoteSelectAgentPresetCommand {
  readonly commandId: RemoteSelectAgentPresetCommandId;
  readonly sessionId: SessionId;
  readonly agentPreset: string;
}
/**
 * Authenticated model select (S-session-admin). It carries a control lease
 * because it mutates a session that may have an in-flight turn: the new triple
 * applies to the next assembled request, so the fence pins which controller is
 * allowed to change it. The owner answers model-unavailable when the catalog
 * cannot resolve the exact triple.
 */
interface RemoteSelectModelCommand {
  readonly commandId: RemoteSelectModelCommandId;
  readonly sessionId: SessionId;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly control: RemoteCommandControlProof;
}
/**
 * Authenticated preallocated-child fork (S-session-admin). It carries no
 * control lease — the source session is never mutated — and converges at the
 * owner: retrying the same child id with the same lineage returns the existing
 * child, while any other lineage answers session-conflict.
 */
interface RemoteForkSessionCommand {
  readonly commandId: RemoteForkSessionCommandId;
  readonly sessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly atSeq?: number;
}
/**
 * Narrow Host session-admin face behind ApiProxy (S-mode-select,
 * S-session-admin). Error codes pass through unchanged
 * (agent-preset-not-found, agent-preset-locked, agent-preset-invalid,
 * model-unavailable, fork-unavailable, fork-conflict, session-conflict,
 * session-not-found); anything else arrives as session-admin-unavailable.
 */
interface HostSessionAdmin {
  createSession(input: {
    readonly sessionId: SessionId;
    readonly agentPreset?: string;
    readonly workspaceId?: string;
    readonly newWorkspaceName?: string;
  }): Promise<{
    readonly ok: true;
    readonly agentPreset?: string;
  } | {
    readonly ok: false;
    readonly errorCode: string;
  }>;
  selectAgentPreset(input: {
    readonly sessionId: SessionId;
    readonly agentPreset: string;
  }): Promise<{
    readonly ok: true;
  } | {
    readonly ok: false;
    readonly errorCode: string;
  }>;
  selectModel(input: {
    readonly sessionId: SessionId;
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
  }): Promise<{
    readonly ok: true;
  } | {
    readonly ok: false;
    readonly errorCode: string;
  }>;
  forkSession(input: {
    readonly sessionId: SessionId;
    readonly childSessionId: SessionId;
    readonly atSeq?: number;
  }): Promise<{
    readonly ok: true;
    readonly childSessionId: SessionId;
  } | {
    readonly ok: false;
    readonly errorCode: string;
  }>;
}
/**
 * Narrow session-policy face (S-policy, ADR-006), implemented by the Host
 * policy owner and consumed lazily (`ctx.get('remoteApprovalPolicy')`) so this
 * package stays composable without it. Stable error codes:
 * `approval-class-underivable` (no honest class — the third decision was
 * never offered), `approval-rule-limit` (active-rule cap),
 * `approval-rule-not-found` (revoke of an unknown/inactive rule),
 * `session-not-found`, and `approval-policy-unavailable` for anything else.
 */
interface HostApprovalPolicy {
  /**
   * Mint (or dedup onto) the session rule auto-granting the ask's honestly
   * derived class. Set-valued: re-granting an already-covered class returns
   * the existing rule, so journal retries converge.
   */
  grantForApproval(input: {
    readonly sessionId: SessionId;
    readonly toolName: string;
    readonly reason?: string;
  }): Promise<{
    readonly ok: true;
    readonly ruleId: string;
  } | {
    readonly ok: false;
    readonly errorCode: string;
  }>;
  /** Revoke one exact active rule; inactive ids answer `approval-rule-not-found`. */
  revokeRule(input: {
    readonly sessionId: SessionId;
    readonly ruleId: string;
  }): Promise<{
    readonly ok: true;
  } | {
    readonly ok: false;
    readonly errorCode: string;
  }>;
  /** Whether the exact rule is currently active (replay re-proof for revocation). */
  isRuleActive(input: {
    readonly sessionId: SessionId;
    readonly ruleId: string;
  }): boolean;
  /** Set the session's token ceiling (last-wins at the durable fold). */
  setBudget(input: {
    readonly sessionId: SessionId;
    readonly maxTotalTokens: number;
  }): Promise<{
    readonly ok: true;
  } | {
    readonly ok: false;
    readonly errorCode: string;
  }>;
  /** The current ceiling, when set (replay re-proof for budget sets). */
  currentBudget(sessionId: SessionId): number | undefined;
  /**
   * The send-admission budget gate: `undefined` when the session has no
   * budget (absence is never a gate) or cumulative usage is unmeasurable;
   * otherwise the owner's exhaustion decision against the usage projection.
   */
  evaluateBudget(sessionId: SessionId): {
    readonly exhausted: boolean;
  } | undefined;
}
/** Non-terminal durable-owner receipt emitted after reservation. */
interface RemoteCommandReceived {
  readonly outcome: 'received';
  readonly commandId: RemoteSendCommandId;
  readonly replayed: boolean;
}
/** Terminal command result; UNKNOWN is epistemic and never a journal phase. */
type RemoteCommandTerminal = {
  readonly outcome: 'committed';
  readonly commandId: RemoteSendCommandId;
  readonly replayed: boolean;
} | {
  readonly outcome: 'rejected';
  readonly commandId: RemoteSendCommandId;
  readonly replayed: boolean;
  readonly errorCode: string;
} | {
  readonly outcome: 'unknown';
  readonly commandId: RemoteSendCommandId;
  readonly replayed: boolean;
  readonly errorCode: string;
};
/** Non-terminal Stop receipt emitted only after durable requested state exists. */
interface RemoteStopRequestedReceipt {
  readonly outcome: 'requested';
  readonly commandId: RemoteStopCommandId;
  readonly expectedActivityRevision: number;
  readonly replayed: boolean;
}
/** Owner-specific Stop settlement; UNKNOWN is epistemic and never a journal phase. */
type RemoteStopTerminal = {
  readonly outcome: 'stopped';
  readonly commandId: RemoteStopCommandId;
  readonly expectedActivityRevision: number;
  readonly replayed: boolean;
  readonly currentRunning?: boolean;
} | {
  readonly outcome: 'rejected' | 'unknown';
  readonly commandId: RemoteStopCommandId;
  readonly expectedActivityRevision: number;
  readonly replayed: boolean;
  readonly errorCode: string;
};
/** Transport-neutral owner for authenticated, idempotent Remote commands. */
interface RemoteCommandService {
  /**
   * Reserve, reconcile, and execute one text input under an exact authority and control fence.
   * @param authority - authenticated carrier facts plus the synchronous capability recheck.
   * @param command - parsed caller identity, target, text, and presented control proof.
   * @param onReceived - optional non-terminal delivery callback; its failure never cancels ownership.
   * @returns authoritative terminal outcome or an honest UNKNOWN result.
   */
  sendInput(authority: RemoteCommandAuthority, command: RemoteSendInputCommand, onReceived?: (receipt: RemoteCommandReceived) => void): Promise<RemoteCommandTerminal>;
  /**
   * Request and settle cancellation of one exact active turn under the same durable ID and control authority.
   * @param authority - authenticated carrier facts plus the synchronous Stop capability recheck.
   * @param command - caller ID, target revision, and presented control proof.
   * @param onRequested - non-terminal callback after cancellation and durable requested state.
   * @returns stopped, rejected, or honest UNKNOWN settlement.
   */
  stop(authority: RemoteCommandAuthority, command: RemoteStopCommand, onRequested?: (receipt: RemoteStopRequestedReceipt) => void): Promise<RemoteStopTerminal>;
  /**
   * Decide one currently pending ApprovalService interaction under its own capability and revision fence.
   * @param authority - authenticated carrier facts plus exact approval-capability recheck.
   * @param command - caller ID, pending identity/revision, and one-shot decision.
   * @param onReceived - callback after durable Host-global reservation.
   * @returns committed, rejected, or honest UNKNOWN decision settlement.
   */
  decideApproval(authority: RemoteCommandAuthority, command: RemoteApprovalDecisionCommand, onReceived?: (receipt: RemoteCommandReceived) => void): Promise<RemoteCommandTerminal>;
  /**
   * Create the caller-preallocated Session under the same durable ID authority.
   * @param authority - authenticated carrier facts plus the session-control capability recheck.
   * @param command - caller ID, preallocated session id, and optional preset.
   * @param onReceived - callback after durable Host-global reservation.
   * @returns committed, rejected, or honest UNKNOWN create settlement.
   */
  createSession(authority: RemoteCommandAuthority, command: RemoteCreateSessionCommand, onReceived?: (receipt: RemoteCommandReceived) => void): Promise<RemoteCommandTerminal>;
  /**
   * Recompose one still-blank Session's agent from a named preset.
   * @param authority - authenticated carrier facts plus the session-control capability recheck.
   * @param command - caller ID, target session, and exact preset id.
   * @param onReceived - callback after durable Host-global reservation.
   * @returns committed, rejected, or honest UNKNOWN select settlement.
   */
  selectAgentPreset(authority: RemoteCommandAuthority, command: RemoteSelectAgentPresetCommand, onReceived?: (receipt: RemoteCommandReceived) => void): Promise<RemoteCommandTerminal>;
  /**
   * Replace one Session's next-step model selection under an exact control fence.
   * @param authority - authenticated carrier facts plus the session-control capability recheck.
   * @param command - caller ID, exact provider/model/effort triple, and presented control proof.
   * @param onReceived - callback after durable Host-global reservation.
   * @returns committed, rejected, or honest UNKNOWN select settlement.
   */
  selectModel(authority: RemoteCommandAuthority, command: RemoteSelectModelCommand, onReceived?: (receipt: RemoteCommandReceived) => void): Promise<RemoteCommandTerminal>;
  /**
   * Fork one Session into the caller-preallocated child id (lease-free).
   * @param authority - authenticated carrier facts plus the session-control capability recheck.
   * @param command - caller ID, source session, preallocated child id, and optional cut anchor.
   * @param onReceived - callback after durable Host-global reservation.
   * @returns committed, rejected, or honest UNKNOWN fork settlement.
   */
  forkSession(authority: RemoteCommandAuthority, command: RemoteForkSessionCommand, onReceived?: (receipt: RemoteCommandReceived) => void): Promise<RemoteCommandTerminal>;
  /**
   * Revoke one exact active auto-grant rule (S-policy, lease-free).
   * @param authority - authenticated carrier facts plus the approval capability recheck.
   * @param command - caller ID, target session, and exact rule id.
   * @param onReceived - callback after durable Host-global reservation.
   * @returns committed, rejected, or honest UNKNOWN revoke settlement.
   */
  revokeApprovalRule(authority: RemoteCommandAuthority, command: RemoteRevokeApprovalRuleCommand, onReceived?: (receipt: RemoteCommandReceived) => void): Promise<RemoteCommandTerminal>;
  /**
   * Set one Session's token budget ceiling (S-policy, lease-free, last-wins).
   * @param authority - authenticated carrier facts plus the session-control capability recheck.
   * @param command - caller ID, target session, and exact positive ceiling.
   * @param onReceived - callback after durable Host-global reservation.
   * @returns committed, rejected, or honest UNKNOWN budget settlement.
   */
  setSessionBudget(authority: RemoteCommandAuthority, command: RemoteSetSessionBudgetCommand, onReceived?: (receipt: RemoteCommandReceived) => void): Promise<RemoteCommandTerminal>;
}
//#endregion
//#region src/command/workspace-bind.d.ts
/** Host-side create_session workspace bind: existing id, or a child folder name. */
type RemoteWorkspaceBindError = 'workspace-not-found' | 'workspace-invalid-name' | 'workspace-create-failed';
type RemoteWorkspaceBindResult = {
  readonly ok: true;
  readonly workspaceId?: string;
} | {
  readonly ok: false;
  readonly errorCode: RemoteWorkspaceBindError;
};
/**
 * Accept one folder name the Host may mkdir under an already-registered
 * parent. Rejects paths, traversal, Windows reserved names, and empty input.
 * Unicode is allowed; the absolute path never leaves the Host.
 * @param raw - caller-supplied name, possibly dirty.
 * @returns the trimmed name, or `undefined` when it cannot be a child folder.
 */
declare function sanitizeRemoteWorkspaceName(raw: string): string | undefined;
/**
 * Resolve the workspace a Remote create_session should bind.
 * Neither field → Host default cwd (owner omits workspaceId).
 * workspaceId only → that registered workspace.
 * both → mkdir `name` under the parent, register-or-reuse, bind the child.
 * @param input - wire fields plus Host-local list/mkdir/register faces.
 */
declare function bindRemoteCreateWorkspace(input: {
  readonly workspaceId?: string;
  readonly newWorkspaceName?: string;
  readonly list: () => Promise<ReadonlyArray<{
    workspaceId: string;
    path: string;
  }>>;
  readonly mkdir: (parentPath: string, name: string) => Promise<string>;
  readonly register: (path: string) => Promise<{
    readonly ok: true;
    readonly workspaceId: string;
  } | {
    readonly ok: false;
    readonly errorCode: string;
  }>;
}): Promise<RemoteWorkspaceBindResult>;
//#endregion
//#region src/command/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authenticated, idempotent Remote command owner. */
    remoteCommands: RemoteCommandService;
    /**
     * Host session-policy owner (S-policy, ADR-006), provided by the
     * composing remote plugin; this package reads it lazily so deployments
     * without the policy owner still compose.
     */
    remoteApprovalPolicy: HostApprovalPolicy;
  }
}
/** Stable Cordis function-plugin name. */
declare const name = "host-remote-command";
/** Transport-neutral DSH admission and durable command authority dependencies. */
declare const inject: string[];
/** No deployment tunables: wire policy and lease policy belong to their owning plugins. */
interface Config {
  /** Caller-visible Stop settlement wait; the accepted owner continues after timeout. @default 30000 */
  stopSettlementTimeoutMs?: number;
}
/** Bounded owner settlement policy. */
declare const Config: z<Config>;
/**
 * Publish the command adapter and drain accepted owners before disposal completes.
 * @param ctx - Host context carrying ApiProxy and Remote control authority.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, type HostApprovalPolicy, type HostSessionAdmin, type RemoteApprovalCommandId, type RemoteApprovalDecisionCommand, type RemoteCommandAuthority, type RemoteCommandControlEpoch, type RemoteCommandControlProof, type RemoteCommandControlToken, type RemoteCommandDeviceId, type RemoteCommandReceived, type RemoteCommandService, type RemoteCommandTerminal, type RemoteCreateSessionCommand, type RemoteCreateSessionCommandId, type RemoteForkSessionCommand, type RemoteForkSessionCommandId, type RemoteRevokeApprovalRuleCommand, type RemoteRevokeApprovalRuleCommandId, type RemoteSelectAgentPresetCommand, type RemoteSelectAgentPresetCommandId, type RemoteSelectModelCommand, type RemoteSelectModelCommandId, type RemoteSendCommandId, type RemoteSendInputCommand, type RemoteSetSessionBudgetCommand, type RemoteSetSessionBudgetCommandId, type RemoteStopCommand, type RemoteStopCommandId, type RemoteStopRequestedReceipt, type RemoteStopTerminal, apply, bindRemoteCreateWorkspace, inject, name, sanitizeRemoteWorkspaceName };
//# sourceMappingURL=command.d.mts.map