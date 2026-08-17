/**
 * Session approval-policy owner (S-policy, ADR-006): the Host-side module
 * that owns the durable policy facts and every seam they cross. It declares
 * the session event vocabulary (`approval/rule`, `approval/rule-applied`,
 * `session/budget`), registers the `approvalPolicy` projection unit, answers
 * the `approval/request` waterfall ahead of the interactive channel, and
 * provides `ctx.remoteApprovalPolicy` — the face the remote-command executor
 * consumes for grant/revoke/budget mutations and the send gate. The engine
 * mathematics live in `approval-policy.ts`; this module binds them to one
 * session store, one projection registry, and one event bus.
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { ZodType } from 'zod'
import type { Session, SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { HostApprovalPolicy } from '@w2112515/dsh-remote-host/command'
import {
  applyPolicyEvent,
  createApprovalPolicyEngine,
  evaluateBudget,
  matchPolicyRule,
  PolicyRuleLimitError,
  resolveApprovalPolicySpec,
} from './approval-policy.ts'
import type {
  ApprovalPolicyEngine,
  PolicyEngineEvent,
  PolicyFold,
  PolicyRule,
  PolicyTokenUsage,
} from './approval-policy.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A session-scoped approval auto-grant rule changed — log-only audit and
     * fold input (like `approval/policy`; NOT a surface event, never in the
     * model transcript). `action: 'granted'` carries the honest rule class
     * derived at decision time (`classKind` `'escalate'` narrows to the
     * sandbox `classMode`, `'tool'` covers every other ask for `toolName`);
     * `action: 'revoked'` retires the rule by id. The active set is the fold
     * of granted-minus-revoked; rule ids are minted once and never reused.
     */
    'approval/rule':
      | {
        action: 'granted'
        ruleId: string
        classKind: 'escalate' | 'tool'
        toolName: string
        classMode?: string
        grantedBy: 'user' | 'operator'
        grantedAtMs: number
      }
      | {
        action: 'revoked'
        ruleId: string
        revokedAtMs: number
      }
    /**
     * Provenance join: one pending approval was auto-granted by an active
     * rule instead of a human answer — log-only audit. `approvalId` pairs
     * with the service's `approval/asked`/`approval/decided` audit pair;
     * `ruleId` names the rule that claimed it.
     */
    'approval/rule-applied': {
      approvalId: string
      ruleId: string
      appliedAtMs: number
    }
    /**
     * The session's token budget ceiling was set — log-only, last-wins at
     * the fold (the `approval/policy` precedent). The ceiling binds the
     * remote `send_input` gate once cumulative usage (all four disjoint
     * token classes) reaches `maxTotalTokens`; absence means no budget.
     */
    'session/budget': {
      maxTotalTokens: number
      setAtMs: number
    }
  }
}

/** One wire-flat active rule row served by the `approvalPolicy` projection. */
export interface ApprovalPolicyRuleRow {
  /** Owner-minted stable rule id (hex, never reused). */
  ruleId: string
  /** Rule class discriminant: sandbox escalation or whole-tool. */
  classKind: 'escalate' | 'tool'
  /** The tool the rule auto-grants. */
  toolName: string
  /** Escalation target mode; present iff `classKind` is `'escalate'`. */
  classMode?: string
  /** Who created the rule. */
  grantedBy: 'user' | 'operator'
  /** Grant timestamp (owner clock). */
  grantedAtMs: number
}

/** Whole-value `approvalPolicy` projection: active rules plus the optional budget. */
export interface ApprovalPolicyProjection {
  /** Active (granted, not revoked) rules in grant order. */
  rules: ApprovalPolicyRuleRow[]
  /** The current token ceiling, when one was set. */
  budget?: {
    /** Positive ceiling over the four disjoint token classes. */
    maxTotalTokens: number
    /** When the ceiling was set (owner clock). */
    setAtMs: number
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Active approval auto-grant rules and the session token budget (S-policy). */
    approvalPolicy: ApprovalPolicyProjection
  }
}

