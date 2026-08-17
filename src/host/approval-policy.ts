/**
 * Approval policy engine (S-policy, ADR-006): the Host-owned, session-scoped
 * persistent grant core. Rules are folded from the session's own log events
 * (the `approval/policy` precedent: durable, replayable, dead with the
 * session, never in the model transcript); matching requests are claimed on
 * the `approval/request` answerer waterfall so the service's asked/decided
 * audit pair still covers every programmatic grant. Fail-closed throughout:
 * malformed or conflicting fold input is treated as absent, and absence is
 * never treated as a grant. This module is transport-agnostic — the session
 * event append path and the answerer registration are injected.
 */

import { BLOB_TRANSFER_ID_PATTERN } from './blob-transfer.ts'

/** Grant class derived from the facts the approval seam honestly carries. */
export type PolicyRuleClass =
  | {
    /** Sandbox escalation asks: the escalation target mode narrows the class. */
    kind: 'escalate'
    toolName: string
    mode: string
  }
  | {
    /** Any other ask: tool-level class (the seam carries no arguments). */
    kind: 'tool'
    toolName: string
  }

/** One active session-scoped auto-grant rule. */
export interface PolicyRule {
  /** Engine-minted rule id matching the transfer-id pattern. */
  ruleId: string
  /** The derived class this rule auto-grants. */
  ruleClass: PolicyRuleClass
  /** Who created the rule: an authenticated user decision or operator config. */
  grantedBy: 'user' | 'operator'
  /** Grant timestamp from the engine clock. */
  grantedAtMs: number
}

/** `approval/rule` granted event riding the session log. */
export interface ApprovalRuleGrantedEvent {
  type: 'approval/rule'
  action: 'granted'
  ruleId: string
  classKind: 'escalate' | 'tool'
  toolName: string
  classMode?: string
  grantedBy: 'user' | 'operator'
  grantedAtMs: number
}

/** `approval/rule` revoked event riding the session log. */
export interface ApprovalRuleRevokedEvent {
  type: 'approval/rule'
  action: 'revoked'
  ruleId: string
  revokedAtMs: number
}

/** `approval/rule-applied` provenance join: distinguishes a programmatic grant from a human one. */
export interface ApprovalRuleAppliedEvent {
  type: 'approval/rule-applied'
  approvalId: string
  ruleId: string
  appliedAtMs: number
}

/** `session/budget` event: the per-session token ceiling (absence = no budget, never zero). */
export interface SessionBudgetEvent {
  type: 'session/budget'
  maxTotalTokens: number
  setAtMs: number
}

/** Events the policy fold consumes. Unknown/malformed entries are ignored as absent. */
export type PolicyEngineEvent =
  | ApprovalRuleGrantedEvent
  | ApprovalRuleRevokedEvent
  | ApprovalRuleAppliedEvent
  | SessionBudgetEvent

/** Disjoint token counters mirroring token-meter's `tokenUsage` projection. */
export interface PolicyTokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Budget evaluation against the cumulative projection. */
export interface PolicyBudgetState {
  /** The configured ceiling. */
  maxTotalTokens: number
  /** Sum of the four disjoint token classes. */
  totalTokens: number
  /** True when the cumulative total has reached the ceiling. */
  exhausted: boolean
}

const TOOL_NAME_PATTERN = /^[\x21-\x7e]{1,100}$/
const MODE_PATTERN = /^[a-z][a-z-]{0,63}$/
/** Mirrors the sandbox modes in packages/sandbox/sandbox/src/escalation.ts. */
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const ESCALATION_REASON = /^escalate sandbox to ([a-z-]+): /

/**
 * Ceiling on simultaneously active rules per session. The honest class space
 * is small (tools × escalation modes), so a session approaching this bound is
 * evidence of misuse, not a real need — the engine refuses instead of letting
 * the fold grow without bound.
 */
export const MAX_ACTIVE_POLICY_RULES = 100

