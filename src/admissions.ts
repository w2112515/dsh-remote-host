/**
 * Prompt/stop faces for a Host whose shipped apiProxy has no promptAdmissions.
 * Does not register user-questions. Does not attach a fake approval list.
 * @module @dsh-remote/host/admissions
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createApiRemoteAgentResolver } from '@deepseek-ai/dsh-api-remotes'

export const name = 'remote-admissions'
export const inject = ['apiProxy', 'agents', 'sessions']

function promptCorrelationOf(message: { source?: { kind?: string; promptCorrelation?: unknown } }): string | undefined {
  const source = message.source
  return source?.kind === 'user' && typeof source.promptCorrelation === 'string'
    ? source.promptCorrelation
    : undefined
}

function currentSelection(ctx: Context, agent: {
  session: { requestHeader?: () => { config?: { provider: string; model: string; reasoningEffort?: string } } }
}): { provider: string; model: string; reasoningEffort?: string } {
  const logged = agent.session.requestHeader?.()?.config
  if (logged !== undefined) {
    return {
      provider: logged.provider,
      model: logged.model,
      ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort }),
    }
  }
  const model = ctx.get('agentDefaultModel') as {
    currentSelection?: () => { provider: string; model: string; reasoningEffort?: string }
  } | undefined
  if (model?.currentSelection !== undefined) return model.currentSelection()
  return { provider: 'deepseek', model: 'deepseek-chat' }
}

function sameSelection(
  left: { provider: string; model: string; reasoningEffort?: string },
  right: { provider: string; model: string; reasoningEffort?: string },
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

function routeServed(ctx: Context, provider: string): boolean {
  const llm = ctx.get('llm') as { listProviders?: () => Array<{ id: string }> } | undefined
  return llm?.listProviders === undefined || llm.listProviders().some(entry => entry.id === provider)
}

function activeTurn(events: ReadonlyArray<{ type: string; data: { turn: number } }>): number | undefined {
  let open: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (open !== undefined) return undefined
      open = event.data.turn
    } else if (event.type === 'turn/end') {
      if (open !== event.data.turn) return undefined
      open = undefined
    }
  }
  return open
}

type StopEvent = {
  type: string
  seq?: number
  data: {
    turn?: number
    reason?: { kind?: string; reason?: { kind?: string } }
  }
}

function inspectStopEvents(
  events: readonly StopEvent[],
  target: { turn: number },
): { kind: 'absent' } | { kind: 'stopped'; turn: number; turnEndSeq: number } | { kind: 'ended-other'; turn: number; turnEndSeq: number } | { kind: 'conflict' } {
  const terminals = events.filter(event => event.type === 'turn/end' && event.data.turn === target.turn)
  if (terminals.length === 0) return { kind: 'absent' }
  if (terminals.length !== 1) return { kind: 'conflict' }
  const terminal = terminals[0]
  if (terminal === undefined || typeof terminal.seq !== 'number') return { kind: 'conflict' }
  return terminal.data.reason?.kind === 'aborted' && terminal.data.reason.reason?.kind === 'user'
    ? { kind: 'stopped', turn: target.turn, turnEndSeq: terminal.seq }
    : { kind: 'ended-other', turn: target.turn, turnEndSeq: terminal.seq }
}

function attach(target: object, key: string, value: unknown): void {
  try {
    ;(target as Record<string, unknown>)[key] = value
  } catch {
    Object.defineProperty(target, key, {
      value, configurable: true, enumerable: true, writable: true,
    })
  }
}

export function apply(ctx: Context): void {
  const model = ctx.get('agentDefaultModel') as {
    currentSelection?: () => { provider: string; model: string }
  } | undefined
  const agentFor = createApiRemoteAgentResolver(ctx, {
    agentOptions: () => {
      const selection = model?.currentSelection?.() ?? { provider: 'deepseek', model: 'deepseek-chat' }
      return { provider: selection.provider, model: selection.model }
    },
  })

  const promptAdmissions = {
    async prepareText(request: {
      sessionId: string
      text: string
      correlation: string
      images?: readonly string[]
    }) {
      if (request.images !== undefined && request.images.length > 0) {
        return {
          ok: false as const,
          error: {
            code: 'attachment-error',
            message: 'this admissions overlay does not admit images',
            details: { reason: 'IMAGES_UNSUPPORTED' },
          },
        }
      }
      const found = await agentFor(request.sessionId)
      if ('error' in found) {
        console.error(`remote-admissions: agentFor ${found.error.code} ${found.error.message}`)
        return { ok: false as const, error: found.error }
      }
      const agent = found.agent as {
        wakePending?: () => void
        send: (message: unknown, mode: string, wake: boolean) => void
        session: {
          events: Array<{ type: string; seq: number; data: { inserted?: Array<{ id: string; source?: unknown }> } }>
          requestHeader?: () => { config?: { provider: string; model: string; reasoningEffort?: string } }
        }
        status?: string
        cancel?: (reason: unknown, opts?: unknown) => void
        whenIdle?: () => Promise<void>
        inbox?: unknown
      }
      const selection = { ...currentSelection(ctx, agent) }
      if (!routeServed(ctx, selection.provider)) {
        return {
          ok: false as const,
          error: {
            code: 'model-unavailable',
            message: `no adapter serves provider "${selection.provider}"`,
            details: { provider: selection.provider, model: selection.model },
          },
        }
      }
      const message = createUserMessage({
        content: [{ type: 'text' as const, text: request.text }],
        source: { kind: 'user', promptCorrelation: request.correlation },
      })
      let used = false
      return {
        ok: true as const,
        prepared: {
          admit() {
            if (used) {
              return {
                ok: false as const,
                error: {
                  code: 'agent-busy',
                  message: 'prepared prompt admission was already used',
                  details: { reason: 'prepared admission is one-shot' },
                },
              }
            }
            used = true
            if (ctx.agents.get(request.sessionId) !== agent
              || !sameSelection(selection, currentSelection(ctx, agent))) {
              return {
                ok: false as const,
                error: {
                  code: 'agent-busy',
                  message: 'prepared prompt admission became stale',
                  details: { reason: 'agent lifecycle or model selection changed' },
                },
              }
            }
            const firstNewEvent = agent.session.events.length
            try {
              agent.send(message, 'next-turn', true)
            } catch (error: unknown) {
              return {
                ok: false as const,
                error: { code: 'agent-busy', message: 'prompt rejected', details: { reason: String(error) } },
              }
            }
            const insertion = agent.session.events.slice(firstNewEvent).filter(event =>
              event.type === 'agent/inbox/spliced'
              && event.data.inserted?.some(item =>
                item.id === message.id && promptCorrelationOf(item) === request.correlation,
              ),
            )
            if (insertion.length !== 1) {
              throw new Error(`remote-admissions: prompt admission produced ${String(insertion.length)} insertions`)
            }
            const inboxInsertion = insertion[0]
            if (inboxInsertion === undefined) throw new Error('remote-admissions: inbox insertion disappeared')
            const session = agent.session
            return {
              ok: true as const,
              receipt: {
                correlation: request.correlation,
                messageId: message.id,
                sessionEventSeq: inboxInsertion.seq,
                flush: () => ctx.sessions.flush(session),
                wake: () => { agent.wakePending?.() },
              },
            }
          },
        },
      }
    },

    async inspect(sessionId: string, correlation: string) {
      const live = ctx.sessions.get(sessionId) as {
        events?: Array<{
          type: string
          seq: number
          data: { inserted?: Array<{ id: string; source?: unknown }>; id?: string; source?: unknown }
        }>
      } | undefined
      const liveInsertions = live?.events?.flatMap(event =>
        event.type === 'agent/inbox/spliced'
          ? (event.data.inserted ?? []).filter(message => promptCorrelationOf(message) === correlation)
          : [],
      ) ?? []
      if (liveInsertions.length > 1) return { kind: 'conflict' as const }
      const persistence = ctx.get('sessionPersistence') as {
        readFrom: (id: string, from: number) => Promise<{ events: NonNullable<NonNullable<typeof live>['events']> }>
      } | undefined
      if (persistence === undefined) {
        if (liveInsertions.length === 1) return { kind: 'pending' as const }
        throw new Error('remote-admissions: durable prompt inspection requires session persistence')
      }
      const { events } = await persistence.readFrom(sessionId, 0)
      const insertions: Array<{ messageId: string; sessionEventSeq: number }> = []
      const messageIds = new Set<string>()
      for (const event of events ?? []) {
        if (event.type === 'agent/inbox/spliced') {
          for (const message of event.data.inserted ?? []) {
            if (promptCorrelationOf(message) !== correlation) continue
            insertions.push({ messageId: message.id, sessionEventSeq: event.seq })
            messageIds.add(message.id)
          }
          continue
        }
        if (event.type === 'user/message' && promptCorrelationOf(event.data) === correlation && event.data.id) {
          messageIds.add(event.data.id)
        }
      }
      if (insertions.length === 0) return liveInsertions.length === 1 ? { kind: 'pending' as const } : { kind: 'absent' as const }
      if (insertions.length !== 1 || messageIds.size !== 1) return { kind: 'conflict' as const }
      const insertion = insertions[0]
      if (insertion === undefined) return { kind: 'conflict' as const }
      if (!messageIds.has(insertion.messageId)) return { kind: 'conflict' as const }
      return {
        kind: 'committed' as const,
        correlation,
        messageId: insertion.messageId,
        sessionEventSeq: insertion.sessionEventSeq,
        pending: !(events ?? []).some(event =>
          event.type === 'user/message'
          && event.data.id === insertion.messageId
          && promptCorrelationOf(event.data) === correlation,
        ),
      }
    },

    async wakeCorrelated(sessionId: string) {
      const found = await agentFor(sessionId)
      if ('error' in found) throw new Error(found.error.message)
      ;(found.agent as { wakePending?: () => void }).wakePending?.()
      return true
    },
  }

  const stopAdmissions = {
    prepare(target: { sessionId: string; turn: number }) {
      const agent = ctx.agents.get(target.sessionId) as {
        status?: string
        session: { events: Array<{ type: string; data: { turn: number } }> }
        cancel?: (reason: unknown, opts?: unknown) => void
        whenIdle?: () => Promise<void>
      } | undefined
      const root = agent !== undefined && ctx.agents.roots().includes(agent)
      if (agent === undefined || !root) {
        return Promise.resolve({
          ok: false as const,
          error: {
            code: 'session-not-found',
            message: `session "${target.sessionId}" has no stoppable root Agent`,
            details: { sessionId: target.sessionId },
          },
        })
      }
      if (agent.status !== 'running' || activeTurn(agent.session.events) !== target.turn) {
        return Promise.resolve({
          ok: false as const,
          error: {
            code: 'agent-busy',
            message: 'the requested activity revision is no longer active',
            details: { reason: 'stale or idle activity revision' },
          },
        })
      }
      let used = false
      return Promise.resolve({
        ok: true as const,
        prepared: {
          admit() {
            if (used) {
              return {
                ok: false as const,
                error: { code: 'agent-busy', message: 'prepared stop admission was already used', details: {} },
              }
            }
            used = true
            const session = agent.session
            agent.cancel?.({ kind: 'user' }, { keepInbox: true })
            return {
              ok: true as const,
              receipt: {
                target: Object.freeze({ ...target }),
                async settle() {
                  await agent.whenIdle?.()
                  const durable = await ctx.sessions.flush(session)
                  const inspection = inspectStopEvents(session.events as StopEvent[], target)
                  return { inspection, durable, currentRunning: ctx.agents.get(target.sessionId)?.status === 'running' }
                },
              },
            }
          },
        },
      })
    },
    async inspect(target: { sessionId: string; turn: number }) {
      const live = ctx.sessions.get(target.sessionId) as { events?: StopEvent[] } | undefined
      if (live?.events !== undefined) return inspectStopEvents(live.events, target)
      const persistence = ctx.get('sessionPersistence') as {
        readFrom?: (id: string, from: number) => Promise<{ events?: StopEvent[] }>
      } | undefined
      if (persistence?.readFrom === undefined) return { kind: 'absent' as const }
      try {
        const { events } = await persistence.readFrom(target.sessionId, 0)
        return inspectStopEvents(events ?? [], target)
      } catch {
        return { kind: 'absent' as const }
      }
    },
  }

  attach(ctx.apiProxy, 'promptAdmissions', promptAdmissions)
  attach(ctx.apiProxy, 'stopAdmissions', stopAdmissions)
  ctx.provide('remotePromptAdmissions', promptAdmissions)
  ctx.logger.warn('remote-admissions: attached promptAdmissions/stopAdmissions; no approval face on this Host')
  console.error('remote-admissions: attached promptAdmissions/stopAdmissions (approval not claimed)')
}