// Cast for the optional fields: under exactOptionalPropertyTypes zod infers
// `T | undefined` where the interface declares absent-or-present fields.
const approvalPolicyProjectionSchema = z.object({
  rules: z.array(z.object({
    ruleId: z.string().min(1),
    classKind: z.enum(['escalate', 'tool']),
    toolName: z.string().min(1),
    classMode: z.string().min(1).optional(),
    grantedBy: z.enum(['user', 'operator']),
    grantedAtMs: z.number().int().nonnegative(),
  }).strict()),
  budget: z.object({
    maxTotalTokens: z.number().int().positive(),
    setAtMs: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict() as unknown as ZodType<ApprovalPolicyProjection>

/** Flatten one nested engine rule into its wire-flat projection row. */
function ruleRow(rule: PolicyRule): ApprovalPolicyRuleRow {
  return {
    ruleId: rule.ruleId,
    classKind: rule.ruleClass.kind,
    toolName: rule.ruleClass.toolName,
    ...(rule.ruleClass.kind === 'escalate' ? { classMode: rule.ruleClass.mode } : {}),
    grantedBy: rule.grantedBy,
    grantedAtMs: rule.grantedAtMs,
  }
}

/**
 * The `approvalPolicy` projection unit: folds the owner's three event types
 * into the active-rules-plus-budget whole value. State is the plain-JSON
 * {@link PolicyFold}; unrelated events return the same reference (zero
 * downstream work per the registry contract).
 */
export const approvalPolicyProjectionDefinition: ProjectionDefinition<'approvalPolicy', PolicyFold> = {
  key: 'approvalPolicy',
  schema: approvalPolicyProjectionSchema,
  init: () => ({ rules: [] }),
  apply: (state, event) => {
    if (event.type !== 'approval/rule' && event.type !== 'session/budget') return state
    return applyPolicyEvent(state, { type: event.type, ...(event.data as Record<string, unknown>) })
  },
  view: fold => ({
    rules: fold.rules.map(ruleRow),
    ...(fold.budget === undefined
      ? {}
      : { budget: { maxTotalTokens: fold.budget.maxTotalTokens, setAtMs: fold.budget.setAtMs } }),
  }),
  stateVersion: 1,
}

/** Append one engine event to the owning session's log (type key split per the append signature). */
function appendPolicyEvent(session: Session, event: PolicyEngineEvent): void {
  if (event.type === 'approval/rule') {
    const { type: _type, ...data } = event
    session.append('approval/rule', data)
  } else if (event.type === 'approval/rule-applied') {
    const { type: _type, ...data } = event
    session.append('approval/rule-applied', data)
  } else {
    const { type: _type, ...data } = event
    session.append('session/budget', data)
  }
}

/**
 * Find the newest still-undecided `approval/asked` audit event this request
 * produced (the service appends it before dispatching the waterfall). The
 * callId pairing is symmetric — a callId-bearing ask only takes its own
 * call's record, a callId-less ask only a callId-less record — mirroring the
 * interactive channel's join, plus a toolName guard. Absence means the
 * request bypassed the service's audit path: not this answerer's question.
 * @param events The session log at dispatch time.
 * @param toolName The tool the pending request names.
 * @param callId The exact tool call being decided, when the asker had one.
 * @returns The ask's audit id, or `undefined` without a join.
 */
function findPendingApprovalId(
  events: readonly SessionEvent[],
  toolName: string,
  callId: string | undefined,
): string | undefined {
  const decided = new Set<string>()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    // The index is in bounds by the loop guard; the cast restores the
    // discriminated-union narrowing that an `T | undefined` element blocks.
    const event = events[i] as SessionEvent
    if (event.type === 'approval/decided') {
      decided.add(String(event.data.id))
    } else if (event.type === 'approval/asked') {
      if (decided.has(String(event.data.id))) continue
      if ((callId ?? null) !== (event.data.callId === undefined ? null : String(event.data.callId))) continue
      if (event.data.toolName !== toolName) continue
      return String(event.data.id)
    }
  }
  return undefined
}

/** Structurally validate the `tokenUsage` projection value (absent or malformed reads as unmeasurable). */
function usageFrom(values: Record<string, unknown>): PolicyTokenUsage | undefined {
  const raw = values['tokenUsage']
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const counts = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  if (
    !counts(record.uncachedInputTokens) || !counts(record.outputTokens)
    || !counts(record.cacheReadTokens) || !counts(record.cacheWriteTokens)
  ) {
    return undefined
  }
  return {
    uncachedInputTokens: record.uncachedInputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
  }
}

/**
 * Install the policy owner: the per-session engine cache, the projection
 * unit (under `sessionProjections` injection so headless assemblies stay
 * unaffected), the prepended `approval/request` answerer, and the
 * `ctx.remoteApprovalPolicy` service face. Everything rides the calling
 * plugin's fiber — unloading host-remote retires the answerer, the unit,
 * and the face together.
 * @param ctx The host-remote plugin context.
 */
export function installApprovalPolicyOwner(ctx: Context): void {
  const engines = new WeakMap<Session, ApprovalPolicyEngine>()

  /**
   * The engine for one live session, seeded from its folded log on first
   * touch. Appends go through the session log and the store's flush
   * durability barrier — a failed append or flush rejects the mutation, so
   * the engine and the durable log can never disagree.
   */
  const engineFor = (session: Session): ApprovalPolicyEngine => {
    let engine = engines.get(session)
    if (engine === undefined) {
      engine = createApprovalPolicyEngine(
        resolveApprovalPolicySpec({
          mintRuleId: () => randomBytes(16).toString('hex'),
          append: async (event) => {
            const store: SessionStore | undefined = ctx.get('sessions')
            if (store === undefined) throw new Error('session store is not composed')
            appendPolicyEvent(session, event)
            await store.flush(session)
          },
        }),
        session.events.map(entry => ({ type: entry.type, ...(entry.data as Record<string, unknown>) })),
      )
      engines.set(session, engine)
    }
    return engine
  }

  const sessionFor = (sessionId: SessionId): Session | undefined =>
    ctx.get('sessions')?.get(sessionId)

  // Projection unit: registered only when the generic registry is composed.
  ctx.inject(['sessionProjections'], (projectionCtx: Context) => {
    projectionCtx.sessionProjections.register(approvalPolicyProjectionDefinition)
  })

  // Policy answerer: ahead of the interactive channel (prepend), so an
  // active rule settles the ask without surfacing a prompt. Every non-claim
  // path — no rules, no audit join, no match, or a failed provenance append
  // — falls through to the next answerer (fail-closed to the human ask).
  ctx.on('approval/request', async (req, next) => {
    const session = req.agent.session
    const engine = engineFor(session)
    const rules = engine.list()
    if (rules.length === 0) return next()
    if (matchPolicyRule(rules, req.toolName, req.reason) === undefined) return next()
    const approvalId = findPendingApprovalId(
      session.events,
      req.toolName,
      req.callId === undefined ? undefined : String(req.callId),
    )
    if (approvalId === undefined) return next()
    let claimed: PolicyRule | undefined
    try {
      claimed = await engine.claim(approvalId, req.toolName, req.reason)
    } catch {
      return next()
    }
    return claimed === undefined ? next() : 'allowed-once'
  }, true)

  const face: HostApprovalPolicy = {
    async grantForApproval(input) {
      const session = sessionFor(input.sessionId)
      if (session === undefined) return { ok: false, errorCode: 'session-not-found' }
      let rule: PolicyRule | undefined
      try {
        rule = await engineFor(session).grant(input.toolName, input.reason, 'user')
      } catch (error) {
        if (error instanceof PolicyRuleLimitError) return { ok: false, errorCode: 'approval-rule-limit' }
        throw error
      }
      if (rule === undefined) return { ok: false, errorCode: 'approval-class-underivable' }
      return { ok: true, ruleId: rule.ruleId }
    },

    async revokeRule(input) {
      const session = sessionFor(input.sessionId)
      if (session === undefined) return { ok: false, errorCode: 'session-not-found' }
      const revoked = await engineFor(session).revoke(input.ruleId)
      return revoked ? { ok: true } : { ok: false, errorCode: 'rule-not-found' }
    },

    isRuleActive(input) {
      const session = sessionFor(input.sessionId)
      if (session === undefined) return false
      return engineFor(session).list().some(rule => rule.ruleId === input.ruleId)
    },

    async setBudget(input) {
      const session = sessionFor(input.sessionId)
      if (session === undefined) return { ok: false, errorCode: 'session-not-found' }
      if (!Number.isSafeInteger(input.maxTotalTokens) || input.maxTotalTokens < 1) {
        return { ok: false, errorCode: 'invalid-budget' }
      }
      // A ceiling that cannot bind is refused up front: without the
      // tokenUsage projection the gate could never evaluate, and accepting
      // the budget would silently promise an enforcement that cannot happen.
      const registry = ctx.get('sessionProjections')
      const values = registry === undefined
        ? undefined
        : registry.snapshot(session).values as unknown as Record<string, unknown>
      if (values === undefined || usageFrom(values) === undefined) {
        return { ok: false, errorCode: 'budget-meter-unavailable' }
      }
      await engineFor(session).setBudget(input.maxTotalTokens)
      return { ok: true }
    },

    currentBudget(sessionId) {
      const session = sessionFor(sessionId)
      if (session === undefined) return undefined
      return engineFor(session).budget()?.maxTotalTokens
    },

    evaluateBudget(sessionId) {
      const session = sessionFor(sessionId)
      if (session === undefined) return undefined
      const budget = engineFor(session).budget()
      if (budget === undefined) return undefined
      const registry = ctx.get('sessionProjections')
      if (registry === undefined) return undefined
      const usage = usageFrom(registry.snapshot(session).values)
      // An unmeasurable session cannot honestly gate: report no evaluable
      // budget instead of guessing in either direction.
      if (usage === undefined) return undefined
      return evaluateBudget(budget, usage)
    },
  }

  ctx.provide('remoteApprovalPolicy', face)
}
