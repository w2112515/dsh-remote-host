/** Durable schemas for Remote command idempotency and control fencing. */

import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  RemoteCommandCommit,
  RemoteCommandId,
  RemoteCommandRejection,
  RemoteCommandRow,
  RemoteControlEpoch,
  RemoteDeviceId,
} from './types.ts'

const UINT64_MAX = 18_446_744_073_709_551_615n
const asciiIdentifier = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/)
const hex16 = z.string().length(32).regex(/^[0-9a-f]+$/)
const hex32 = z.string().length(64).regex(/^[0-9a-f]+$/)
const decimalUint64 = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(value => BigInt(value) <= UINT64_MAX)
const safeTimestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Runtime command-id schema. */
export const remoteCommandIdSchema = asciiIdentifier.transform(value => value as RemoteCommandId)
/** Runtime stable-device schema. */
export const remoteDeviceIdSchema = hex16.transform(value => value as RemoteDeviceId)
/** Runtime control-epoch schema. */
export const remoteControlEpochSchema = decimalUint64.transform(value => value as RemoteControlEpoch)

const bindingFields = {
  commandId: remoteCommandIdSchema,
  operation: z.enum([
    'send_input', 'stop', 'decide_approval', 'create_session', 'select_agent_preset',
    'select_model', 'fork_session', 'revoke_approval_rule', 'set_session_budget',
  ]),
  sessionId: z.string().min(1).max(256).transform(value => value as SessionId),
  requestFingerprint: hex32,
  deviceId: remoteDeviceIdSchema,
  authorityEpoch: decimalUint64,
  controlEpoch: remoteControlEpochSchema.optional(),
  targetTurn: safeTimestamp.optional(),
  approvalId: asciiIdentifier.optional(),
  approvalRevision: asciiIdentifier.optional(),
  approvalOutcome: z.enum(['allowed-once', 'rejected']).optional(),
  agentPreset: asciiIdentifier.optional(),
  modelSelection: z.object({
    provider: asciiIdentifier.max(100),
    model: z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/),
    reasoningEffort: asciiIdentifier.max(100).optional(),
  }).optional(),
  childSessionId: z.string().min(1).max(256).transform(value => value as SessionId).optional(),
  forkAtSeq: safeTimestamp.optional(),
  ruleId: asciiIdentifier.optional(),
  maxTotalTokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
} as const

const baseFields = {
  ...bindingFields,
  correlation: z.uuid().transform(value => value as RemoteCommandRow['correlation']),
  createdAtMs: safeTimestamp,
  updatedAtMs: safeTimestamp,
} as const

/** Runtime Session correlation schema. */
export const remoteCommandCommitSchema = z.union([
  z.object({
    sessionEventSeq: safeTimestamp,
    messageId: z.string().min(1).max(256),
  }),
  z.object({
    targetTurn: safeTimestamp,
    turnEndSeq: safeTimestamp,
  }),
  z.object({
    approvalId: asciiIdentifier,
    outcome: z.enum(['allowed-once', 'rejected']),
    decidedEventSeq: safeTimestamp,
  }),
  z.object({
    created: z.literal(true),
    agentPreset: asciiIdentifier.optional(),
  }),
  z.object({
    selectedPreset: asciiIdentifier,
  }),
  z.object({
    selectedModel: z.object({
      provider: asciiIdentifier.max(100),
      model: z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/),
      reasoningEffort: asciiIdentifier.max(100).optional(),
    }),
  }),
  z.object({
    forked: z.literal(true),
    childSessionId: z.string().min(1).max(256).transform(value => value as SessionId),
  }),
  z.object({
    revokedRuleId: asciiIdentifier,
  }),
  z.object({
    budgetSet: z.literal(true),
    maxTotalTokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }),
]) satisfies z.ZodType<RemoteCommandCommit>

/** Runtime definitive-rejection schema. */
export const remoteCommandRejectionSchema = z.object({
  code: asciiIdentifier,
}) satisfies z.ZodType<RemoteCommandRejection>

