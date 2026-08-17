/** Pure DSH event -> bounded Remote v1alpha projection. */

import type {
  HistoryEntry, HostApprovalInteraction, MuxFrame, ToolEventView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { foldSurface, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  usageUnitFrom, subagentUnitFrom, approvalPolicyUnitFrom,
  type RemoteApprovalPolicyView, type RemoteModelSelection, type RemoteSessionUsage, type RemoteSubagentView,
} from './read-port.ts'
import { deriveApprovalClass } from './approval-policy.ts'
import { minimizePath, normalizeSlashes } from './path-minimize.ts'

/**
 * Version of the minimized Remote projection emitted by this package.
 * v8 activates the session-policy vocabulary (S-policy): snapshots carry
 * `approval_rules`/`budget`, live streams carry `policy_changed`, and
 * approvals may offer `APPROVAL_DECISION_ALLOW_SAME_KIND`.
 */
export const PROJECTION_VERSION = 8

/** Bounded, presentation-only tool data allowed across the Remote carrier. */
export interface ToolPresentationWire {
  kind: 'KIND_GENERIC' | 'KIND_TERMINAL' | 'KIND_DIFF' | 'KIND_UNSUPPORTED'
  call_id: string
  tool_name: string
  summary: string
  bounded_content: string
  truncated: boolean
}

/** Bounded provenance wire shape for user-role messages (S-vocab-ext). */
export interface MessageSourceWire {
  kind: string
  plugin?: string
  form?: string
}

/**
 * Committed image reference on a user message (S-blob): the metadata half
 * only — bytes never ride the timeline, they move through the blob fetch
 * channel under the session-log-reference ACL.
 */
export interface ProjectedImageAttachmentWire {
  attachment_id: string
  media_type: string
  /** Byte count as a decimal string (proto int64 JSON mapping). */
  bytes: string
  width?: number
  height?: number
  name?: string
}

/** One source-addressable row in a Remote snapshot timeline. */
export interface TimelineNodeWire {
  event_id: string
  source_sequence: string
  user_message?: { text: string; source?: MessageSourceWire; attachments?: ProjectedImageAttachmentWire[] }
  assistant_message?: { text: string; final: boolean; message_id: string }
  tool_presentation?: ToolPresentationWire
}

/** Minimized current Session state sent in a fresh Remote snapshot. */
export interface SessionProjectionWire {
  session_id: string
  title: string
  running: boolean
  timeline: TimelineNodeWire[]
  history_truncated: boolean
  activity_revision: string
  approvals: ApprovalInteractionWire[]
  pending_input_count: number
  usage?: SessionUsageWire
  subagent?: SubagentViewWire
  agent_preset?: string
  model?: ModelSelectionWire
  /** Active auto-grant rules (S-policy); the empty list IS the fact. */
  approval_rules: ApprovalRuleWire[]
  /** The session token ceiling; absent when none is set — never zero. */
  budget?: SessionBudgetWire
}

/** One active auto-grant rule wire row (S-policy). */
export interface ApprovalRuleWire {
  rule_id: string
  class_kind: string
  tool_name: string
  class_mode?: string
  granted_by: string
  granted_at_ms: string
}

/** Token ceiling plus the owner-asserted gate state (S-policy). */
export interface SessionBudgetWire {
  max_total_tokens: string
  exhausted: boolean
}

/** Full policy fold pushed after one change crossed the durable log (S-policy). */
export interface PolicyChangedWire {
  rules: ApprovalRuleWire[]
  budget?: SessionBudgetWire
}

/** Convert one minimized policy rule into its wire row. */
function approvalRuleWire(rule: RemoteApprovalPolicyView['rules'][number]): ApprovalRuleWire {
  return {
    rule_id: rule.ruleId,
    class_kind: rule.classKind,
    tool_name: rule.toolName,
    ...(rule.classMode === undefined ? {} : { class_mode: rule.classMode }),
    granted_by: rule.grantedBy,
    granted_at_ms: String(rule.grantedAtMs),
  }
}

/**
 * Convert the minimized policy view into the wire fold. `exhausted` is the
 * owner's admission decision at emission time (S-policy): the fold itself
 * never stores it, so the carrier asserts it alongside the ceiling.
 */
export function policyChangedWire(
  view: RemoteApprovalPolicyView,
  exhausted: boolean,
): PolicyChangedWire {
  return {
    rules: view.rules.map(approvalRuleWire),
    ...(view.budget === undefined
      ? {}
      : { budget: { max_total_tokens: String(view.budget.maxTotalTokens), exhausted } }),
  }
}

/**
 * Project one live `approvalPolicy` projection frame into the retained
 * stream. The frame's view is re-validated through the read-port minimizer,
 * so a malformed fold is dropped instead of crossing the carrier.
 * @param frame - ApiProxy session/projection frame for the policy key.
 * @param exhausted - The owner's current budget admission decision.
 * @returns A policy_changed payload carrying the whole fold, or null.
 */
export function projectPolicyFrame(
  frame: Extract<MuxFrame, { type: 'session/projection' }>,
  exhausted: boolean,
): Record<string, unknown> | null {
  if (frame.key !== 'approvalPolicy') return null
  const view = approvalPolicyUnitFrom(frame.value)
  if (view === undefined) return null
  return {
    event_id: `source-projection-approvalPolicy-${frame.seq}`,
    source_sequence: String(frame.seq),
    policy_changed: policyChangedWire(view, exhausted),
  }
}

/** Exact provider/model/effort triple wire shape (S-session-admin). */
export interface ModelSelectionWire {
  provider: string
  model: string
  reasoning_effort?: string
}

/** Convert the read-port's minimized model selection into the wire shape. */
export function modelSelectionWire(selection: RemoteModelSelection | undefined): ModelSelectionWire | undefined {
  if (selection === undefined) return undefined
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoning_effort: selection.reasoningEffort }),
  }
}

