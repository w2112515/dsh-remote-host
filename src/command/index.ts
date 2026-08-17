/** Authenticated Remote command adapter over the Host ApiProxy admission seam. */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RpcId, type ApiProxy, type RpcResponse, type WorkspaceId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteCommandExecutor } from './executor.ts'
import type { HostApprovalPolicy, HostSessionAdmin, RemoteCommandService } from './types.ts'
import { bindRemoteCreateWorkspace } from './workspace-bind.ts'

export type * from './types.ts'
export { bindRemoteCreateWorkspace, sanitizeRemoteWorkspaceName } from './workspace-bind.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authenticated, idempotent Remote command owner. */
    remoteCommands: RemoteCommandService
    /**
     * Host session-policy owner (S-policy, ADR-006), provided by the
     * composing remote plugin; this package reads it lazily so deployments
     * without the policy owner still compose.
     */
    remoteApprovalPolicy: HostApprovalPolicy
  }
}

/** Stable Cordis function-plugin name. */
export const name = 'host-remote-command'
/** Transport-neutral DSH admission and durable command authority dependencies. */
export const inject = ['apiProxy', 'remoteControl']

/** No deployment tunables: wire policy and lease policy belong to their owning plugins. */
export interface Config {
  /** Caller-visible Stop settlement wait; the accepted owner continues after timeout. @default 30000 */
  stopSettlementTimeoutMs?: number
}
/** Bounded owner settlement policy. */
export const Config: z<Config> = z.object({
  stopSettlementTimeoutMs: z.number().step(1).min(1_000).max(300_000).default(30_000),
})

function request<P>(payload: P): { rpcId: RpcId; payload: P } {
  return { rpcId: RpcId(`remote-command-${randomUUID()}`), payload }
}

function errorCodeOf<T>(response: RpcResponse<T>, fallback: string): string {
  if (response.result.ok) return fallback
  return response.result.error.code
}

/**
 * Narrow ApiProxy session-admin face (S-mode-select, S-session-admin). Only
 * create, blank-only preset select, next-step model select, and
 * preallocated-child fork cross; the privileged authoring verbs stay
 * loopback-pinned inside the Host.
 */
async function mkdirChild(parentPath: string, name: string): Promise<string> {
  const childPath = join(parentPath, name)
  try {
    await mkdir(childPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return childPath
}

function createHostSessionAdmin(apiProxy: ApiProxy): HostSessionAdmin {
  const admin: HostSessionAdmin = {
    async createSession(input: {
      readonly sessionId: SessionId
      readonly agentPreset?: string
      readonly workspaceId?: string
      readonly newWorkspaceName?: string
    }) {
      const bound = await bindRemoteCreateWorkspace({
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.newWorkspaceName === undefined ? {} : { newWorkspaceName: input.newWorkspaceName }),
        list: async () => {
          const listed = await apiProxy.workspace.list(request({}))
          if (!listed.result.ok) throw new Error(listed.result.error.message)
          return listed.result.value.items.map(item => ({
            workspaceId: String(item.workspaceId),
            path: item.path,
          }))
        },
        mkdir: mkdirChild,
        register: async (path) => {
          const created = await apiProxy.workspace.create(request({ path }))
          if (!created.result.ok) {
            return { ok: false as const, errorCode: errorCodeOf(created, 'workspace-create-failed') }
          }
          return { ok: true as const, workspaceId: String(created.result.value.workspace.workspaceId) }
        },
      })
      if (!bound.ok) return bound
      const response = await apiProxy.sessions.create(request({
        sessionId: input.sessionId,
        ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
        ...(bound.workspaceId === undefined ? {} : { workspaceId: bound.workspaceId as WorkspaceId }),
      }))
      if (!response.result.ok) {
        return { ok: false as const, errorCode: errorCodeOf(response, 'session-admin-unavailable') }
      }
      return {
        ok: true as const,
        ...(response.result.value.agentPreset === undefined
          ? {}
          : { agentPreset: response.result.value.agentPreset }),
      }
    },
    async selectAgentPreset(input: { readonly sessionId: SessionId; readonly agentPreset: string }) {
      const response = await apiProxy.agentPresets.select(request({
        sessionId: input.sessionId,
        agentPreset: input.agentPreset,
      }))
      if (!response.result.ok) {
        return { ok: false as const, errorCode: errorCodeOf(response, 'session-admin-unavailable') }
      }
      return { ok: true as const }
    },
    async selectModel(input: {
      readonly sessionId: SessionId
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
    }) {
      const response = await apiProxy.sessions.selectModel(request({
        sessionId: input.sessionId,
        provider: input.provider,
        model: input.model,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      }))
      if (!response.result.ok) {
        return { ok: false as const, errorCode: errorCodeOf(response, 'session-admin-unavailable') }
      }
      return { ok: true as const }
    },
    async forkSession(input: {
      readonly sessionId: SessionId
      readonly childSessionId: SessionId
      readonly atSeq?: number
    }) {
      const response = await apiProxy.sessions.fork(request({
        sessionId: input.sessionId,
        childSessionId: input.childSessionId,
        ...(input.atSeq === undefined ? {} : { atSeq: input.atSeq }),
      }))
      if (!response.result.ok) {
        // A workspace attach failure still leaves the forked child published,
        // so the durable commit fact holds; only lineage conflicts and true
        // fork failures reject.
        if (response.result.error.code === 'workspace-attach-failed') {
          return { ok: true as const, childSessionId: input.childSessionId }
        }
        return { ok: false as const, errorCode: errorCodeOf(response, 'session-admin-unavailable') }
      }
      return { ok: true as const, childSessionId: response.result.value.sessionId }
    },
  }
  return Object.freeze(admin)
}

/**
 * Publish the command adapter and drain accepted owners before disposal completes.
 * @param ctx - Host context carrying ApiProxy and Remote control authority.
 */
export function apply(ctx: Context, config: Config): void {
  const executor = new RemoteCommandExecutor(
    ctx.apiProxy.promptAdmissions,
    ctx.apiProxy.stopAdmissions,
    ctx.remoteControl,
    ctx.logger,
    config.stopSettlementTimeoutMs ?? 30_000,
    ctx.apiProxy.approvalInteractions,
    createHostSessionAdmin(ctx.apiProxy),
    // Lazy: the policy owner mounts with the remote carrier plugin, which may
    // load after this adapter; absence keeps policy commands honestly refused.
    () => ctx.get('remoteApprovalPolicy'),
  )
  const disposeService = ctx.provide('remoteCommands', executor)
  ctx.effect(() => async () => {
    disposeService()
    await executor.close()
  }, 'host-remote-command: command owner')
}