/** Runtime schema for one journal row. */
export const remoteCommandRowSchema = z.discriminatedUnion('phase', [
  z.object({ ...baseFields, phase: z.literal('reserved'), revision: z.literal(0) }),
  z.object({
    ...baseFields,
    phase: z.literal('requested'),
    revision: z.literal(1),
    requested: z.object({ targetTurn: safeTimestamp }),
  }),
  z.object({
    ...baseFields,
    phase: z.literal('committed'),
    revision: z.union([z.literal(1), z.literal(2)]),
    commit: remoteCommandCommitSchema,
  }),
  z.object({
    ...baseFields,
    phase: z.literal('rejected'),
    revision: z.literal(1),
    rejection: remoteCommandRejectionSchema,
  }),
]).superRefine((row, ctx) => {
  if (row.updatedAtMs < row.createdAtMs) {
    ctx.addIssue({ code: 'custom', path: ['updatedAtMs'], message: 'updatedAtMs must not precede createdAtMs' })
  }
  if ((row.operation === 'stop') !== (row.targetTurn !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['targetTurn'], message: 'targetTurn must exist only for stop' })
  }
  const controlled = row.operation === 'send_input' || row.operation === 'stop' || row.operation === 'select_model'
  if (controlled !== (row.controlEpoch !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['controlEpoch'], message: 'controlEpoch must exist only for controlled operations' })
  }
  const approval = row.operation === 'decide_approval'
  if (approval !== (row.approvalId !== undefined
    && row.approvalRevision !== undefined
    && row.approvalOutcome !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['approvalId'], message: 'approval binding fields must exist only for decide_approval' })
  }
  const presetOperation = row.operation === 'create_session' || row.operation === 'select_agent_preset'
  if (!presetOperation && row.agentPreset !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['agentPreset'], message: 'agentPreset must exist only for preset operations' })
  }
  if (row.operation === 'select_agent_preset' && row.agentPreset === undefined) {
    ctx.addIssue({ code: 'custom', path: ['agentPreset'], message: 'select_agent_preset binding must name a preset' })
  }
  const modelOperation = row.operation === 'select_model'
  if (modelOperation !== (row.modelSelection !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['modelSelection'], message: 'modelSelection must exist only for select_model' })
  }
  const forkOperation = row.operation === 'fork_session'
  if (forkOperation !== (row.childSessionId !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['childSessionId'], message: 'childSessionId must exist only for fork_session' })
  }
  if (!forkOperation && row.forkAtSeq !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['forkAtSeq'], message: 'forkAtSeq must exist only for fork_session' })
  }
  if ((row.operation === 'revoke_approval_rule') !== (row.ruleId !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['ruleId'], message: 'ruleId must exist only for revoke_approval_rule' })
  }
  if ((row.operation === 'set_session_budget') !== (row.maxTotalTokens !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['maxTotalTokens'], message: 'maxTotalTokens must exist only for set_session_budget' })
  }
  if (row.phase === 'requested') {
    if (row.operation !== 'stop' || row.targetTurn !== row.requested.targetTurn) {
      ctx.addIssue({ code: 'custom', path: ['requested'], message: 'requested turn must match stop binding' })
    }
  }
  if (row.phase === 'committed') {
    const stopCommit = 'turnEndSeq' in row.commit
    const approvalCommit = 'decidedEventSeq' in row.commit
    const createCommit = 'created' in row.commit
    const selectCommit = 'selectedPreset' in row.commit
    const modelCommit = 'selectedModel' in row.commit
    const forkCommit = 'forked' in row.commit
    const revokeCommit = 'revokedRuleId' in row.commit
    const budgetCommit = 'budgetSet' in row.commit
    if (row.operation === 'stop') {
      if (!stopCommit || approvalCommit || row.revision !== 2
        || row.targetTurn !== ('targetTurn' in row.commit ? row.commit.targetTurn : undefined)) {
        ctx.addIssue({ code: 'custom', path: ['commit'], message: 'stop commit must match target turn at revision 2' })
      }
    } else if (row.operation === 'decide_approval') {
      if (!approvalCommit || stopCommit || row.revision !== 1
        || row.approvalId !== ('approvalId' in row.commit ? row.commit.approvalId : undefined)
        || row.approvalOutcome !== ('outcome' in row.commit ? row.commit.outcome : undefined)) {
        ctx.addIssue({ code: 'custom', path: ['commit'], message: 'approval commit must match the exact decision at revision 1' })
      }
    } else if (row.operation === 'create_session') {
      if (!createCommit || row.revision !== 1
        || (row.agentPreset !== undefined
          && 'agentPreset' in row.commit
          && row.commit.agentPreset !== undefined
          && row.commit.agentPreset !== row.agentPreset)) {
        ctx.addIssue({ code: 'custom', path: ['commit'], message: 'create commit must record creation at revision 1 and match any bound preset' })
      }
    } else if (row.operation === 'select_agent_preset') {
      if (!selectCommit || row.revision !== 1
        || ('selectedPreset' in row.commit && row.commit.selectedPreset !== row.agentPreset)) {
        ctx.addIssue({ code: 'custom', path: ['commit'], message: 'select commit must record the exact bound preset at revision 1' })
      }
    } else if (row.operation === 'select_model') {
      if (!modelCommit || row.revision !== 1
        || ('selectedModel' in row.commit && row.modelSelection !== undefined
          && (row.commit.selectedModel.provider !== row.modelSelection.provider
            || row.commit.selectedModel.model !== row.modelSelection.model
            || row.commit.selectedModel.reasoningEffort !== row.modelSelection.reasoningEffort))) {
        ctx.addIssue({ code: 'custom', path: ['commit'], message: 'select_model commit must record the exact bound triple at revision 1' })
      }
    } else if (row.operation === 'fork_session') {
      if (!forkCommit || row.revision !== 1
        || ('childSessionId' in row.commit && row.commit.childSessionId !== row.childSessionId)) {
        ctx.addIssue({ code: 'custom', path: ['commit'], message: 'fork commit must record the bound child session at revision 1' })
      }
    } else if (row.operation === 'revoke_approval_rule') {
      if (!revokeCommit || row.revision !== 1
        || ('revokedRuleId' in row.commit && row.commit.revokedRuleId !== row.ruleId)) {
        ctx.addIssue({ code: 'custom', path: ['commit'], message: 'revoke commit must record the exact bound rule at revision 1' })
      }
    } else if (row.operation === 'set_session_budget') {
      if (!budgetCommit || row.revision !== 1
        || ('maxTotalTokens' in row.commit && row.commit.maxTotalTokens !== row.maxTotalTokens)) {
        ctx.addIssue({ code: 'custom', path: ['commit'], message: 'budget commit must record the exact bound ceiling at revision 1' })
      }
    } else if (stopCommit || approvalCommit || createCommit || selectCommit || modelCommit || forkCommit
      || revokeCommit || budgetCommit || row.revision !== 1) {
      ctx.addIssue({ code: 'custom', path: ['commit'], message: 'send commit must carry Inbox correlation at revision 1' })
    }
  }
}) as z.ZodType<RemoteCommandRow>

