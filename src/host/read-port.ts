/** Narrow, read-only source port between ApiProxy and the mobile carrier. */

import { existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  ApiProxy, HistoryEntry, HostApprovalInteraction, MuxFrame, RpcResponse, SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Remote-safe session list row. No mutation method or full ApiProxy escapes this module. */
export interface RemoteSessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  title?: string
  workspaceLabel?: string
  pendingApprovalCount: number
  pendingInputCount: number
  usage?: RemoteSessionUsage
  /** Lineage facts, present only for sub-agent child sessions. */
  parentSessionId?: string
  origin?: string
  subagent?: RemoteSubagentView
  /**
   * Agent preset id the session actually runs (S-mode-select): the ApiProxy
   * resolves it from the log, so a blank-session switch is already reflected.
   * Absent when the deployment composes no presets.
   */
  agentPreset?: string
  /**
   * Latest logged request-header selection (S-session-admin), resolved from
   * the log like agentPreset. Absent while the session never recorded a
   * header — never rewritten to the deployment default.
   */
  model?: RemoteModelSelection
  /**
   * Operator-configured project registry label (S-project), resolved from the
   * session cwd against the plugin `projects` config. Absent when no registry
   * root matches — never a path and never a derived guess.
   */
  projectLabel?: string
}

/** Create-time workspace row. Id + label only; the path never crosses. */
export interface RemoteWorkspaceSummary {
  workspaceId: string
  label: string
}

/**
 * One operator-configured project registry row (S-project): sessions whose cwd
 * equals `root` or sits under it carry `label` across the carrier. The root
 * itself never crosses — it is the matching key, not wire content.
 */
export interface RemoteProjectRegistryEntry {
  root: string
  label: string
}

/** Exact provider/model/effort triple (S-session-admin). */
export interface RemoteModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Minimized connect-time model-catalog row (S-session-admin). */
export interface RemoteModelCatalog {
  groups: {
    id: string
    name?: string
    models: {
      id: string
      name?: string
      reasoningEfforts: string[]
      defaultReasoningEffort?: string
      /**
       * Declared input modalities (S-blob), e.g. ['text', 'image']. Absent
       * means the adapter never declared them — unknown, never "text-only";
       * an explicit list that omits 'image' is the negative capability.
       */
      inputModalities?: string[]
    }[]
  }[]
  failures: { providerId: string; detail?: string }[]
}

/**
 * Minimized agent-preset roster row (S-mode-select). `broken` rows stay
 * listed — a surface must show why they cannot be offered — and `user` trust
 * stays labeled because a locally authored preset is exactly as privileged as
 * the plugins it names. Authoring verbs never cross: they are loopback-pinned
 * privileged calls, so the carrier carries no authorable/hasDocument hints.
 */
export interface RemoteAgentPresetEntry {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name?: string
  description?: string
  broken?: string
}

/**
 * Minimized sub-agent identity/timing halves (S-vocab-ext), folded from the
 * `subagent` and `subagentTiming` projection units. The identity half is
 * absent when the descriptor is invalid; the whole view is absent for
 * sessions that are not descriptor-backed children (the `subagent` unit's
 * null sentinel is undistinguished missing-or-malformed, so it never crosses).
 */
export interface RemoteSubagentView {
  mode?: 'one-shot' | 'continuable'
  label?: string
  settledMs?: number
  activeSinceMs?: number
  activeThroughMs?: number
}

/**
 * Numbers-only minimized usage views, keyed by the owning projection unit.
 * A unit key is absent when the Host composition never loaded that unit;
 * absence is never rewritten to zero.
 */
