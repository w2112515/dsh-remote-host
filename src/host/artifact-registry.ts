/**
 * Artifact registry (S-artifacts): the Host-owned roster of files the agent
 * created or changed, derived from the durable session journals — never a new
 * storage domain. Recognition is by render intent exactly like the Host-local
 * deliverables surface (a diff card, or a generic card whose kind is `edit`),
 * never by tool name and never from closing prose. Entries are immutable
 * journal facts: a later edit registers a new entry rather than updating the
 * old one. The full filesystem path stays Host-side; only the minimized path
 * (workspace-relative, or the final component marked outside) ever crosses.
 * @module @deepseek-ai/dsh-host-remote/artifact-registry
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { HistoryEntry, ToolEventView } from '@deepseek-ai/dsh-host-apiproxy/api'
import { minimizePath } from './path-minimize.ts'

/** Wire row matching the proto `ArtifactSummary` shape (camelCase keys). */
export interface ArtifactSummaryWire {
  /** Opaque stable reference: session id, result sequence and path index, joined. */
  artifact_id: string
  session_id: string
  /** Workspace-relative path, or the final component when outside. */
  path: string
  outside_workspace: boolean
  is_new_file: boolean
  /** Bounded JSON array of applied-hunk triples; absent when none registered. */
  content?: string
  truncated: boolean
  /** Proto uint64 carried as a string. */
  registered_at_ms: string
}

/** Internal roster entry: the wire row plus the facts that never cross. */
interface ArtifactRegistryEntry {
  readonly seq: number
  readonly registeredAtMs: number
  /** Absolute filesystem path for the fetch ACL; undefined when unresolvable. */
  readonly fullPath?: string
  readonly wire: ArtifactSummaryWire
}

/** Session row the roster scan orders by. */
export interface ArtifactScanSession {
  readonly sessionId: string
  readonly updatedAtMs: number
}

/** One session's bounded history window plus its workspace fact. */
export interface ArtifactScanPage {
  readonly entries: readonly HistoryEntry[]
  /**
   * Session workspace root; `undefined` when the session records none. The
   * key is always present so callers never branch on optionality.
   */
  readonly cwd: string | undefined
}

/** Fully-resolved registry behavior; built by {@link resolveArtifactRegistrySpec}. */
export interface ArtifactRegistrySpec {
  /** Newest-updated-first session directory for the cold roster scan. */
  readonly listSessions: () => Promise<readonly ArtifactScanSession[]>
  /**
   * Read one session's newest history window with render-intent views.
   * @param sessionId Session to read.
   * @param maxEvents Bound on the returned window.
   */
  readonly readHistory: (sessionId: string, maxEvents: number) => Promise<ArtifactScanPage>
  /** Sessions scanned per roster build. */
  readonly maxSessions: number
  /** History window scanned per session. */
  readonly maxEventsPerSession: number
  /** Maximum roster rows returned. */
  readonly rosterCap: number
  /** Per-artifact content bound in characters; whole hunks only. */
  readonly contentCharCap: number
  /** Remembered-entry bound for the fetch ACL; oldest evicted beyond it. */
  readonly rememberCap: number
}

/** Registry construction request; the two read seams are required. */
export interface ArtifactRegistrySpecRequest {
  /** See {@link ArtifactRegistrySpec.listSessions}. */
  readonly listSessions: () => Promise<readonly ArtifactScanSession[]>
  /** See {@link ArtifactRegistrySpec.readHistory}. */
  readonly readHistory: (sessionId: string, maxEvents: number) => Promise<ArtifactScanPage>
  /** Sessions scanned per roster build. @default 20 */
  readonly maxSessions?: number
  /** History window scanned per session. @default 500 */
  readonly maxEventsPerSession?: number
  /** Maximum roster rows returned. @default 100 */
  readonly rosterCap?: number
  /** Per-artifact content bound in characters. @default 8192 */
  readonly contentCharCap?: number
  /** Remembered-entry bound for the fetch ACL. @default 400 */
  readonly rememberCap?: number
}

/**
 * Resolve registry behavior explicitly; every bound has a stated default.
 * @param request Construction request.
 * @returns The fully-resolved spec.
 */
export function resolveArtifactRegistrySpec(request: ArtifactRegistrySpecRequest): ArtifactRegistrySpec {
  return {
    listSessions: request.listSessions,
    readHistory: request.readHistory,
    maxSessions: request.maxSessions ?? 20,
    maxEventsPerSession: request.maxEventsPerSession ?? 500,
    rosterCap: request.rosterCap ?? 100,
    contentCharCap: request.contentCharCap ?? 8_192,
    rememberCap: request.rememberCap ?? 400,
  }
}