/** Agent-preset roster row wire shape (S-mode-select), carried by ServerHello. */
export interface AgentPresetEntryWire {
  id: string
  trust: 'TRUST_SYSTEM' | 'TRUST_USER'
  is_default: boolean
  name?: string
  description?: string
  broken?: string
}

/** Sub-agent identity/timing wire shape; uint64 fields travel as decimal strings. */
export interface SubagentViewWire {
  mode?: string
  label?: string
  settled_ms?: string
  active_since_ms?: string
  active_through_ms?: string
}

/**
 * Convert the read-port's minimized sub-agent view into the wire shape.
 * Half absence is preserved: a live frame carries only the half that changed.
 */
export function subagentViewWire(view: RemoteSubagentView | undefined): SubagentViewWire | undefined {
  if (view === undefined) return undefined
  const wire: SubagentViewWire = {}
  if (view.mode !== undefined) wire.mode = view.mode
  if (view.label !== undefined) wire.label = view.label
  if (view.settledMs !== undefined) wire.settled_ms = String(view.settledMs)
  if (view.activeSinceMs !== undefined) wire.active_since_ms = String(view.activeSinceMs)
  if (view.activeThroughMs !== undefined) wire.active_through_ms = String(view.activeThroughMs)
  return wire
}

/** Session-projection keys that carry sub-agent unit views. */
export const SUBAGENT_PROJECTION_KEYS = ['subagent', 'subagentTiming'] as const
export type SubagentProjectionKey = typeof SUBAGENT_PROJECTION_KEYS[number]

export function isSubagentProjectionKey(key: string): key is SubagentProjectionKey {
  return (SUBAGENT_PROJECTION_KEYS as readonly string[]).includes(key)
}

/**
 * Project one live sub-agent-unit projection frame into the retained stream.
 * The frame's view is re-validated through the read-port minimizer; the
 * identity unit's null sentinel (undistinguished missing-or-malformed) is
 * dropped rather than crossing as a fact.
 */
export function projectSubagentFrame(
  frame: Extract<MuxFrame, { type: 'session/projection' }>,
): Record<string, unknown> | null {
  if (!isSubagentProjectionKey(frame.key)) return null
  const unit = subagentUnitFrom(frame.key, frame.value)
  if (unit === undefined) return null
  const subagent = subagentViewWire(unit)
  if (subagent === undefined) return null
  return {
    event_id: `source-projection-${frame.key}-${frame.seq}`,
    source_sequence: String(frame.seq),
    subagent_changed: { subagent },
  }
}

/** Numbers-only usage wire shape; uint64 fields travel as decimal strings. */
export interface SessionUsageWire {
  token_usage?: {
    uncached_input_tokens: string
    output_tokens: string
    cache_read_tokens: string
    cache_write_tokens: string
  }
  context_pressure?: {
    pressure_tokens?: string
    projected_tokens?: string
    context_window?: string
  }
  stats?: {
    turns: string
    steps: string
    llm_ms: string
    tool_ms: string
  }
}

/**
 * Convert the read-port's minimized usage views into the wire shape. Unit
 * absence is preserved: an unloaded projection unit never becomes zeros.
 * @param usage - Minimized per-unit usage views, if the Host provides any.
 * @returns The proto-shaped usage message, or undefined when no unit exists.
 */