export interface RemoteSessionUsage {
  tokenUsage?: {
    uncachedInputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
  contextPressure?: {
    pressureTokens?: number
    projectedTokens?: number
    contextWindow?: number
  }
  sessionStats?: {
    turns: number
    steps: number
    llmMs: number
    toolMs: number
  }
}

/**
 * Minimized `approvalPolicy` projection view (S-policy): the active
 * auto-grant rules and the optional token ceiling. `exhausted` is NOT here —
 * it is the owner's admission decision, asserted by the carrier at emission
 * time, never a stored fact of the fold.
 */
export interface RemoteApprovalPolicyView {
  rules: {
    ruleId: string
    classKind: 'escalate' | 'tool'
    toolName: string
    classMode?: string
    grantedBy: 'user' | 'operator'
    grantedAtMs: number
  }[]
  budget?: {
    maxTotalTokens: number
    setAtMs: number
  }
}

/** One source history cut used to construct a Remote snapshot. */
export interface RemoteHistoryCut {
  entries: HistoryEntry[]
  hasMore: boolean
  sourceWatermark: number
  projectionWatermark: number
  /** Attached-agent status from the (possibly blank) summary lookup. */
  running: boolean
  title?: string
  usage?: RemoteSessionUsage
  subagent?: RemoteSubagentView
  agentPreset?: string
  model?: RemoteModelSelection
  policy?: RemoteApprovalPolicyView
  approvals: readonly HostApprovalInteraction[]
  pendingInputCount: number
}

/** The only ApiProxy mux frames allowed to cross into the carrier. */
export type RemoteReadFrame =
  | Extract<
    MuxFrame,
    { type: 'session/subscribed' | 'session/event' | 'session/projection' | 'approval/requested' | 'approval/resolved' }
  >
  | {
    type: 'question/attention'
    sessionId: SessionId
    interactionId: RpcId
    pendingCount: number
  }

/** Capability-minimized input to the physical carrier. */
export interface RemoteProjectionReadPort {
  list(): Promise<RemoteSessionSummary[]>
  history(sessionId: string, maxMessages: number): Promise<RemoteHistoryCut>
  watch(sessionId: string, signal: AbortSignal): AsyncIterable<RemoteReadFrame>
  /**
   * Host-internal workspace root (S-artifacts): the dedicated internal-only
   * channel for the artifact registry's path minimization and fetch ACL.
   * Kept off the summary row so the "roots are matching keys, not wire
   * content" contract keeps holding by construction.
   * @param sessionId Session whose workspace root resolves.
   * @returns The workspace root, or `undefined` when unknown or unrecorded.
   */
  sessionCwd(sessionId: string): Promise<string | undefined>
  /** Connect-time agent-preset roster snapshot; empty when none is composed. */
  presets(): Promise<RemoteAgentPresetEntry[]>
  /** Connect-time model catalog snapshot; empty groups when no provider serves. */
  modelCatalog(): Promise<RemoteModelCatalog>
  /**
   * Session-log-reference proof for one image attachment (S-blob): the same
   * authorization as `sessions.attachment`, without reading a single byte —
   * the blob fetch server pins the returned ref and serves chunks from the
   * content-addressed store. `undefined` on ANY failure (unknown session,
   * unreferenced image, gateway error): inability to prove is a denial and
   * the reason never crosses.
   * @param sessionId Session whose log must reference the image.
   * @param attachmentId Content-addressed image identifier to prove.
   * @returns The canonical reference when the session references it.
   */
  attachmentRef(sessionId: string, attachmentId: string): Promise<ImageAttachmentRef | undefined>
  /**
   * Connect-time workspace roster for create-time bind. Labels only; paths
   * stay Host-side. Empty when the registry has nothing the Host can name.
   */
  workspaces(): Promise<RemoteWorkspaceSummary[]>
}

/** Stable read failure translated by the carrier without exposing ApiProxy errors. */
export class RemoteReadError extends Error {
  constructor(readonly code: 'session-not-found' | 'source-failed', message: string) {
    super(message)
    this.name = 'RemoteReadError'
  }
}

function titleFrom(values: unknown): string | undefined {
  if (typeof values !== 'object' || values === null || !('title' in values)) return undefined
  const title = values.title
  return typeof title === 'string' && title !== '' ? title : undefined
}

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

function numberRecord<T extends string>(
  value: unknown,
  required: readonly T[],
  optional: readonly T[] = [],
): Record<T, number> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const out: Partial<Record<T, number>> = {}
  for (const key of required) {
    const field = record[key]
    if (!finiteNonNegative(field)) return undefined
    out[key] = field
  }
  for (const key of optional) {
    const field = record[key]
    if (field === undefined) continue
    if (!finiteNonNegative(field)) return undefined
    out[key] = field
  }
  return out as Record<T, number>
}

