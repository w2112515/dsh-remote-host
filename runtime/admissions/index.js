// src/admissions.ts
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createApiRemoteAgentResolver } from "@deepseek-ai/dsh-api-remotes";
var name = "remote-admissions";
var inject = ["apiProxy", "agents", "sessions"];
function promptCorrelationOf(message) {
  const source = message.source;
  return source?.kind === "user" && typeof source.promptCorrelation === "string" ? source.promptCorrelation : void 0;
}
function currentSelection(ctx, agent) {
  const logged = agent.session.requestHeader?.()?.config;
  if (logged !== void 0) {
    return {
      provider: logged.provider,
      model: logged.model,
      ...logged.reasoningEffort === void 0 ? {} : { reasoningEffort: logged.reasoningEffort }
    };
  }
  const model = ctx.get("agentDefaultModel");
  if (model?.currentSelection !== void 0) return model.currentSelection();
  return { provider: "deepseek", model: "deepseek-chat" };
}
function sameSelection(left, right) {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}
function routeServed(ctx, provider) {
  const llm = ctx.get("llm");
  return llm?.listProviders === void 0 || llm.listProviders().some((entry) => entry.id === provider);
}
function activeTurn(events) {
  let open;
  for (const event of events) {
    if (event.type === "turn/start") {
      if (open !== void 0) return void 0;
      open = event.data.turn;
    } else if (event.type === "turn/end") {
      if (open !== event.data.turn) return void 0;
      open = void 0;
    }
  }
  return open;
}
function inspectStopEvents(events, target) {
  const terminals = events.filter((event) => event.type === "turn/end" && event.data.turn === target.turn);
  if (terminals.length === 0) return { kind: "absent" };
  if (terminals.length !== 1) return { kind: "conflict" };
  const terminal = terminals[0];
  if (terminal === void 0 || typeof terminal.seq !== "number") return { kind: "conflict" };
  return terminal.data.reason?.kind === "aborted" && terminal.data.reason.reason?.kind === "user" ? { kind: "stopped", turn: target.turn, turnEndSeq: terminal.seq } : { kind: "ended-other", turn: target.turn, turnEndSeq: terminal.seq };
}
function attach(target, key, value) {
  try {
    ;
    target[key] = value;
  } catch {
    Object.defineProperty(target, key, {
      value,
      configurable: true,
      enumerable: true,
      writable: true
    });
  }
}
function apply(ctx) {
  const model = ctx.get("agentDefaultModel");
  const agentFor = createApiRemoteAgentResolver(ctx, {
    agentOptions: () => {
      const selection = model?.currentSelection?.() ?? { provider: "deepseek", model: "deepseek-chat" };
      return { provider: selection.provider, model: selection.model };
    }
  });
  const promptAdmissions = {
    async prepareText(request) {
      if (request.images !== void 0 && request.images.length > 0) {
        return {
          ok: false,
          error: {
            code: "attachment-error",
            message: "this admissions overlay does not admit images",
            details: { reason: "IMAGES_UNSUPPORTED" }
          }
        };
      }
      const found = await agentFor(request.sessionId);
      if ("error" in found) {
        console.error(`remote-admissions: agentFor ${found.error.code} ${found.error.message}`);
        return { ok: false, error: found.error };
      }
      const agent = found.agent;
      const selection = { ...currentSelection(ctx, agent) };
      if (!routeServed(ctx, selection.provider)) {
        return {
          ok: false,
          error: {
            code: "model-unavailable",
            message: `no adapter serves provider "${selection.provider}"`,
            details: { provider: selection.provider, model: selection.model }
          }
        };
      }
      const message = createUserMessage({
        content: [{ type: "text", text: request.text }],
        source: { kind: "user", promptCorrelation: request.correlation }
      });
      let used = false;
      return {
        ok: true,
        prepared: {
          admit() {
            if (used) {
              return {
                ok: false,
                error: {
                  code: "agent-busy",
                  message: "prepared prompt admission was already used",
                  details: { reason: "prepared admission is one-shot" }
                }
              };
            }
            used = true;
            if (ctx.agents.get(request.sessionId) !== agent || !sameSelection(selection, currentSelection(ctx, agent))) {
              return {
                ok: false,
                error: {
                  code: "agent-busy",
                  message: "prepared prompt admission became stale",
                  details: { reason: "agent lifecycle or model selection changed" }
                }
              };
            }
            const firstNewEvent = agent.session.events.length;
            try {
              agent.send(message, "next-turn", true);
            } catch (error) {
              return {
                ok: false,
                error: { code: "agent-busy", message: "prompt rejected", details: { reason: String(error) } }
              };
            }
            const insertion = agent.session.events.slice(firstNewEvent).filter(
              (event) => event.type === "agent/inbox/spliced" && event.data.inserted?.some(
                (item) => item.id === message.id && promptCorrelationOf(item) === request.correlation
              )
            );
            if (insertion.length !== 1) {
              throw new Error(`remote-admissions: prompt admission produced ${String(insertion.length)} insertions`);
            }
            const inboxInsertion = insertion[0];
            if (inboxInsertion === void 0) throw new Error("remote-admissions: inbox insertion disappeared");
            const session = agent.session;
            return {
              ok: true,
              receipt: {
                correlation: request.correlation,
                messageId: message.id,
                sessionEventSeq: inboxInsertion.seq,
                flush: () => ctx.sessions.flush(session),
                wake: () => {
                  agent.wakePending?.();
                }
              }
            };
          }
        }
      };
    },
    async inspect(sessionId, correlation) {
      const live = ctx.sessions.get(sessionId);
      const liveInsertions = live?.events?.flatMap(
        (event) => event.type === "agent/inbox/spliced" ? (event.data.inserted ?? []).filter((message) => promptCorrelationOf(message) === correlation) : []
      ) ?? [];
      if (liveInsertions.length > 1) return { kind: "conflict" };
      const persistence = ctx.get("sessionPersistence");
      if (persistence === void 0) {
        if (liveInsertions.length === 1) return { kind: "pending" };
        throw new Error("remote-admissions: durable prompt inspection requires session persistence");
      }
      const { events } = await persistence.readFrom(sessionId, 0);
      const insertions = [];
      const messageIds = /* @__PURE__ */ new Set();
      for (const event of events ?? []) {
        if (event.type === "agent/inbox/spliced") {
          for (const message of event.data.inserted ?? []) {
            if (promptCorrelationOf(message) !== correlation) continue;
            insertions.push({ messageId: message.id, sessionEventSeq: event.seq });
            messageIds.add(message.id);
          }
          continue;
        }
        if (event.type === "user/message" && promptCorrelationOf(event.data) === correlation && event.data.id) {
          messageIds.add(event.data.id);
        }
      }
      if (insertions.length === 0) return liveInsertions.length === 1 ? { kind: "pending" } : { kind: "absent" };
      if (insertions.length !== 1 || messageIds.size !== 1) return { kind: "conflict" };
      const insertion = insertions[0];
      if (insertion === void 0) return { kind: "conflict" };
      if (!messageIds.has(insertion.messageId)) return { kind: "conflict" };
      return {
        kind: "committed",
        correlation,
        messageId: insertion.messageId,
        sessionEventSeq: insertion.sessionEventSeq,
        pending: !(events ?? []).some(
          (event) => event.type === "user/message" && event.data.id === insertion.messageId && promptCorrelationOf(event.data) === correlation
        )
      };
    },
    async wakeCorrelated(sessionId) {
      const found = await agentFor(sessionId);
      if ("error" in found) throw new Error(found.error.message);
      found.agent.wakePending?.();
      return true;
    }
  };
  const stopAdmissions = {
    prepare(target) {
      const agent = ctx.agents.get(target.sessionId);
      const root = agent !== void 0 && ctx.agents.roots().includes(agent);
      if (agent === void 0 || !root) {
        return Promise.resolve({
          ok: false,
          error: {
            code: "session-not-found",
            message: `session "${target.sessionId}" has no stoppable root Agent`,
            details: { sessionId: target.sessionId }
          }
        });
      }
      if (agent.status !== "running" || activeTurn(agent.session.events) !== target.turn) {
        return Promise.resolve({
          ok: false,
          error: {
            code: "agent-busy",
            message: "the requested activity revision is no longer active",
            details: { reason: "stale or idle activity revision" }
          }
        });
      }
      let used = false;
      return Promise.resolve({
        ok: true,
        prepared: {
          admit() {
            if (used) {
              return {
                ok: false,
                error: { code: "agent-busy", message: "prepared stop admission was already used", details: {} }
              };
            }
            used = true;
            const session = agent.session;
            agent.cancel?.({ kind: "user" }, { keepInbox: true });
            return {
              ok: true,
              receipt: {
                target: Object.freeze({ ...target }),
                async settle() {
                  await agent.whenIdle?.();
                  const durable = await ctx.sessions.flush(session);
                  const inspection = inspectStopEvents(session.events, target);
                  return { inspection, durable, currentRunning: ctx.agents.get(target.sessionId)?.status === "running" };
                }
              }
            };
          }
        }
      });
    },
    async inspect(target) {
      const live = ctx.sessions.get(target.sessionId);
      if (live?.events !== void 0) return inspectStopEvents(live.events, target);
      const persistence = ctx.get("sessionPersistence");
      if (persistence?.readFrom === void 0) return { kind: "absent" };
      try {
        const { events } = await persistence.readFrom(target.sessionId, 0);
        return inspectStopEvents(events ?? [], target);
      } catch {
        return { kind: "absent" };
      }
    }
  };
  attach(ctx.apiProxy, "promptAdmissions", promptAdmissions);
  attach(ctx.apiProxy, "stopAdmissions", stopAdmissions);
  ctx.provide("remotePromptAdmissions", promptAdmissions);
  ctx.logger.warn("remote-admissions: attached promptAdmissions/stopAdmissions; no approval face on this Host");
  console.error("remote-admissions: attached promptAdmissions/stopAdmissions (approval not claimed)");
}
export {
  apply,
  inject,
  name
};