export function sessionUsageWire(usage: RemoteSessionUsage | undefined): SessionUsageWire | undefined {
  if (usage === undefined) return undefined
  const wire: SessionUsageWire = {}
  if (usage.tokenUsage !== undefined) {
    wire.token_usage = {
      uncached_input_tokens: String(usage.tokenUsage.uncachedInputTokens),
      output_tokens: String(usage.tokenUsage.outputTokens),
      cache_read_tokens: String(usage.tokenUsage.cacheReadTokens),
      cache_write_tokens: String(usage.tokenUsage.cacheWriteTokens),
    }
  }
  if (usage.contextPressure !== undefined) {
    const pressure = usage.contextPressure
    wire.context_pressure = {
      ...pressure.pressureTokens === undefined ? {} : { pressure_tokens: String(pressure.pressureTokens) },
      ...pressure.projectedTokens === undefined ? {} : { projected_tokens: String(pressure.projectedTokens) },
      ...pressure.contextWindow === undefined ? {} : { context_window: String(pressure.contextWindow) },
    }
  }
  if (usage.sessionStats !== undefined) {
    wire.stats = {
      turns: String(usage.sessionStats.turns),
      steps: String(usage.sessionStats.steps),
      llm_ms: String(usage.sessionStats.llmMs),
      tool_ms: String(usage.sessionStats.toolMs),
    }
  }
  return wire
}

/** Session-projection keys that carry usage unit views. */
export const USAGE_PROJECTION_KEYS = ['tokenUsage', 'contextPressure', 'sessionStats'] as const
export type UsageProjectionKey = typeof USAGE_PROJECTION_KEYS[number]

export function isUsageProjectionKey(key: string): key is UsageProjectionKey {
  return (USAGE_PROJECTION_KEYS as readonly string[]).includes(key)
}

/**
 * Project one live usage-unit projection frame into the retained stream.
 * The frame's view is re-validated through the read-port minimizer, so a
 * malformed unit view is dropped instead of crossing the carrier.
 * @param frame - ApiProxy session/projection frame for a usage key.
 * @returns A usage_changed payload carrying exactly the changed unit, or null.
 */
export function projectUsageFrame(
  frame: Extract<MuxFrame, { type: 'session/projection' }>,
): Record<string, unknown> | null {
  if (!isUsageProjectionKey(frame.key)) return null
  const unit = usageUnitFrom(frame.key, frame.value)
  if (unit === undefined) return null
  const usage = sessionUsageWire(unit)
  if (usage === undefined) return null
  return {
    event_id: `source-projection-${frame.key}-${frame.seq}`,
    source_sequence: String(frame.seq),
    usage_changed: usage,
  }
}

/** Bounded exact-revision protected interaction. */
export interface ApprovalInteractionWire {
  approval_id: string
  revision: string
  session_id: string
  tool_name: string
  call_id: string
  reason: string
  workspace_label: string
  allowed_decisions: Array<
    'APPROVAL_DECISION_ALLOW_ONCE' | 'APPROVAL_DECISION_DENY' | 'APPROVAL_DECISION_ALLOW_SAME_KIND'
  >
  presentation?: {
    summary: string
    risk: 'APPROVAL_RISK_ROUTINE' | 'APPROVAL_RISK_SENSITIVE' | 'APPROVAL_RISK_DESTRUCTIVE'
    resources: string[]
    consequence: string
    source: string
  }
  presentation_unavailable?: { reason: string }
}

/** Snapshot plus source watermarks needed to filter subsequent live frames. */
export interface ProjectionBaseline {
  session: SessionProjectionWire
  sourceWatermark: number
  projectionWatermark: number
  toolNames: Map<string, string>
}

/** Result of minimizing one allowlisted live source frame. */
export type LiveProjection =
  | { kind: 'event'; payload: Record<string, unknown> }
  | { kind: 'snapshot-required'; detail: string }
  | { kind: 'ignore' }

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * Extract the image blocks of one user message into wire references (S-blob).
 * A block whose attachment record is malformed states nothing and is dropped
 * rather than repaired; absence of the whole field (not an empty list) marks
 * a text-only message.
 * @param content - User-message content blocks from the session log.
 * @returns Wire references, or `undefined` when the message carries no valid image.
 */