/** A grant was refused because the session already holds {@link MAX_ACTIVE_POLICY_RULES} active rules. */
export class PolicyRuleLimitError extends Error {
  constructor() {
    super(`session already holds ${MAX_ACTIVE_POLICY_RULES} active approval rules`)
    this.name = 'PolicyRuleLimitError'
  }
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && BLOB_TRANSFER_ID_PATTERN.test(value)
}

function boundedTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Derive the honest grant class for one approval request. Escalation reasons
 * narrow to the target mode; other asks fall back to the tool-level class;
 * an escalation-shaped reason that does not parse yields `undefined` — the
 * caller must not offer "allow same kind" when no honest class exists.
 * @param toolName Tool the ask names.
 * @param reason Producer-supplied reason string, when present.
 * @returns The derived class, or `undefined` when none is honestly derivable.
 */
export function deriveApprovalClass(toolName: string, reason?: string): PolicyRuleClass | undefined {
  if (!TOOL_NAME_PATTERN.test(toolName)) return undefined
  if (reason !== undefined && reason.startsWith('escalate sandbox to')) {
    const mode = ESCALATION_REASON.exec(reason)?.[1]
    if (mode === undefined || !SANDBOX_MODES.has(mode)) return undefined
    return { kind: 'escalate', toolName, mode }
  }
  return { kind: 'tool', toolName }
}

/** Parse one fold entry; malformed input returns `undefined` (fail-closed absence). */
function parseEvent(raw: unknown): PolicyEngineEvent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (record.type === 'approval/rule' && record.action === 'granted') {
    if (
      !boundedId(record.ruleId) ||
      (record.classKind !== 'escalate' && record.classKind !== 'tool') ||
      typeof record.toolName !== 'string' ||
      !TOOL_NAME_PATTERN.test(record.toolName) ||
      (record.grantedBy !== 'user' && record.grantedBy !== 'operator') ||
      !boundedTimestamp(record.grantedAtMs)
    ) {
      return undefined
    }
    if (record.classKind === 'escalate') {
      if (typeof record.classMode !== 'string' || !MODE_PATTERN.test(record.classMode)) return undefined
      return { ...record, classMode: record.classMode } as ApprovalRuleGrantedEvent
    }
    if (record.classMode !== undefined) return undefined
    return record as unknown as ApprovalRuleGrantedEvent
  }
  if (record.type === 'approval/rule' && record.action === 'revoked') {
    if (!boundedId(record.ruleId) || !boundedTimestamp(record.revokedAtMs)) return undefined
    return record as unknown as ApprovalRuleRevokedEvent
  }
  if (record.type === 'approval/rule-applied') {
    if (
      typeof record.approvalId !== 'string' ||
      record.approvalId.length === 0 ||
      !boundedId(record.ruleId) ||
      !boundedTimestamp(record.appliedAtMs)
    ) {
      return undefined
    }
    return record as unknown as ApprovalRuleAppliedEvent
  }
  if (record.type === 'session/budget') {
    if (
      typeof record.maxTotalTokens !== 'number' ||
      !Number.isSafeInteger(record.maxTotalTokens) ||
      record.maxTotalTokens < 1 ||
      !boundedTimestamp(record.setAtMs)
    ) {
      return undefined
    }
    return record as unknown as SessionBudgetEvent
  }
  return undefined
}

/** Folded policy state for one session. */
export interface PolicyFold {
  /** Active (granted, not revoked) rules in grant order. */
  rules: readonly PolicyRule[]
  /** The latest valid session budget, when set. */
  budget?: SessionBudgetEvent
}

/**
 * Fold an ordered session event stream into policy state. The last valid
 * action per rule id wins; malformed entries are skipped as absent.
 * @param events Ordered raw log entries (oldest first).
 * @returns The active rules and the current budget.
 */