/** Minimize one usage unit view; malformed views are dropped, never zero-filled. */
export function usageUnitFrom(
  key: 'tokenUsage' | 'contextPressure' | 'sessionStats',
  value: unknown,
): RemoteSessionUsage | undefined {
  switch (key) {
    case 'tokenUsage': {
      const buckets = numberRecord(value, ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
      return buckets === undefined ? undefined : { tokenUsage: buckets }
    }
    case 'contextPressure': {
      const pressure = numberRecord(value, [], ['pressureTokens', 'projectedTokens', 'contextWindow'])
      return pressure === undefined ? undefined : { contextPressure: pressure }
    }
    case 'sessionStats': {
      const stats = numberRecord(value, ['turns', 'steps', 'llmMs', 'toolMs'])
      return stats === undefined ? undefined : { sessionStats: stats }
    }
  }
}

function usageFrom(values: unknown): RemoteSessionUsage | undefined {
  if (typeof values !== 'object' || values === null) return undefined
  const record = values as Record<string, unknown>
  const usage: RemoteSessionUsage = {}
  let present = false
  for (const key of ['tokenUsage', 'contextPressure', 'sessionStats'] as const) {
    if (!(key in record)) continue
    const unit = usageUnitFrom(key, record[key])
    if (unit === undefined) continue
    Object.assign(usage, unit)
    present = true
  }
  return present ? usage : undefined
}

const RULE_ID_PATTERN = /^[0-9a-f]{16,64}$/
const RULE_TOOL_PATTERN = /^[\x21-\x7e]{1,100}$/
const RULE_MODE_PATTERN = /^[a-z][a-z-]{0,63}$/

/**
 * Minimize the `approvalPolicy` projection unit view (S-policy). A malformed
 * rule row is dropped (never repaired); a malformed budget is dropped whole.
 * The unit's own zod schema already validated the wire shape on the Host —
 * this re-validation keeps the carrier honest against any future drift.
 */
export function approvalPolicyUnitFrom(value: unknown): RemoteApprovalPolicyView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.rules)) return undefined
  const rules: RemoteApprovalPolicyView['rules'] = []
  for (const raw of record.rules.slice(0, 200)) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    if (typeof row.ruleId !== 'string' || !RULE_ID_PATTERN.test(row.ruleId)) continue
    if (row.classKind !== 'escalate' && row.classKind !== 'tool') continue
    if (typeof row.toolName !== 'string' || !RULE_TOOL_PATTERN.test(row.toolName)) continue
    if (row.grantedBy !== 'user' && row.grantedBy !== 'operator') continue
    if (!finiteNonNegative(row.grantedAtMs)) continue
    const classMode = row.classMode
    if (row.classKind === 'escalate'
      && (typeof classMode !== 'string' || !RULE_MODE_PATTERN.test(classMode))) continue
    if (row.classKind === 'tool' && classMode !== undefined) continue
    rules.push({
      ruleId: row.ruleId,
      classKind: row.classKind,
      toolName: row.toolName,
      ...(row.classKind === 'escalate' ? { classMode: classMode as string } : {}),
      grantedBy: row.grantedBy,
      grantedAtMs: row.grantedAtMs,
    })
  }
  const view: RemoteApprovalPolicyView = { rules }
  const budget = record.budget
  if (budget !== undefined) {
    const bounds = numberRecord(budget, ['maxTotalTokens', 'setAtMs'])
    if (bounds !== undefined && bounds.maxTotalTokens >= 1) {
      view.budget = { maxTotalTokens: bounds.maxTotalTokens, setAtMs: bounds.setAtMs }
    }
  }
  return view
}

