/** Host-side create_session workspace bind: existing id, or a child folder name. */

export type RemoteWorkspaceBindError =
  | 'workspace-not-found'
  | 'workspace-invalid-name'
  | 'workspace-create-failed'

export type RemoteWorkspaceBindResult =
  | { readonly ok: true; readonly workspaceId?: string }
  | { readonly ok: false; readonly errorCode: RemoteWorkspaceBindError }

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Accept one folder name the Host may mkdir under an already-registered
 * parent. Rejects paths, traversal, Windows reserved names, and empty input.
 * Unicode is allowed; the absolute path never leaves the Host.
 * @param raw - caller-supplied name, possibly dirty.
 * @returns the trimmed name, or `undefined` when it cannot be a child folder.
 */
export function sanitizeRemoteWorkspaceName(raw: string): string | undefined {
  const name = raw.trim()
  if (name.length < 1 || name.length > 64) return undefined
  if (name === '.' || name === '..') return undefined
  if (/[\\/<>:"|?*\u0000-\u001f]/.test(name)) return undefined
  if (WINDOWS_RESERVED.test(name)) return undefined
  return name
}

/**
 * Resolve the workspace a Remote create_session should bind.
 * Neither field → Host default cwd (owner omits workspaceId).
 * workspaceId only → that registered workspace.
 * both → mkdir `name` under the parent, register-or-reuse, bind the child.
 * @param input - wire fields plus Host-local list/mkdir/register faces.
 */
export async function bindRemoteCreateWorkspace(input: {
  readonly workspaceId?: string
  readonly newWorkspaceName?: string
  readonly list: () => Promise<ReadonlyArray<{ workspaceId: string; path: string }>>
  readonly mkdir: (parentPath: string, name: string) => Promise<string>
  readonly register: (path: string) => Promise<
    { readonly ok: true; readonly workspaceId: string } | { readonly ok: false; readonly errorCode: string }
  >
}): Promise<RemoteWorkspaceBindResult> {
  const parentId = input.workspaceId?.trim() || undefined
  const rawName = input.newWorkspaceName
  if (rawName !== undefined && parentId === undefined) {
    return { ok: false, errorCode: 'workspace-invalid-name' }
  }
  if (parentId === undefined) return { ok: true }

  let items: ReadonlyArray<{ workspaceId: string; path: string }>
  try {
    items = await input.list()
  } catch {
    return { ok: false, errorCode: 'workspace-create-failed' }
  }
  const parent = items.find(item => item.workspaceId === parentId)
  if (parent === undefined) return { ok: false, errorCode: 'workspace-not-found' }
  if (rawName === undefined) return { ok: true, workspaceId: parent.workspaceId }

  const name = sanitizeRemoteWorkspaceName(rawName)
  if (name === undefined) return { ok: false, errorCode: 'workspace-invalid-name' }

  let childPath: string
  try {
    childPath = await input.mkdir(parent.path, name)
  } catch {
    return { ok: false, errorCode: 'workspace-create-failed' }
  }
  const registered = await input.register(childPath)
  if (!registered.ok) return { ok: false, errorCode: 'workspace-create-failed' }
  return { ok: true, workspaceId: registered.workspaceId }
}