export function imageAttachmentsWire(
  content: readonly { type: string; text?: string; attachment?: unknown }[],
): ProjectedImageAttachmentWire[] | undefined {
  const wires: ProjectedImageAttachmentWire[] = []
  for (const block of content) {
    if (block.type !== 'image') continue
    const ref = block.attachment
    if (typeof ref !== 'object' || ref === null) continue
    const record = ref as Record<string, unknown>
    const id = record.attachmentId
    const mediaType = record.mediaType
    const bytes = record.bytes
    if (typeof id !== 'string' || id === '' || id.length > 128) continue
    if (typeof mediaType !== 'string' || mediaType === '' || mediaType.length > 64) continue
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) continue
    const width = record.width
    const height = record.height
    if (width !== undefined && (typeof width !== 'number' || !Number.isSafeInteger(width) || width <= 0)) continue
    if (height !== undefined && (typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0)) continue
    const name = record.name
    if (name !== undefined && typeof name !== 'string') continue
    wires.push({
      attachment_id: id,
      media_type: mediaType,
      bytes: String(bytes),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(name === undefined || name === '' ? {} : { name: boundedText(name, 200) }),
    })
  }
  return wires.length === 0 ? undefined : wires
}

function boundedJson(value: unknown, maxChars: number): { text: string; truncated: boolean } {
  let text: string
  try {
    text = JSON.stringify(value, undefined, 2)
  } catch {
    return { text: '', truncated: true }
  }
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true }
}

function boundedText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Minimize one Host approval entry without inferring missing policy facts.
 * @param interaction - Current Host-owned live approval interaction.
 * @param maxChars - Per-field character bound for mobile projection.
 * @returns Bounded protocol approval entry.
 */
export function projectApprovalInteraction(
  interaction: HostApprovalInteraction,
  maxChars: number,
): ApprovalInteractionWire {
  // The third decision is offered only when an honest rule class is
  // derivable (S-policy) — derived from the RAW tool name and reason, since
  // the bounded copies may be truncated below derivability.
  const sameKind = deriveApprovalClass(interaction.toolName, interaction.reason) !== undefined
  const common = {
    approval_id: interaction.approvalId,
    revision: interaction.revision,
    session_id: interaction.sessionId,
    tool_name: boundedText(interaction.toolName, maxChars),
    call_id: interaction.callId ?? '',
    reason: boundedText(interaction.reason ?? '', maxChars),
    workspace_label: boundedText(interaction.workspaceLabel ?? '', maxChars),
    allowed_decisions: [
      'APPROVAL_DECISION_ALLOW_ONCE', 'APPROVAL_DECISION_DENY',
      ...(sameKind ? ['APPROVAL_DECISION_ALLOW_SAME_KIND'] as const : []),
    ] as ApprovalInteractionWire['allowed_decisions'],
  }
  if (interaction.presentation.availability === 'unavailable') {
    return { ...common, presentation_unavailable: { reason: interaction.presentation.reason } }
  }
  const value = interaction.presentation.value
  const risk = {
    routine: 'APPROVAL_RISK_ROUTINE',
    sensitive: 'APPROVAL_RISK_SENSITIVE',
    destructive: 'APPROVAL_RISK_DESTRUCTIVE',
  }[value.risk] as NonNullable<ApprovalInteractionWire['presentation']>['risk']
  return {
    ...common,
    presentation: {
      summary: boundedText(value.summary, maxChars),
      risk,
      resources: value.resources.slice(0, 8).map(resource => boundedText(resource, maxChars)),
      consequence: boundedText(value.consequence, maxChars),
      source: boundedText(value.source, maxChars),
    },
  }
}

/**
 * Project one live approval lifecycle frame into the retained Remote stream.
 * @param frame - ApiProxy approval request or resolution frame.
 * @param maxChars - Per-field character bound for mobile projection.
 * @returns Retained-stream event payload.
 */
export function projectApprovalFrame(
  frame: Extract<MuxFrame, { type: 'approval/requested' | 'approval/resolved' }>,
  maxChars: number,
): Record<string, unknown> {
  const common = {
    event_id: `approval-${frame.approvalId}-${frame.revision}`,
    source_sequence: '0',
  }
  if (frame.type === 'approval/requested') {
    return {
      ...common,
      approval_changed: {
        approval_id: frame.approvalId,
        revision: frame.revision,
        pending: projectApprovalInteraction({
          revision: frame.revision,
          sessionId: frame.sessionId,
          approvalId: frame.approvalId,
          toolName: frame.toolName,
          ...frame.callId === undefined ? {} : { callId: frame.callId },
          ...frame.reason === undefined ? {} : { reason: frame.reason },
          ...frame.workspaceLabel === undefined ? {} : { workspaceLabel: frame.workspaceLabel },
          allowedOutcomes: ['allowed-once', 'rejected'],
          presentation: frame.presentation,
        }, maxChars),
      },
    }
  }
  const decision = frame.outcome === 'allowed-once'
    ? 'APPROVAL_DECISION_ALLOW_ONCE'
    : frame.outcome === 'rejected'
      ? 'APPROVAL_DECISION_DENY'
      : 'APPROVAL_DECISION_UNSPECIFIED'
  return {
    ...common,
    approval_changed: {
      approval_id: frame.approvalId,
      revision: frame.revision,
      resolved: { decision, terminal: frame.outcome },
    },
  }
}