export function foldPolicyEvents(events: readonly unknown[]): PolicyFold {
  const active = new Map<string, PolicyRule>()
  let budget: SessionBudgetEvent | undefined
  for (const raw of events) {
    const event = parseEvent(raw)
    if (event === undefined) continue
    if (event.type === 'session/budget') {
      budget = event
      continue
    }
    if (event.type === 'approval/rule-applied') continue
    if (event.action === 'granted') {
      const ruleClass: PolicyRuleClass = event.classKind === 'escalate'
        ? { kind: 'escalate', toolName: event.toolName, mode: event.classMode as string }
        : { kind: 'tool', toolName: event.toolName }
      active.set(event.ruleId, {
        ruleId: event.ruleId,
        ruleClass,
        grantedBy: event.grantedBy,
        grantedAtMs: event.grantedAtMs,
      })
    } else {
      active.delete(event.ruleId)
    }
  }
  const fold: PolicyFold = { rules: [...active.values()] }
  if (budget !== undefined) fold.budget = budget
  return fold
}

/**
 * Fold ONE raw entry into an existing fold — the incremental step the
 * projection unit drives per committed event. Returns the SAME reference when
 * the entry is not a (valid) policy event, so an unchanged reference stays
 * `Object.is`-equal and produces zero downstream work.
 * @param fold Current fold (treated as immutable; a change returns a new object).
 * @param raw One raw log entry, shaped `{ type, ...payload }`.
 * @returns The next fold, or `fold` itself when nothing changed.
 */
export function applyPolicyEvent(fold: PolicyFold, raw: unknown): PolicyFold {
  const event = parseEvent(raw)
  if (event === undefined || event.type === 'approval/rule-applied') return fold
  if (event.type === 'session/budget') {
    return { rules: fold.rules, budget: event }
  }
  if (event.action === 'granted') {
    const rule: PolicyRule = {
      ruleId: event.ruleId,
      ruleClass: event.classKind === 'escalate'
        ? { kind: 'escalate', toolName: event.toolName, mode: event.classMode as string }
        : { kind: 'tool', toolName: event.toolName },
      grantedBy: event.grantedBy,
      grantedAtMs: event.grantedAtMs,
    }
    const rules = fold.rules.some(existing => existing.ruleId === event.ruleId)
      ? fold.rules.map(existing => existing.ruleId === event.ruleId ? rule : existing)
      : [...fold.rules, rule]
    return { rules, ...(fold.budget === undefined ? {} : { budget: fold.budget }) }
  }
  if (!fold.rules.some(existing => existing.ruleId === event.ruleId)) return fold
  return {
    rules: fold.rules.filter(existing => existing.ruleId !== event.ruleId),
    ...(fold.budget === undefined ? {} : { budget: fold.budget }),
  }
}

/**
 * Find the rule auto-granting one request, if any. The request's class is
 * derived with the same honesty rules as grant time.
 * @param rules Active rules from {@link foldPolicyEvents} or a live engine.
 * @param toolName Tool the ask names.
 * @param reason Producer-supplied reason string, when present.
 * @returns The matching rule, or `undefined`.
 */
export function matchPolicyRule(
  rules: readonly PolicyRule[],
  toolName: string,
  reason?: string,
): PolicyRule | undefined {
  const derived = deriveApprovalClass(toolName, reason)
  if (derived === undefined) return undefined
  return rules.find((rule) => {
    if (rule.ruleClass.kind !== derived.kind || rule.ruleClass.toolName !== derived.toolName) return false
    return derived.kind === 'tool' ||
      (rule.ruleClass.kind === 'escalate' && rule.ruleClass.mode === derived.mode)
  })
}

/**
 * Evaluate the budget against cumulative usage. All four disjoint token
 * classes count toward the ceiling.
 * @param budget The configured ceiling.
 * @param usage Cumulative session usage.
 * @returns The budget state, including exhaustion.
 */