function policyFrom(values: unknown): RemoteApprovalPolicyView | undefined {
  if (typeof values !== 'object' || values === null) return undefined
  const record = values as Record<string, unknown>
  if (!('approvalPolicy' in record)) return undefined
  return approvalPolicyUnitFrom(record.approvalPolicy)
}

const boundedString = (value: unknown, max = 200): string | undefined =>
  typeof value === 'string' && value !== '' && value.length <= max ? value : undefined

/** Minimize one sub-agent projection unit; malformed views are dropped. */
export function subagentUnitFrom(
  key: 'subagent' | 'subagentTiming',
  value: unknown,
): RemoteSubagentView | undefined {
  if (key === 'subagent') {
    // The unit's null sentinel is deliberately undistinguished (missing OR
    // malformed descriptor) — it states no honest fact, so it never crosses.
    if (value === null || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    const mode = record.mode
    if (mode !== 'one-shot' && mode !== 'continuable') return undefined
    const label = boundedString(record.label)
    if (mode === 'continuable' && label === undefined) return undefined
    return { mode, ...(label === undefined ? {} : { label }) }
  }
  const settled = numberRecord(value, ['settledMs'])
  if (settled === undefined) return undefined
  const view: RemoteSubagentView = { settledMs: settled.settledMs }
  const active = (value as Record<string, unknown>).active
  if (active !== undefined) {
    if (typeof active !== 'object' || active === null) return undefined
    const bounds = numberRecord(active, ['since', 'through'])
    if (bounds === undefined) return undefined
    view.activeSinceMs = bounds.since
    view.activeThroughMs = bounds.through
  }
  return view
}

function subagentFrom(values: unknown): RemoteSubagentView | undefined {
  if (typeof values !== 'object' || values === null) return undefined
  const record = values as Record<string, unknown>
  const view: RemoteSubagentView = {}
  let present = false
  for (const key of ['subagent', 'subagentTiming'] as const) {
    if (!(key in record)) continue
    const unit = subagentUnitFrom(key, record[key])
    if (unit === undefined) continue
    Object.assign(view, unit)
    present = true
  }
  return present ? view : undefined
}

function workspaceLabelFrom(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  const label = basename(cwd.replaceAll('\\', '/'))
  return label === '' ? undefined : label
}

function normalizeRegistryPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '')
}

/**
 * Resolve the registry label for one session cwd: exact or segment-boundary
 * descendant match, longest normalized root wins. Absent cwd or no match
 * states nothing — the label is never guessed from the path.
 */
function projectLabelFrom(
  cwd: string | undefined,
  projects: readonly RemoteProjectRegistryEntry[],
): string | undefined {
  if (cwd === undefined || projects.length === 0) return undefined
  const path = normalizeRegistryPath(cwd)
  let match: RemoteProjectRegistryEntry | undefined
  let matchLength = -1
  for (const entry of projects) {
    const root = normalizeRegistryPath(entry.root)
    if (root === '') continue
    if (path !== root && !path.startsWith(`${root}/`)) continue
    if (root.length > matchLength) {
      match = entry
      matchLength = root.length
    }
  }
  return match?.label
}

/** Minimize one logged model selection; an unbounded triple states nothing. */
function modelSelectionFrom(value: unknown): RemoteModelSelection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const provider = boundedString(record.provider, 100)
  const model = boundedString(record.model, 200)
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort = boundedString(record.reasoningEffort, 100)
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