/**
 * Project one content-free user-input attention count into the retained stream.
 * @param frame - Host-owned interaction identity and current pending count.
 * @returns A minimized projected event containing no question content or answer authority.
 */
export function projectInputAttentionFrame(
  frame: { interactionId: string; pendingCount: number },
): Record<string, unknown> {
  return {
    event_id: `question-${frame.interactionId}`,
    source_sequence: '0',
    input_attention_changed: { pending_count: frame.pendingCount },
  }
}

function cardKind(view: ToolEventView['view'] | undefined): ToolPresentationWire['kind'] {
  if (view === undefined) return 'KIND_UNSUPPORTED'
  switch (view.card) {
    case 'terminal': return 'KIND_TERMINAL'
    case 'diff': return 'KIND_DIFF'
    default: return 'KIND_GENERIC'
  }
}

function viewTitle(view: ToolEventView['view'] | undefined): string | undefined {
  if (view === undefined || !('title' in view)) return undefined
  return typeof view.title === 'string' && view.title !== ''
    ? view.title
    : undefined
}

/**
 * Minimize the path-bearing fields a tool view carries across the carrier:
 * the `locations`/`diffs` path fields, plus every occurrence of those same raw
 * paths inside the presenter title (presenters compose titles from the raw
 * path, e.g. `Write <file_path>`). The workspace root stays a Host-side
 * matching key; an outside path reduces to its final component, exactly like
 * the artifact roster. Terminal command text is the model's literal record
 * and is never rewritten.
 */
function minimizeToolViewPaths(
  view: ToolEventView['view'],
  cwd: string | undefined,
): ToolEventView['view'] {
  const record = view as unknown as Record<string, unknown>
  const rawPaths: string[] = []
  const minimizeEntries = (value: unknown): unknown[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const entries: readonly unknown[] = value
    return entries.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return entry
      const record = entry as Record<string, unknown>
      const path = record.path
      if (typeof path !== 'string' || path === '') return entry
      rawPaths.push(path)
      const minimized = minimizePath(path, cwd).minimized
      return minimized === path ? entry : { ...record, path: minimized }
    })
  }
  const locations = minimizeEntries(record.locations)
  const diffs = minimizeEntries(record.diffs)
  let title = typeof record.title === 'string' && record.title !== '' ? record.title : undefined
  if (title !== undefined) {
    // Longest first so a nested path rewrites before its prefix can shadow it.
    for (const raw of [...new Set(rawPaths)].sort((a, b) => b.length - a.length)) {
      const minimized = minimizePath(raw, cwd).minimized
      if (minimized === raw) continue
      title = title.replaceAll(raw, minimized)
      const normalized = normalizeSlashes(raw)
      if (normalized !== raw) title = title.replaceAll(normalized, minimized)
    }
  }
  return {
    ...view,
    ...(locations === undefined ? {} : { locations }),
    ...(diffs === undefined ? {} : { diffs }),
    ...(title === undefined || title === record.title ? {} : { title }),
  } as unknown as ToolEventView['view']
}

function toolPresentation(
  callId: string,
  toolName: string,
  view: ToolEventView | undefined,
  fallbackView: ToolEventView | undefined,
  maxChars: number,
  cwd: string | undefined,
): ToolPresentationWire {
  // Paths minimize before anything else reads the view, so the summary and the
  // bounded JSON carry the identical minimized shape.
  const minimizedView = view === undefined ? undefined : minimizeToolViewPaths(view.view, cwd)
  const minimizedFallback = fallbackView === undefined ? undefined : minimizeToolViewPaths(fallbackView.view, cwd)
  const effective = minimizedView ?? minimizedFallback
  // An absent presenter is deliberately name-only. Raw args/results may carry
  // secrets and are not a safe generic mobile fallback.
  const bounded = effective === undefined
    ? { text: '', truncated: false }
    : boundedJson(effective, maxChars)
  return {
    kind: cardKind(effective),
    call_id: callId,
    tool_name: toolName,
    summary: viewTitle(minimizedView) ?? viewTitle(minimizedFallback) ?? toolName,
    bounded_content: bounded.text,
    truncated: bounded.truncated,
  }
}