/** The mutation tools' hunk triple, narrowed defensively from either carrier. */
interface ArtifactHunk {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

/**
 * Narrow an opaque hunk carrier — the result `meta`, or the call view as the
 * create fallback — to applied hunks; malformed input is absent.
 */
function hunksFromMeta(meta: unknown): readonly ArtifactHunk[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  for (const diff of diffs) {
    if (typeof diff !== 'object' || diff === null || Array.isArray(diff)) return undefined
    const { path, oldText, newText } = diff as Record<string, unknown>
    if (typeof path !== 'string' || (oldText !== null && typeof oldText !== 'string') || typeof newText !== 'string') {
      return undefined
    }
  }
  return diffs as readonly ArtifactHunk[]
}

/** One call-view location path; line numbers are follow-along detail, dropped. */
function locationPaths(view: ToolEventView['view']): readonly string[] {
  if (!('locations' in view) || !Array.isArray(view.locations)) return []
  const entries: readonly unknown[] = view.locations
  return entries
    .map(location => (typeof location === 'object' && location !== null
      ? (location as Record<string, unknown>).path
      : undefined))
    .filter((path): path is string => typeof path === 'string' && path !== '')
}

/**
 * Paths a call view reports having created or changed, by render intent rather
 * than tool name: a diff card, or a generic card whose kind is `edit`. Every
 * other card produces nothing to open — a read looked, a delete removed, a
 * terminal ran.
 */
function producedPaths(view: ToolEventView['view'] | undefined): readonly string[] {
  if (view === undefined) return []
  if (view.card === 'diff') return locationPaths(view)
  if (view.card === 'generic' && 'kind' in view && view.kind === 'edit') return locationPaths(view)
  return []
}

/**
 * Bound the applied-hunk content to whole hunks: a cut mid-string would ship
 * invalid JSON, so the largest fitting prefix crosses and the drop is marked.
 */
function boundContent(
  hunks: readonly ArtifactHunk[] | undefined,
  contentCharCap: number,
): { content?: string; truncated: boolean } {
  if (hunks === undefined) return { truncated: false }
  const kept: ArtifactHunk[] = []
  for (const hunk of hunks) {
    const next = JSON.stringify([...kept, hunk])
    if (next.length > contentCharCap) break
    kept.push(hunk)
  }
  if (kept.length === 0) return { truncated: hunks.length > 0 }
  return { content: JSON.stringify(kept), truncated: kept.length < hunks.length }
}

/** Derive the create fact: every applied hunk has no prior text. */
function deriveIsNewFile(hunks: readonly ArtifactHunk[] | undefined): boolean {
  return hunks !== undefined && hunks.every(hunk => hunk.oldText === null)
}

function artifactId(sessionId: string, seq: number, pathIndex: number): string {
  return `${sessionId}:${seq}:${pathIndex}`
}

/**
 * The live registry: remembers recognized entries for the fetch ACL, scans
 * bounded history windows for the connect-time roster, and recognizes live
 * results one frame at a time. Recognition and scan share one fold so the two
 * paths can never drift apart.
 */
export interface ArtifactRegistry {
  /**
   * Build the connect-time roster: scan the newest sessions' bounded windows,
   * merge with remembered live entries (journal facts win on id collision —
   * they are the same facts), and cap newest-first. Empty means none was
   * registered within the bound, never that no file was produced.
   * @returns The capped roster, newest registration first.
   */
  roster(): Promise<ArtifactSummaryWire[]>
  /**
   * Fold one live frame into the registry. Call frames only update the
   * per-session call-view table; a successful result whose call view names
   * produced paths registers and returns the new rows.
   * @param input The session frame with its render-intent view and workspace.
   * @returns Newly registered rows (empty for calls, failures, non-mutations).
   */
  observeLive(input: {
    sessionId: string
    cwd?: string
    event: SessionEvent
    view?: ToolEventView
  }): ArtifactSummaryWire[]
  /**
   * Fetch ACL: the registered absolute path when the artifact belongs to the
   * named session; `undefined` when unknown, cross-session, or unresolvable.
   * @param artifactId Registry artifact id.
   * @param sessionId Session the fetch claims as its reference proof.
   * @returns The internal path, or `undefined`.
   */
  resolve(artifactId: string, sessionId: string): { path: string } | undefined
}

interface ToolCallData { callId: string; name: string; arguments: string }

/**
 * Create the registry. The remembered map is bounded by
 * {@link ArtifactRegistrySpec.rememberCap}; eviction loses only the fetch ACL
 * for entries older than every scan window, never roster honesty.
 * @param spec Fully-resolved registry behavior.
 * @returns The ready registry.
 */
export function createArtifactRegistry(spec: ArtifactRegistrySpec): ArtifactRegistry {
  const remembered = new Map<string, ArtifactRegistryEntry>()
  const callViews = new Map<string, Map<string, ToolEventView['view']>>()

  function remember(entry: ArtifactRegistryEntry): void {
    if (remembered.has(entry.wire.artifact_id)) return
    remembered.set(entry.wire.artifact_id, entry)
    if (remembered.size <= spec.rememberCap) return
    // The map is non-empty (the entry above was just inserted), so the scan
    // always selects a victim; equal timestamps break on the lower sequence.
    let oldestId = entry.wire.artifact_id
    let oldestAt = entry.registeredAtMs
    let oldestSeq = entry.seq
    for (const [candidateId, value] of remembered) {
      if (value.registeredAtMs < oldestAt
        || (value.registeredAtMs === oldestAt && value.seq < oldestSeq)) {
        oldestId = candidateId
        oldestAt = value.registeredAtMs
        oldestSeq = value.seq
      }
    }
    remembered.delete(oldestId)
  }

  function recognizeResult(
    sessionId: string,
    cwd: string | undefined,
    callView: ToolEventView['view'] | undefined,
    event: SessionEvent,
  ): ArtifactSummaryWire[] {
    const paths = producedPaths(callView)
    if (paths.length === 0) return []
    const data = event.data as { message: { content: readonly { isError?: boolean }[] }; meta?: unknown }
    if (data.message.content[0]?.isError === true) return []
    // Result-time hunks win. When the tool journaled none — the write tool
    // records `diffs: []` for a create or an identical overwrite — fall back
    // to the call view's full-content diff, which is the tool's own replay
    // fallback (its presentResult derives the same card from the arguments).
    const hunks = hunksFromMeta(data.meta) ?? hunksFromMeta(callView)
    const bounded = boundContent(hunks, spec.contentCharCap)
    const isNewFile = deriveIsNewFile(hunks)
    const rows: ArtifactSummaryWire[] = []
    paths.forEach((path, pathIndex) => {
      const minimized = minimizePath(path, cwd)
      const wire: ArtifactSummaryWire = {
        artifact_id: artifactId(sessionId, event.seq, pathIndex),
        session_id: sessionId,
        path: minimized.minimized,
        outside_workspace: minimized.outside,
        is_new_file: isNewFile,
        ...(bounded.content === undefined ? {} : { content: bounded.content }),
        truncated: bounded.truncated,
        registered_at_ms: String(event.time),
      }
      remember({
        seq: event.seq,
        registeredAtMs: event.time,
        ...(minimized.fullPath === undefined ? {} : { fullPath: minimized.fullPath }),
        wire,
      })
      rows.push(wire)
    })
    return rows
  }

  function scanEntries(sessionId: string, cwd: string | undefined, entries: readonly HistoryEntry[]): void {
    const calls = new Map<string, ToolEventView['view']>()
    for (const entry of entries) {
      const { event, view } = entry
      if (event.type === 'tool/call') {
        if (view?.for === 'call') calls.set((event.data as ToolCallData).callId, view.view)
        continue
      }
      if (event.type !== 'tool/result') continue
      const callId = String((event.data as { message: { source: { callId: unknown } } }).message.source.callId)
      recognizeResult(sessionId, cwd, calls.get(callId), event)
    }
  }

  return {
    async roster() {
      const sessions = (await spec.listSessions())
        .slice()
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
        .slice(0, spec.maxSessions)
      for (const session of sessions) {
        const page = await spec.readHistory(session.sessionId, spec.maxEventsPerSession)
        scanEntries(session.sessionId, page.cwd, page.entries)
      }
      return [...remembered.values()]
        .sort((a, b) => b.registeredAtMs - a.registeredAtMs || b.seq - a.seq)
        .slice(0, spec.rosterCap)
        .map(entry => entry.wire)
    },

    observeLive(input) {
      const { sessionId, event, view } = input
      const cwd = input.cwd
      if (event.type === 'tool/call') {
        if (view?.for === 'call') {
          let table = callViews.get(sessionId)
          if (table === undefined) callViews.set(sessionId, table = new Map<string, ToolEventView['view']>())
          table.set((event.data as ToolCallData).callId, view.view)
        }
        return []
      }
      if (event.type === 'turn/end') {
        callViews.delete(sessionId)
        return []
      }
      if (event.type !== 'tool/result') return []
      const callId = String((event.data as { message: { source: { callId: unknown } } }).message.source.callId)
      return recognizeResult(sessionId, cwd, callViews.get(sessionId)?.get(callId), event)
    },

    resolve(requestedId, sessionId) {
      const entry = remembered.get(requestedId)
      if (entry === undefined || entry.wire.session_id !== sessionId || entry.fullPath === undefined) {
        return undefined
      }
      return { path: entry.fullPath }
    },
  }
}
