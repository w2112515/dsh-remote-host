/**
 * @w2112515/dsh-remote-host/control — durable Host-global command
 * idempotency plus Session-scoped control leases. It owns no transport and
 * executes no DSH effect by itself.
 * @module @w2112515/dsh-remote-host/control
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  RemoteCommandJournal, fingerprintRemoteApprovalDecision, fingerprintRemoteCreateSession,
  fingerprintRemoteForkSession, fingerprintRemoteRevokeApprovalRule,
  fingerprintRemoteSelectAgentPreset, fingerprintRemoteSelectModel,
  fingerprintRemoteSendInput, fingerprintRemoteSetSessionBudget, fingerprintRemoteStop,
} from './journal.ts'
import { RemoteControlLeases } from './lease.ts'
import { remoteCommandJournalSpec, remoteControlFenceSpec } from './spec.ts'
import type {
  RemoteCommandBinding,
  RemoteCommandCommit,
  RemoteCommandCommitted,
  RemoteCommandId,
  RemoteCommandRejected,
  RemoteCommandRequested,
  RemoteCommandRejection,
  RemoteCommandReservation,
  RemoteCommandRow,
  RemoteStopRequested,
  RemoteControlAdmissionResult,
  RemoteControlFailure,
  RemoteControlLeaseResult,
  RemoteControlProof,
  RemoteControlService,
  RemoteDeviceId,
} from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

export {
  fingerprintRemoteApprovalDecision, fingerprintRemoteCreateSession,
  fingerprintRemoteForkSession, fingerprintRemoteRevokeApprovalRule,
  fingerprintRemoteSelectAgentPreset, fingerprintRemoteSelectModel,
  fingerprintRemoteSendInput, fingerprintRemoteSetSessionBudget, fingerprintRemoteStop,
}
export type {
  RemoteCommandBinding, RemoteCommandCommit, RemoteCommandCommitted, RemoteCommandCorrelation,
  RemoteCommandId, RemoteCommandRejected, RemoteCommandRejection, RemoteCommandRequested,
  RemoteCommandReservation, RemoteCommandReserved, RemoteCommandRow, RemoteSendInputCommit,
  RemoteApprovalDecisionCommit, RemoteCreateSessionCommit, RemoteForkSessionCommit,
  RemoteRevokeApprovalRuleCommit, RemoteSelectAgentPresetCommit, RemoteSelectModelCommit,
  RemoteSetSessionBudgetCommit,
  RemoteStopCommit, RemoteStopRequested, RemoteControlAdmissionResult, RemoteControlEpoch,
  RemoteControlFailure, RemoteControlLease, RemoteControlLeaseResult, RemoteControlProof,
  RemoteControlService, RemoteControlToken, RemoteDeviceId,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-side journal and control-fence owner; transports receive only narrow method closures. */
    remoteControl: RemoteControlService
  }
}

/** Stable Cordis function-plugin name. */
export const name = 'host-remote-control'
/** Durable data-form dependency; the read-only Remote carrier remains independent. */
export const inject = ['storageDomain']

/** Deployment policy for short-lived controller ownership. */
export interface Config {
  /** Lease lifetime applied to acquire, renew, and transfer. @default 30000 */
  leaseTtlMs?: number
}

export const Config: z<Config> = z.object({
  leaseTtlMs: z.number().step(1).min(1_000).max(600_000).default(30_000),
})

/** Concrete owner mounted behind `ctx.remoteControl`. */
class RemoteControlAuthority implements RemoteControlService {
  constructor(
    private readonly journal: RemoteCommandJournal,
    private readonly leases: RemoteControlLeases,
  ) {}

  reserveCommand(binding: RemoteCommandBinding): Promise<RemoteCommandReservation> {
    return this.journal.reserve(binding)
  }

  lookupCommand(commandId: RemoteCommandId): Promise<RemoteCommandRow | undefined> {
    return this.journal.lookup(commandId)
  }

  markCommandRequested(
    commandId: RemoteCommandId,
    expectedFingerprint: string,
    requested: RemoteStopRequested,
  ): Promise<RemoteCommandRequested> {
    return this.journal.markRequested(commandId, expectedFingerprint, requested)
  }

  commitCommand(
    commandId: RemoteCommandId,
    expectedFingerprint: string,
    commit: RemoteCommandCommit,
  ): Promise<RemoteCommandCommitted> {
    return this.journal.commit(commandId, expectedFingerprint, commit)
  }

  rejectCommand(
    commandId: RemoteCommandId,
    expectedFingerprint: string,
    rejection: RemoteCommandRejection,
  ): Promise<RemoteCommandRejected> {
    return this.journal.reject(commandId, expectedFingerprint, rejection)
  }

  acquireControl(sessionId: SessionId, deviceId: RemoteDeviceId): Promise<RemoteControlLeaseResult> {
    return this.leases.acquire(sessionId, deviceId)
  }

  renewControl(lease: RemoteControlProof): Promise<RemoteControlLeaseResult> {
    return this.leases.renew(lease)
  }

  transferControl(lease: RemoteControlProof, nextDeviceId: RemoteDeviceId): Promise<RemoteControlLeaseResult> {
    return this.leases.transfer(lease, nextDeviceId)
  }

  releaseControl(lease: RemoteControlProof): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: RemoteControlFailure }
  > {
    return this.leases.release(lease)
  }

  invalidateDevice(deviceId: RemoteDeviceId): Promise<void> {
    return this.leases.invalidateDevice(deviceId)
  }

  admit<T>(
    lease: RemoteControlProof,
    authorize: () => void,
    effect: () => T,
  ): Promise<RemoteControlAdmissionResult<T>> {
    return this.leases.admit(lease, authorize, effect)
  }

  async close(): Promise<void> {
    await Promise.all([this.leases.close(), this.journal.close()])
  }
}

/**
 * Open both durable authorities atomically with respect to service publication,
 * then retract the service before draining them during plugin disposal.
 * @param ctx - Host Context carrying the routed storage-domain facility.
 * @param config - bounded control-lease policy.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.effect(async () => {
    const journalDomain = await ctx.storageDomain.open(remoteCommandJournalSpec)
    let fenceDomain: Domain<typeof remoteControlFenceSpec> | undefined
    try {
      fenceDomain = await ctx.storageDomain.open(remoteControlFenceSpec)
      const authority = new RemoteControlAuthority(
        new RemoteCommandJournal(journalDomain),
        new RemoteControlLeases(fenceDomain, config.leaseTtlMs ?? 30_000),
      )
      const disposeService = ctx.provide('remoteControl', authority)
      return async () => {
        disposeService()
        await authority.close()
      }
    } catch (error) {
      await Promise.all([
        journalDomain.close(),
        ...(fenceDomain === undefined ? [] : [fenceDomain.close()]),
      ])
      throw error
    }
  }, 'host-remote-control: durable journal and lease owner')
}