function eventId(event: SessionEvent): string {
  return `source-event-${event.seq}`
}

const SOURCE_FIELD_BOUND = 100

/**
 * Minimize a durable user/message source to bounded provenance. Identifiers
 * (rpcId, promptCorrelation) never cross; plugin/form travel only for plugin
 * (injected-context) sources.
 */
function messageSourceWire(source: unknown): MessageSourceWire | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  const kind = record.kind
  if (typeof kind !== 'string' || kind === '' || kind.length > SOURCE_FIELD_BOUND) return undefined
  const wire: MessageSourceWire = { kind }
  if (kind === 'plugin') {
    const { plugin, form } = record
    if (typeof plugin === 'string' && plugin !== '' && plugin.length <= SOURCE_FIELD_BOUND) wire.plugin = plugin
    if (typeof form === 'string' && form !== '' && form.length <= SOURCE_FIELD_BOUND) wire.form = form
  }
  return wire
}

/** Durable turn/end reason kinds mapped onto the closed wire enum. */
const TURN_END_REASON_WIRE: Record<string, string> = {
  completed: 'TURN_END_REASON_COMPLETED',
  aborted: 'TURN_END_REASON_ABORTED',
  blocked: 'TURN_END_REASON_BLOCKED',
  error: 'TURN_END_REASON_ERROR',
  'max-tokens': 'TURN_END_REASON_MAX_TOKENS',
  interrupted: 'TURN_END_REASON_INTERRUPTED',
}

/** Map a merge-extensible turn/end reason; plugin-extended kinds stay absent. */
function turnEndReasonWire(reason: unknown): string | undefined {
  if (typeof reason !== 'object' || reason === null) return undefined
  const kind = (reason as Record<string, unknown>).kind
  return typeof kind === 'string' ? TURN_END_REASON_WIRE[kind] : undefined
}

function currentSurfaceSequences(entries: readonly HistoryEntry[], truncated: boolean): Set<number> {
  if (truncated) {
    return new Set(entries
      .map(entry => entry.event)
      .filter(event => event.type === 'user/message'
        || event.type === 'assistant/message'
        || event.type === 'tool/result')
      .map(event => event.seq))
  }
  return new Set(foldSurface(entries.map(entry => entry.event)).nodes)
}

function fallbackTitle(entries: readonly HistoryEntry[]): string {
  for (const { event } of entries) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = textOf(event.data.content)
    if (text !== '') return text.length <= 80 ? text : `${text.slice(0, 79)}…`
  }
  return ''
}

function activeTurn(entries: readonly HistoryEntry[]): number | undefined {
  let open: number | undefined
  for (const { event } of entries) {
    if (event.type === 'turn/start') open = event.data.turn
    else if (event.type === 'turn/end' && open === event.data.turn) open = undefined
  }
  return open
}

/**
 * Build one source-ordered transcript, including unfinalized partials, from an ApiProxy history cut.
 * @param input - Current Session state, history entries, watermarks, and content bounds.
 * @returns The minimized snapshot and its live-frame filtering state.
 */
