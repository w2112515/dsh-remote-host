/** Durable epoch plus process-local Session control lease implementation. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  remoteControlEpochSchema,
  remoteControlFenceSpec,
  remoteDeviceIdSchema,
} from './spec.ts'
import type { RemoteControlFenceRow } from './spec.ts'
import type {
  RemoteControlAdmissionResult,
  RemoteControlEpoch,
  RemoteControlFailure,
  RemoteControlLease,
  RemoteControlLeaseResult,
  RemoteControlProof,
  RemoteControlToken,
  RemoteDeviceId,
} from './types.ts'

const UINT64_MAX = 18_446_744_073_709_551_615n
const sessionIdPattern = /^.{1,256}$/u
const tokenPattern = /^[A-Za-z0-9_-]{43}$/

function incrementEpoch(epoch: RemoteControlEpoch | undefined): RemoteControlEpoch {
  const value = epoch === undefined ? 0n : BigInt(epoch)
  if (value >= UINT64_MAX) throw new Error('remote control epoch overflow')
  return String(value + 1n) as RemoteControlEpoch
}

function tokenMatches(expected: RemoteControlToken, actual: RemoteControlToken): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function snapshotLease(lease: RemoteControlLease): RemoteControlLease {
  return Object.freeze({
    sessionId: lease.sessionId,
    holderDeviceId: lease.holderDeviceId,
    epoch: lease.epoch,
    token: lease.token,
    expiresAtMs: lease.expiresAtMs,
  })
}

/** Package-private lease owner used by the Remote control service. */
export class RemoteControlLeases {
  private readonly table: KvTable<SessionId, RemoteControlFenceRow>
  private readonly live = new Map<SessionId, RemoteControlLease>()
  private readonly operationTails = new Map<SessionId, Promise<void>>()
  private admissionOpen = true

  /**
   * @param domain - already-open durable epoch domain.
   * @param defaultTtlMs - lease lifetime applied to acquire/renew/transfer.
   * @param now - Host wall clock sampled at every operation.
   * @param nextToken - cryptographically random token factory.
   */
  constructor(
    private readonly domain: Domain<typeof remoteControlFenceSpec>,
    private readonly defaultTtlMs: number,
    private readonly now: () => number = Date.now,
    private readonly nextToken: () => RemoteControlToken = () =>
      randomBytes(32).toString('base64url') as RemoteControlToken,
  ) {
    this.table = domain.table('sessions')
    for (const [key, row] of this.table.entries()) {
      if (key !== row.sessionId) {
        throw new Error(`remote control fence key '${key}' does not match stored sessionId '${row.sessionId}'`)
      }
    }
  }

  /**
   * Acquire an unheld or expired Session; same-holder extension uses renew.
   * @param sessionId - ordinary Session identity.
   * @param deviceId - authenticated stable device identity.
   * @returns new lease or held conflict.
   */
  acquire(sessionId: SessionId, deviceId: RemoteDeviceId): Promise<RemoteControlLeaseResult> {
    this.validateIdentity(sessionId, deviceId)
    return this.enqueue(sessionId, async () => {
      const current = this.live.get(sessionId)
      const now = this.checkedNow()
      if (current !== undefined && now < current.expiresAtMs) {
        if (current.holderDeviceId === deviceId) {
          return Object.freeze({ ok: true, lease: snapshotLease(current) })
        }
        return Object.freeze({ ok: false, reason: 'held-by-other' })
      }
      const epoch = await this.advanceEpoch(sessionId)
      const lease = this.createLease(sessionId, deviceId, epoch, now)
      this.live.set(sessionId, lease)
      return Object.freeze({ ok: true, lease: snapshotLease(lease) })
    })
  }

  /**
   * Extend one exact, unexpired holder without changing epoch or token.
   * @param rawLease - exact current holder fence.
   * @returns renewed lease or a stable fence failure.
   */
  renew(rawLease: RemoteControlProof): Promise<RemoteControlLeaseResult> {
    const lease = this.validateProof(rawLease)
    return this.enqueue(lease.sessionId, async () => {
      const current = this.live.get(lease.sessionId)
      const failure = this.fenceFailure(current, lease)
      if (failure !== undefined) {
        if (failure === 'expired' && current !== undefined) await this.expire(current)
        return Object.freeze({ ok: false, reason: failure })
      }
      if (current === undefined) throw new Error('remote control lease disappeared after a successful fence')
      const renewed = Object.freeze({
        ...current,
        expiresAtMs: this.checkedNow() + this.defaultTtlMs,
      })
      this.live.set(lease.sessionId, renewed)
      return Object.freeze({ ok: true, lease: snapshotLease(renewed) })
    })
  }

  /**
   * Atomically bump the fence and hand control to another authenticated device.
   * @param rawLease - exact current holder fence.
   * @param nextDeviceId - authenticated next holder.
   * @returns next lease or a stable fence failure.
   */
  transfer(rawLease: RemoteControlProof, nextDeviceId: RemoteDeviceId): Promise<RemoteControlLeaseResult> {
    const lease = this.validateProof(rawLease)
    remoteDeviceIdSchema.parse(nextDeviceId)
    return this.enqueue(lease.sessionId, async () => {
      const current = this.live.get(lease.sessionId)
      const failure = this.fenceFailure(current, lease)
      if (failure !== undefined) {
        if (failure === 'expired' && current !== undefined) await this.expire(current)
        return Object.freeze({ ok: false, reason: failure })
      }
      const epoch = await this.advanceEpoch(lease.sessionId)
      const transferred = this.createLease(lease.sessionId, nextDeviceId, epoch, this.checkedNow())
      this.live.set(lease.sessionId, transferred)
      return Object.freeze({ ok: true, lease: snapshotLease(transferred) })
    })
  }

