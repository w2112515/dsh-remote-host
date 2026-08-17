/**
 * Carrier path minimization: workspace roots are matching keys, never wire
 * content. The artifact registry (roster rows) and the projection (timeline
 * tool cards) share these primitives so both minimize identically.
 * @module @deepseek-ai/dsh-host-remote/src/path-minimize
 */

const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/

/**
 * Normalize separator style before any comparison or slicing.
 * @param path - The raw carried path.
 * @returns The same path with forward slashes only.
 */
export function normalizeSlashes(path: string): string {
  return path.replaceAll('\\', '/')
}

/**
 * Whether the normalized path names a root (POSIX, UNC, or drive).
 * @param path - The slash-normalized path.
 * @returns True when the path is absolute.
 */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || DRIVE_ABSOLUTE.test(path)
}

/**
 * Final path component.
 * @param path - The slash-normalized path.
 * @returns Everything after the last separator; the whole path when there is none.
 */
export function basenameOf(path: string): string {
  // -1 (no separator) + 1 = 0: the whole path is its own final component.
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * Minimized path plus the internal absolute form, never guessing relativity.
 * @param rawPath - The carried path as the tool reported it.
 * @param cwd - The session workspace root, when the Host knows it.
 * @returns The workspace-relative path, or the final component when outside;
 *   `fullPath` is the internal absolute form for the fetch ACL, absent when
 *   the path was relative and no workspace fact resolves it.
 */
export function minimizePath(
  rawPath: string,
  cwd: string | undefined,
): { minimized: string; outside: boolean; fullPath?: string } {
  const normalized = normalizeSlashes(rawPath)
  if (!isAbsolutePath(normalized)) {
    // A relative tool path is workspace-relative by the tools' own contract;
    // without a workspace fact it cannot be resolved and must not be guessed.
    if (cwd === undefined) return { minimized: normalized, outside: false }
    return {
      minimized: normalized,
      outside: false,
      fullPath: `${normalizeSlashes(cwd).replace(/\/+$/, '')}/${normalized}`,
    }
  }
  if (cwd !== undefined) {
    const root = normalizeSlashes(cwd).replace(/\/+$/, '')
    if (root !== '' && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      return { minimized: normalized.slice(root.length + 1), outside: false, fullPath: normalized }
    }
  }
  return { minimized: basenameOf(normalized), outside: true, fullPath: normalized }
}