export function projectSnapshot(input: {
  sessionId: string
  running: boolean
  title?: string
  usage?: RemoteSessionUsage
  subagent?: RemoteSubagentView
  agentPreset?: string
  model?: RemoteModelSelection
  /** Active policy fold (S-policy); absent means the owner served none. */
  policy?: RemoteApprovalPolicyView
  /** The owner's budget admission decision at snapshot time (S-policy). */
  budgetExhausted?: boolean
  entries: readonly HistoryEntry[]
  historyTruncated: boolean
  sourceWatermark: number
  projectionWatermark: number
  maxToolContentChars: number
  approvals?: readonly HostApprovalInteraction[]
  pendingInputCount?: number
  /** Session workspace root: the matching key that minimizes tool-card paths. */
  cwd?: string
}): ProjectionBaseline {
  const surface = currentSurfaceSequences(input.entries, input.historyTruncated)
  const timeline: TimelineNodeWire[] = []
  const calls = new Map<string, { name: string; entry: HistoryEntry }>()
  const completedCalls = new Set<string>()
  const finalizedSteps = new Set<string>()

  for (const entry of input.entries) {
    const event = entry.event
    if (event.type === 'tool/call') {
      calls.set(event.data.callId, { name: event.data.name, entry })
    } else if (event.type === 'tool/result') {
      completedCalls.add(event.data.message.source.callId)
    } else if (event.type === 'assistant/message') {
      finalizedSteps.add(`${event.data.turn}:${event.data.step}`)
    }
  }

  for (const entry of input.entries) {
    const event = entry.event
    if (!surface.has(event.seq)) continue
    if (event.type === 'user/message') {
      const source = messageSourceWire(event.data.source)
      const text = textOf(event.data.content)
      const attachments = imageAttachmentsWire(event.data.content)
      timeline.push({
        event_id: eventId(event),
        source_sequence: String(event.seq),
        user_message: {
          // Injected context is bounded like tool content; human prompts are not.
          text: source?.kind === 'plugin' ? boundedText(text, input.maxToolContentChars) : text,
          ...(source === undefined ? {} : { source }),
          ...(attachments === undefined ? {} : { attachments }),
        },
      })
    } else if (event.type === 'assistant/message') {
      timeline.push({
        event_id: eventId(event),
        source_sequence: String(event.seq),
        assistant_message: {
          text: textOf(event.data.message.content),
          final: true,
          message_id: `assistant-${event.data.turn}-${event.data.step}`,
        },
      })
    } else {
      // `surface` is produced by Session's canonical fold and can contain only
      // user/message, assistant/message or tool/result sequence numbers.
      const result = event as SessionEvent<'tool/result'>
      const callId = result.data.message.source.callId
      const call = calls.get(callId)
      timeline.push({
        event_id: `source-tool-${callId}`,
        source_sequence: String(result.seq),
        tool_presentation: toolPresentation(
          callId,
          call?.name ?? 'tool',
          entry.view,
          call?.entry.view,
          input.maxToolContentChars,
          input.cwd,
        ),
      })
    }
  }

  const chunks = new Map<string, { text: string; last: SessionEvent<'assistant/chunk'> }>()
  for (const { event } of input.entries) {
    if (event.type !== 'assistant/chunk' || event.data.chunk.type !== 'text-delta') continue
    const key = `${event.data.turn}:${event.data.step}`
    if (finalizedSteps.has(key)) continue
    const prior = chunks.get(key)
    chunks.set(key, { text: `${prior?.text ?? ''}${event.data.chunk.text}`, last: event })
  }
  for (const [key, partial] of chunks) {
    timeline.push({
      event_id: `source-assistant-${key}`,
      source_sequence: String(partial.last.seq),
      assistant_message: {
        text: partial.text,
        final: false,
        message_id: `assistant-${key.replace(':', '-')}`,
      },
    })
  }

  for (const [callId, call] of calls) {
    if (completedCalls.has(callId)) continue
    timeline.push({
      event_id: `source-tool-${callId}`,
      source_sequence: String(call.entry.event.seq),
      tool_presentation: toolPresentation(
        callId,
        call.name,
        call.entry.view,
        undefined,
        input.maxToolContentChars,
        input.cwd,
      ),
    })
  }

  timeline.sort((left, right) => Number(left.source_sequence) - Number(right.source_sequence))

  const usage = sessionUsageWire(input.usage)
  const subagent = subagentViewWire(input.subagent)
  const model = modelSelectionWire(input.model)
  const policyWire = policyChangedWire(input.policy ?? { rules: [] }, input.budgetExhausted === true)
  return {
    session: {
      session_id: input.sessionId,
      title: input.title ?? fallbackTitle(input.entries),
      running: input.running,
      timeline,
      history_truncated: input.historyTruncated,
      activity_revision: String(activeTurn(input.entries) ?? 0),
      approvals: (input.approvals ?? []).map(interaction =>
        projectApprovalInteraction(interaction, input.maxToolContentChars)),
      pending_input_count: input.pendingInputCount ?? 0,
      ...(usage === undefined ? {} : { usage }),
      ...(subagent === undefined ? {} : { subagent }),
      ...(input.agentPreset === undefined ? {} : { agent_preset: input.agentPreset }),
      ...(model === undefined ? {} : { model }),
      approval_rules: policyWire.rules,
      ...(policyWire.budget === undefined ? {} : { budget: policyWire.budget }),
    },
    sourceWatermark: input.sourceWatermark,
    projectionWatermark: input.projectionWatermark,
    toolNames: new Map([...calls].map(([callId, value]) => [callId, value.name])),
  }
}

/**
 * Map one allowlisted live source frame to a v1alpha projected event.
 * @param input - Source event, optional Host view, tool-name state, and content bound.
 * @returns A projected event, snapshot invalidation request, or ignore decision.
 */