  /**
   * Release an exact current lease and persist a strictly larger tombstone epoch.
   * @param rawLease - exact current holder fence.
   * @returns released postcondition or a stable fence failure.
   */
  release(rawLease: RemoteControlProof): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: RemoteControlFailure }
  > {
    const lease = this.validateProof(rawLease)
    return this.enqueue(lease.sessionId, async () => {
      const current = this.live.get(lease.sessionId)
      const failure = this.fenceFailure(current, lease)
      if (failure !== undefined) {
        if (failure === 'expired' && current !== undefined) await this.expire(current)
        return Object.freeze({ ok: false, reason: failure })
      }
      await this.advanceEpoch(lease.sessionId)
      this.live.delete(lease.sessionId)
      return Object.freeze({ ok: true })
    })
  }

  /**
   * Bump and clear every live lease owned by a revoked or reprofiled device.
   * @param deviceId - stable authorization subject to invalidate.
   */
  async invalidateDevice(deviceId: RemoteDeviceId): Promise<void> {
    remoteDeviceIdSchema.parse(deviceId)
    const sessions = [...this.live.values()]
      .filter(lease => lease.holderDeviceId === deviceId)
      .map(lease => lease.sessionId)
    await Promise.all(sessions.map(sessionId => this.enqueue(sessionId, async () => {
      const current = this.live.get(sessionId)
      if (current?.holderDeviceId !== deviceId) return
      await this.advanceEpoch(sessionId)
      this.live.delete(sessionId)
    })))
  }

  /**
   * Recheck authorization and the exact lease immediately before a synchronous
   * effect admission, without an await boundary between the two callbacks.
   * @param rawLease - exact current holder fence.
   * @param authorize - synchronous exact capability and authority-epoch check.
   * @param effect - synchronous DSH owner admission.
   * @returns effect value or a stable lease failure.
   */
  admit<T>(
    rawLease: RemoteControlProof,
    authorize: () => void,
    effect: () => T,
  ): Promise<RemoteControlAdmissionResult<T>> {
    const lease = this.validateProof(rawLease)
    return this.enqueue(lease.sessionId, async () => {
      const current = this.live.get(lease.sessionId)
      const failure = this.fenceFailure(current, lease)
      if (failure !== undefined) {
        if (failure === 'expired' && current !== undefined) await this.expire(current)
        return Object.freeze({ ok: false, reason: failure })
      }
      authorize()
      const value = effect()
      if (value !== null && (typeof value === 'object' || typeof value === 'function')
        && typeof (value as { then?: unknown }).then === 'function') {
        throw new TypeError('remote control effect admission must be synchronous')
      }
      return Object.freeze({ ok: true, value })
    })
  }

  /** Stop admission, drain Session queues, clear all secrets, and close the domain. */
  async close(): Promise<void> {
    this.admissionOpen = false
    await Promise.all(this.operationTails.values())
    this.live.clear()
    await this.domain.close()
  }

  private fenceFailure(
    current: RemoteControlLease | undefined,
    presented: RemoteControlProof,
  ): RemoteControlFailure | undefined {
    if (current === undefined) return 'unheld'
    if (this.checkedNow() >= current.expiresAtMs) return 'expired'
    if (current.sessionId !== presented.sessionId
      || current.holderDeviceId !== presented.holderDeviceId
      || current.epoch !== presented.epoch
      || !tokenMatches(current.token, presented.token)) return 'stale-fence'
    return undefined
  }

  private async expire(current: RemoteControlLease): Promise<void> {
    await this.advanceEpoch(current.sessionId)
    if (this.live.get(current.sessionId) === current) this.live.delete(current.sessionId)
  }

  private async advanceEpoch(sessionId: SessionId): Promise<RemoteControlEpoch> {
    const current = this.table.get(sessionId)
    const epoch = incrementEpoch(current?.lastEpoch)
    const next = Object.freeze({ sessionId, lastEpoch: epoch })
    if (current === undefined) await this.table.put(sessionId, next)
    else await this.table.update(sessionId, (observed) => {
      if (observed.lastEpoch !== current.lastEpoch || observed.sessionId !== sessionId) {
        throw new Error(`remote control fence '${sessionId}' changed before epoch allocation`)
      }
      return next
    })
    return epoch
  }

  private createLease(
    sessionId: SessionId,
    holderDeviceId: RemoteDeviceId,
    epoch: RemoteControlEpoch,
    now: number,
  ): RemoteControlLease {
    const token = this.nextToken()
    if (!tokenPattern.test(token)) throw new Error('remote control token factory returned a non-canonical token')
    return Object.freeze({
      sessionId,
      holderDeviceId,
      epoch,
      token,
      expiresAtMs: now + this.defaultTtlMs,
    })
  }

  private validateIdentity(sessionId: SessionId, deviceId: RemoteDeviceId): void {
    if (!sessionIdPattern.test(sessionId)) throw new TypeError('remote control sessionId is invalid')
    remoteDeviceIdSchema.parse(deviceId)
  }

  private validateProof(lease: RemoteControlProof): RemoteControlProof {
    this.validateIdentity(lease.sessionId, lease.holderDeviceId)
    remoteControlEpochSchema.parse(lease.epoch)
    if (!tokenPattern.test(lease.token)) throw new TypeError('remote control token is invalid')
    return Object.freeze({ ...lease })
  }

  private checkedNow(): number {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error(`remote control clock is invalid: ${String(now)}`)
    return now
  }

  private enqueue<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    if (!this.admissionOpen) return Promise.reject(new Error('remote control service is disposing'))
    const previous = this.operationTails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.operationTails.set(sessionId, tail)
    return result.finally(() => {
      if (this.operationTails.get(sessionId) === tail) this.operationTails.delete(sessionId)
    })
  }
}