function summaryOf(
  item: SessionSummary,
  pendingApprovalCount: number,
  pendingInputCount: number,
  projects: readonly RemoteProjectRegistryEntry[],
): RemoteSessionSummary {
  const title = titleFrom(item.projections?.values)
  const workspaceLabel = workspaceLabelFrom(item.cwd)
  const projectLabel = projectLabelFrom(item.cwd, projects)
  const usage = usageFrom(item.projections?.values)
  const subagent = subagentFrom(item.projections?.values)
  const parentSessionId = item.parentSessionId === undefined ? undefined : String(item.parentSessionId)
  const origin = item.origin === 'subagent' ? 'subagent' : undefined
  const agentPreset = boundedString(item.agentPreset, 100)
  const model = modelSelectionFrom(item.model)
  return {
    sessionId: item.sessionId,
    updatedAt: item.updatedAt,
    running: item.running,
    pendingApprovalCount,
    pendingInputCount,
    ...(title === undefined ? {} : { title }),
    ...(workspaceLabel === undefined ? {} : { workspaceLabel }),
    ...(projectLabel === undefined ? {} : { projectLabel }),
    ...(usage === undefined ? {} : { usage }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(origin === undefined ? {} : { origin }),
    ...(subagent === undefined ? {} : { subagent }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(model === undefined ? {} : { model }),
  }
}

function unwrap<T>(response: RpcResponse<T>, operation: string): T {
  if (response.result.ok) return response.result.value
  const { error } = response.result
  if (error.code === 'session-not-found') {
    throw new RemoteReadError('session-not-found', error.message)
  }
  throw new RemoteReadError('source-failed', `${operation}: ${error.message}`)
}

function request<P>(payload: P): { rpcId: RpcId; payload: P } {
  return { rpcId: RpcId(`mobile-remote-${randomUUID()}`), payload }
}

function lastSourceSequence(entries: readonly { event: SessionEvent }[], projectionWatermark: number): number {
  return entries.at(-1)?.event.seq ?? projectionWatermark
}

/**
 * Close the privileged ApiProxy over a literal read-only capability object.
 * The returned object contains no reference to Context, `sessions.prompt`,
 * `sessions.cancel`, or `respond`.
 * @param apiProxy - Internal Host gateway to minimize into read capabilities.
 * @param options - Operator registry (S-project); roots stay Host-local.
 * @returns A frozen capability object exposing only the minimized reads.
 */
export function createRemoteProjectionReadPort(
  apiProxy: ApiProxy,
  options: { projects?: readonly RemoteProjectRegistryEntry[] } = {},
): RemoteProjectionReadPort {
  const projects = options.projects ?? []
  // Blank sessions stay in this lookup: a freshly created session is blank
  // until its first turn, and its creator must be able to subscribe to it.
  // Only the directory listing hides them.
  const listAll = async (): Promise<{ rows: RemoteSessionSummary[]; blank: Set<string> }> => {
    const response = await apiProxy.sessions.list(request({}))
    const approvals = apiProxy.approvalInteractions.list()
    const approvalCounts = new Map<string, number>()
    for (const approval of approvals) {
      approvalCounts.set(approval.sessionId, (approvalCounts.get(approval.sessionId) ?? 0) + 1)
    }
    const inputCounts = new Map<string, number>()
    for (const question of apiProxy.questionInteractions.list()) {
      inputCounts.set(question.sessionId, (inputCounts.get(question.sessionId) ?? 0) + 1)
    }
    const items = unwrap(response, 'session.list').items
    const blank = new Set<string>()
    const rows = items.map((item) => {
      if (item.blank) blank.add(item.sessionId)
      return summaryOf(
        item,
        approvalCounts.get(item.sessionId) ?? 0,
        inputCounts.get(item.sessionId) ?? 0,
        projects,
      )
    })
    return { rows, blank }
  }

  const list = async (): Promise<RemoteSessionSummary[]> => {
    const { rows, blank } = await listAll()
    return rows.filter(item => !blank.has(item.sessionId))
  }

  const history = async (rawSessionId: string, maxMessages: number): Promise<RemoteHistoryCut> => {
    const sessionId = SessionId(rawSessionId)
    const [{ rows: summaries }, response] = await Promise.all([
      listAll(),
      apiProxy.sessions.history(request({ sessionId, maxMessages })),
    ])
    const summary = summaries.find(candidate => candidate.sessionId === sessionId)
    if (summary === undefined) {
      throw new RemoteReadError('session-not-found', `session not found: ${rawSessionId}`)
    }
    const value = unwrap(response, 'session.history')
    const projectionWatermark = value.projections?.asOfSeq ?? -1
    const title = titleFrom(value.projections?.values) ?? summary.title
    const usage = usageFrom(value.projections?.values) ?? summary.usage
    const subagent = subagentFrom(value.projections?.values) ?? summary.subagent
    const policy = policyFrom(value.projections?.values)
    return {
      entries: value.events,
      hasMore: value.hasMore,
      sourceWatermark: lastSourceSequence(value.events, projectionWatermark),
      projectionWatermark,
      running: summary.running,
      approvals: apiProxy.approvalInteractions.list(sessionId),
      pendingInputCount: apiProxy.questionInteractions.list(sessionId).length,
      ...(title === undefined ? {} : { title }),
      ...(usage === undefined ? {} : { usage }),
      ...(subagent === undefined ? {} : { subagent }),
      ...(summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset }),
      ...(summary.model === undefined ? {} : { model: summary.model }),
      ...(policy === undefined ? {} : { policy }),
    }
  }

  const presets = async (): Promise<RemoteAgentPresetEntry[]> => {
    const response = await apiProxy.agentPresets.list(request({}))
    const rows: RemoteAgentPresetEntry[] = []
    for (const entry of unwrap(response, 'agentPreset.list').presets.slice(0, 64)) {
      const id = boundedString(entry.id, 100)
      if (id === undefined) continue
      const trust = entry.trust === 'user' ? 'user' : 'system'
      const name = boundedString(entry.name, 100)
      const description = boundedString(entry.description, 500)
      const broken = boundedString(entry.broken, 200)
      rows.push({
        id,
        trust,
        isDefault: entry.isDefault,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(broken === undefined ? {} : { broken }),
      })
    }
    return rows
  }

  const modelCatalog = async (): Promise<RemoteModelCatalog> => {
    const fetchCatalog = async () => unwrap(await apiProxy.llm.models(request({})), 'llm.models')
    let value: Awaited<ReturnType<typeof fetchCatalog>>
    try {
      value = await fetchCatalog()
    } catch (error: unknown) {
      // The catalog is advisory: a host without a usable LLM directory still
      // serves hello, and the total failure crosses as one explicit bounded
      // row so the carrier can render "catalog unavailable" instead of
      // mistaking absence for an empty provider list.
      const detail = boundedString(error instanceof Error ? error.message : String(error), 200)
      return {
        groups: [],
        failures: [{ providerId: 'catalog', ...(detail === undefined ? {} : { detail }) }],
      }
    }
    const groups: RemoteModelCatalog['groups'] = []
    for (const group of value.groups.slice(0, 32)) {
      const id = boundedString(group.id, 100)
      if (id === undefined) continue
      const models: RemoteModelCatalog['groups'][number]['models'] = []
      for (const entry of group.models.slice(0, 64)) {
        const modelId = boundedString(entry.id, 200)
        if (modelId === undefined) continue
        const reasoningEfforts = (entry.reasoning?.efforts ?? [])
          .map(effort => boundedString(effort.id, 100))
          .filter((effort): effort is string => effort !== undefined)
          .slice(0, 16)
        const defaultReasoningEffort = boundedString(entry.reasoning?.defaultEffort, 100)
        const name = boundedString(entry.name, 100)
        const inputModalities = entry.inputModalities
          ?.map(modality => boundedString(modality, 32))
          .filter((modality): modality is string => modality !== undefined)
          .slice(0, 8)
        models.push({
          id: modelId,
          ...(name === undefined ? {} : { name }),
          reasoningEfforts,
          ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
          ...(inputModalities === undefined ? {} : { inputModalities }),
        })
      }
      if (models.length === 0) continue
      const name = boundedString(group.name, 100)
      groups.push({ id, ...(name === undefined ? {} : { name }), models })
    }
    const failures: RemoteModelCatalog['failures'] = []
    for (const failure of value.failures.slice(0, 32)) {
      const providerId = boundedString(failure.id, 100)
      if (providerId === undefined) continue
      const detail = boundedString(failure.message, 200)
      failures.push({ providerId, ...(detail === undefined ? {} : { detail }) })
    }
    return { groups, failures }
  }

  const watch = async function* (
    rawSessionId: string,
    signal: AbortSignal,
  ): AsyncIterable<RemoteReadFrame> {
    const sessionId = SessionId(rawSessionId)
    for await (const envelope of apiProxy.events.mux(request({}), signal)) {
      const frame = envelope.payload
      if (
        (frame.type === 'question/requested' || frame.type === 'question/resolved')
        && frame.sessionId === sessionId
      ) {
        yield {
          type: 'question/attention',
          sessionId,
          interactionId: frame.type === 'question/requested' ? envelope.rpcId : frame.questionRpcId,
          pendingCount: apiProxy.questionInteractions.list(sessionId).length,
        }
        continue
      }
      if (
        (frame.type === 'session/subscribed'
          || frame.type === 'session/event'
          || frame.type === 'session/projection'
          || frame.type === 'approval/requested'
          || frame.type === 'approval/resolved')
        && frame.sessionId === sessionId
      ) {
        yield frame
      }
    }
  }

  const sessionCwd = async (rawSessionId: string): Promise<string | undefined> => {
    const response = await apiProxy.sessions.list(request({}))
    const item = unwrap(response, 'session.list').items
      .find(candidate => String(candidate.sessionId) === rawSessionId)
    return item?.cwd
  }

  const attachmentRef = async (
    rawSessionId: string,
    rawAttachmentId: string,
  ): Promise<ImageAttachmentRef | undefined> => {
    // Fail-closed authorization read: a business refusal AND a carrier fault
    // both mean "not provable", and the fetch ACL denies either way.
    try {
      const result = await apiProxy.sessions.attachmentRef(request({
        sessionId: SessionId(rawSessionId),
        attachmentId: AttachmentId(rawAttachmentId),
      }))
      return result.result.ok ? result.result.value.attachment : undefined
    } catch {
      return undefined
    }
  }

  const existingDirectory = (path: string): boolean => {
    try {
      return existsSync(path) && statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  const ensureKnownParents = async (): Promise<void> => {
    const adopt = async (path: string): Promise<void> => {
      if (!existingDirectory(path)) return
      try {
        await apiProxy.workspace.create(request({ path }))
      } catch {
        // Roster still serves whatever is already registered.
      }
    }
    try {
      const described = await apiProxy.host.describe(request({}))
      if (described.result.ok) await adopt(described.result.value.cwd)
    } catch {
      // Default cwd stays off the roster when describe is unavailable.
    }
    for (const project of projects) await adopt(project.root)
  }

  const workspaces = async (): Promise<RemoteWorkspaceSummary[]> => {
    try {
      await ensureKnownParents()
    } catch {
      // Continue with the current registry.
    }
    let items: Array<{ workspaceId: unknown; path: string; title: string }>
    try {
      items = unwrap(await apiProxy.workspace.list(request({})), 'workspace.list').items
    } catch {
      return []
    }
    const rows: RemoteWorkspaceSummary[] = []
    for (const item of items.slice(0, 64)) {
      const workspaceId = boundedString(String(item.workspaceId), 100)
      if (workspaceId === undefined) continue
      const fromProject = projectLabelFrom(item.path, projects)
      const title = boundedString(item.title, 100)
      const base = workspaceLabelFrom(item.path)
      const label = fromProject ?? title ?? base
      if (label === undefined) continue
      rows.push({ workspaceId, label })
    }
    return rows
  }

  return Object.freeze({ list, history, watch, sessionCwd, presets, modelCatalog, attachmentRef, workspaces })
}