export function projectLiveFrame(input: {
  event: SessionEvent
  view?: ToolEventView
  toolNames: Map<string, string>
  maxToolContentChars: number
  /** Session workspace root: the matching key that minimizes tool-card paths. */
  cwd?: string
}): LiveProjection {
  const { event } = input
  if ('surfaceOp' in event && typeof event.surfaceOp === 'object') {
    return { kind: 'snapshot-required', detail: 'session surface was replaced' }
  }
  const common = {
    event_id: eventId(event),
    source_sequence: String(event.seq),
  }
  // Blank-session-only preset fact (S-mode-select). The type is owned by
  // dsh-agent-presets' module augmentation, which this package deliberately
  // does not import, so compare through a widened string and read the payload
  // defensively; an unbounded or empty id states nothing honest.
  const eventType: string = event.type
  if (eventType === 'agent-preset/selected') {
    const raw = (event.data as { agentPreset?: unknown }).agentPreset
    const agentPreset = typeof raw === 'string' && raw !== '' && raw.length <= 100 ? raw : undefined
    if (agentPreset === undefined) return { kind: 'ignore' }
    return {
      kind: 'event',
      payload: { ...common, agent_preset_changed: { agent_preset: agentPreset } },
    }
  }
  switch (event.type) {
    case 'request/header': {
      // Only an explicit change is news: initial/resume headers are already
      // stated by the snapshot's session model field (S-session-admin).
      if (event.data.reason !== 'change') return { kind: 'ignore' }
      const config = event.data.header.config
      const provider = typeof config.provider === 'string' && config.provider !== '' && config.provider.length <= 100
        ? config.provider
        : undefined
      const model = typeof config.model === 'string' && config.model !== '' && config.model.length <= 200
        ? config.model
        : undefined
      if (provider === undefined || model === undefined) return { kind: 'ignore' }
      const effort = typeof config.reasoningEffort === 'string' && config.reasoningEffort !== ''
        && config.reasoningEffort.length <= 100
        ? config.reasoningEffort
        : undefined
      return {
        kind: 'event',
        payload: {
          ...common,
          model_changed: {
            provider,
            model,
            ...(effort === undefined ? {} : { reasoning_effort: effort }),
          },
        },
      }
    }
    case 'turn/start':
      return {
        kind: 'event',
        payload: { ...common, session_status_changed: { running: true, activity_revision: String(event.data.turn) } },
      }
    case 'turn/end': {
      const reason = turnEndReasonWire(event.data.reason)
      return {
        kind: 'event',
        payload: {
          ...common,
          session_status_changed: {
            running: false,
            activity_revision: '0',
            ...(reason === undefined ? {} : { turn_end_reason: reason }),
          },
        },
      }
    }
    case 'user/message': {
      const source = messageSourceWire(event.data.source)
      const text = textOf(event.data.content)
      const attachments = imageAttachmentsWire(event.data.content)
      return {
        kind: 'event',
        payload: {
          ...common,
          user_message_added: {
            message_id: event.data.id,
            text: source?.kind === 'plugin' ? boundedText(text, input.maxToolContentChars) : text,
            ...(source === undefined ? {} : { source }),
            ...(attachments === undefined ? {} : { attachments }),
          },
        },
      }
    }
    case 'assistant/chunk': {
      if (event.data.chunk.type !== 'text-delta' || event.data.chunk.text === '') return { kind: 'ignore' }
      return {
        kind: 'event',
        payload: {
          ...common,
          assistant_delta: {
            message_id: `assistant-${event.data.turn}-${event.data.step}`,
            text_delta: event.data.chunk.text,
          },
        },
      }
    }
    case 'assistant/message':
      return {
        kind: 'event',
        payload: {
          ...common,
          assistant_completed: {
            message_id: `assistant-${event.data.turn}-${event.data.step}`,
            text: textOf(event.data.message.content),
          },
        },
      }
    case 'tool/call': {
      input.toolNames.set(event.data.callId, event.data.name)
      return {
        kind: 'event',
        payload: {
          ...common,
          tool_presentation_changed: {
            presentation: toolPresentation(
              event.data.callId,
              event.data.name,
              input.view,
              undefined,
              input.maxToolContentChars,
              input.cwd,
            ),
          },
        },
      }
    }
    case 'tool/result': {
      const callId = event.data.message.source.callId
      return {
        kind: 'event',
        payload: {
          ...common,
          tool_presentation_changed: {
            presentation: toolPresentation(
              callId,
              input.toolNames.get(callId) ?? 'tool',
              input.view,
              undefined,
              input.maxToolContentChars,
              input.cwd,
            ),
          },
        },
      }
    }
    default:
      return { kind: 'ignore' }
  }
}