/** Runtime schema for the semantic reservation binding. */
export const remoteCommandBindingSchema = z.object(bindingFields).superRefine((binding, ctx) => {
  if ((binding.operation === 'stop') !== (binding.targetTurn !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['targetTurn'], message: 'targetTurn must exist only for stop' })
  }
  const controlled = binding.operation === 'send_input' || binding.operation === 'stop' || binding.operation === 'select_model'
  if (controlled !== (binding.controlEpoch !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['controlEpoch'], message: 'controlEpoch must exist only for controlled operations' })
  }
  const approval = binding.operation === 'decide_approval'
  if (approval !== (binding.approvalId !== undefined
    && binding.approvalRevision !== undefined
    && binding.approvalOutcome !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['approvalId'], message: 'approval binding fields must exist only for decide_approval' })
  }
  const presetOperation = binding.operation === 'create_session' || binding.operation === 'select_agent_preset'
  if (!presetOperation && binding.agentPreset !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['agentPreset'], message: 'agentPreset must exist only for preset operations' })
  }
  if (binding.operation === 'select_agent_preset' && binding.agentPreset === undefined) {
    ctx.addIssue({ code: 'custom', path: ['agentPreset'], message: 'select_agent_preset binding must name a preset' })
  }
  const modelOperation = binding.operation === 'select_model'
  if (modelOperation !== (binding.modelSelection !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['modelSelection'], message: 'modelSelection must exist only for select_model' })
  }
  const forkOperation = binding.operation === 'fork_session'
  if (forkOperation !== (binding.childSessionId !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['childSessionId'], message: 'childSessionId must exist only for fork_session' })
  }
  if (!forkOperation && binding.forkAtSeq !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['forkAtSeq'], message: 'forkAtSeq must exist only for fork_session' })
  }
  if ((binding.operation === 'revoke_approval_rule') !== (binding.ruleId !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['ruleId'], message: 'ruleId must exist only for revoke_approval_rule' })
  }
  if ((binding.operation === 'set_session_budget') !== (binding.maxTotalTokens !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['maxTotalTokens'], message: 'maxTotalTokens must exist only for set_session_budget' })
  }
})

/** Durable command format; a mismatch fails effect admission closed. */
export const remoteCommandJournalSpec = defineDomain({
  name: 'remote_command_journal',
  version: 0,
  tables: {
    commands: domainTable<RemoteCommandId, RemoteCommandRow>(remoteCommandRowSchema),
  },
})

/** Durable per-Session epoch tombstone. Active holders and secrets stay in memory. */
export const remoteControlFenceRowSchema = z.object({
  sessionId: z.string().min(1).max(256).transform(value => value as SessionId),
  lastEpoch: remoteControlEpochSchema,
})

/** Durable control-fence row. */
export type RemoteControlFenceRow = z.infer<typeof remoteControlFenceRowSchema>

/** Durable control-fence format; rows are never deleted or reset. */
export const remoteControlFenceSpec = defineDomain({
  name: 'remote_control_fences',
  version: 0,
  tables: {
    sessions: domainTable<SessionId, RemoteControlFenceRow>(remoteControlFenceRowSchema),
  },
})