export function evaluateBudget(budget: SessionBudgetEvent, usage: PolicyTokenUsage): PolicyBudgetState {
  const totalTokens = usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return { maxTotalTokens: budget.maxTotalTokens, totalTokens, exhausted: totalTokens >= budget.maxTotalTokens }
}

/** Fully-resolved engine behavior; built by {@link resolveApprovalPolicySpec}. */
export interface ApprovalPolicySpec {
  /** Clock, injectable for deterministic tests. */
  now: () => number
  /** Rule id minter (crypto random in production). */
  mintRuleId: () => string
  /**
   * Durable session log append. The engine's own state is the fold, so every
   * mutation awaits this append before becoming visible — a failed append
   * means no rule change happened.
   * @param event The event to append to the owning session's log.
   */
  append: (event: PolicyEngineEvent) => Promise<void>
}

/** Engine construction request; `append` and `mintRuleId` are required. */
export interface ApprovalPolicySpecRequest {
  /** Clock, injectable for deterministic tests. @default Date.now */
  now?: () => number
  /** Rule id minter (crypto random in production). */
  mintRuleId: () => string
  /** Durable session log append; see {@link ApprovalPolicySpec.append}. */
  append: (event: PolicyEngineEvent) => Promise<void>
}

/**
 * Resolve engine behavior explicitly.
 * @param request Construction request.
 * @returns The fully-resolved engine spec.
 */
export function resolveApprovalPolicySpec(request: ApprovalPolicySpecRequest): ApprovalPolicySpec {
  return {
    now: request.now ?? Date.now,
    mintRuleId: request.mintRuleId,
    append: request.append,
  }
}

/** Live, append-backed policy engine for one session. */
export interface ApprovalPolicyEngine {
  /**
   * Create a rule from an explicit grant act. Returns `undefined` when no
   * honest class is derivable — the caller must not offer "allow same kind".
   * An active rule of the same class is returned as-is (set-valued dedup: the
   * repeated grant appends nothing), and a session at
   * {@link MAX_ACTIVE_POLICY_RULES} refuses with {@link PolicyRuleLimitError}.
   * @param toolName Tool whose ask is being settled.
   * @param reason Reason of the ask being settled.
   * @param grantedBy Who created the rule.
   * @returns The created (or deduplicated) rule after any event crossed the durable append.
   */
  grant(toolName: string, reason: string | undefined, grantedBy: 'user' | 'operator'): Promise<PolicyRule | undefined>
  /**
   * Revoke an active rule. Unknown ids are a no-op returning `false`.
   * @param ruleId Rule to revoke.
   * @returns Whether a revocation event was appended.
   */
  revoke(ruleId: string): Promise<boolean>
  /**
   * Claim one approval request when a rule matches: appends the
   * `approval/rule-applied` provenance event and returns the rule, so the
   * answerer can settle the request as `'allowed-once'` with the service's
   * audit pair intact. Returns `undefined` when nothing matches (ask).
   * @param approvalId The pending approval's id (provenance join only).
   * @param toolName Tool the ask names.
   * @param reason Producer-supplied reason string, when present.
   * @returns The matched rule after its provenance event crossed the append.
   */
  claim(approvalId: string, toolName: string, reason?: string): Promise<PolicyRule | undefined>
  /**
   * Set the session's token ceiling (last-wins at the fold).
   * @param maxTotalTokens Positive safe-integer ceiling over all four token classes.
   * @returns The budget event after it crossed the durable append.
   */
  setBudget(maxTotalTokens: number): Promise<SessionBudgetEvent>
  /** Active rules in grant order (management surface projection). */
  list(): readonly PolicyRule[]
  /** The current budget event, when set. */
  budget(): SessionBudgetEvent | undefined
  /**
   * Fold one externally-observed event (log replay or live stream) into the
   * engine. Malformed input is ignored as absent.
   * @param raw The raw log entry.
   */
  observe(raw: unknown): void
}

/**
 * Create the engine for one session, seeded from the session's folded log
 * prefix. Mutations serialize through one promise chain so the fold and the
 * durable log can never disagree about order.
 * @param spec Fully-resolved engine behavior.
 * @param seedEvents Ordered raw log entries to fold before serving.
 * @returns The ready engine.
 */
export function createApprovalPolicyEngine(
  spec: ApprovalPolicySpec,
  seedEvents: readonly unknown[] = [],
): ApprovalPolicyEngine {
  const state = foldPolicyEvents(seedEvents)
  const rules = new Map<string, PolicyRule>(state.rules.map(rule => [rule.ruleId, rule]))
  let budget = state.budget
  let chain: Promise<void> = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = chain.then(operation)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function sameClass(left: PolicyRuleClass, right: PolicyRuleClass): boolean {
    if (left.kind !== right.kind || left.toolName !== right.toolName) return false
    return left.kind === 'tool' || (right.kind === 'escalate' && left.mode === right.mode)
  }

  return {
    grant(toolName, reason, grantedBy) {
      return enqueue(async () => {
        const derived = deriveApprovalClass(toolName, reason)
        if (derived === undefined) return undefined
        const existing = [...rules.values()].find(rule => sameClass(rule.ruleClass, derived))
        if (existing !== undefined) return existing
        if (rules.size >= MAX_ACTIVE_POLICY_RULES) throw new PolicyRuleLimitError()
        const event: ApprovalRuleGrantedEvent = {
          type: 'approval/rule',
          action: 'granted',
          ruleId: spec.mintRuleId(),
          classKind: derived.kind,
          toolName: derived.toolName,
          ...(derived.kind === 'escalate' ? { classMode: derived.mode } : {}),
          grantedBy,
          grantedAtMs: spec.now(),
        }
        if (!boundedId(event.ruleId)) {
          throw new Error('rule id minter produced an invalid id')
        }
        await spec.append(event)
        const rule: PolicyRule = {
          ruleId: event.ruleId,
          ruleClass: derived,
          grantedBy,
          grantedAtMs: event.grantedAtMs,
        }
        rules.set(rule.ruleId, rule)
        return rule
      })
    },

    revoke(ruleId) {
      return enqueue(async () => {
        if (!rules.has(ruleId)) return false
        await spec.append({ type: 'approval/rule', action: 'revoked', ruleId, revokedAtMs: spec.now() })
        rules.delete(ruleId)
        return true
      })
    },

    claim(approvalId, toolName, reason) {
      return enqueue(async () => {
        const rule = matchPolicyRule([...rules.values()], toolName, reason)
        if (rule === undefined) return undefined
        await spec.append({ type: 'approval/rule-applied', approvalId, ruleId: rule.ruleId, appliedAtMs: spec.now() })
        return rule
      })
    },

    setBudget(maxTotalTokens) {
      return enqueue(async () => {
        if (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens < 1) {
          throw new Error('session budget must be a positive safe integer')
        }
        const event: SessionBudgetEvent = { type: 'session/budget', maxTotalTokens, setAtMs: spec.now() }
        await spec.append(event)
        budget = event
        return event
      })
    },

    list() {
      return [...rules.values()]
    },

    budget() {
      return budget
    },

    observe(raw) {
      const event = parseEvent(raw)
      if (event === undefined) return
      if (event.type === 'session/budget') {
        budget = event
        return
      }
      if (event.type === 'approval/rule-applied') return
      if (event.action === 'granted') {
        rules.set(event.ruleId, {
          ruleId: event.ruleId,
          ruleClass: event.classKind === 'escalate'
            ? { kind: 'escalate', toolName: event.toolName, mode: event.classMode as string }
            : { kind: 'tool', toolName: event.toolName },
          grantedBy: event.grantedBy,
          grantedAtMs: event.grantedAtMs,
        })
      } else {
        rules.delete(event.ruleId)
      }
    },
  }
}
