/** Host security owner loaded from the shared Rust Node-API addon. */

import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface NativeHandshake {
  readonly finished: boolean
  read(message: Buffer): Buffer
  write(payload: Buffer): Buffer
  peerPublicKey(): Buffer
  verificationCode(): string
  finishTransport(): NativeTransport
}

interface NativeTransport {
  encrypt(plaintext: Buffer): Buffer
  decrypt(ciphertext: Buffer): Buffer
}

interface NativeAuthorizationDecision {
  decision: 'allowed' | 'unknown_device' | 'revoked' | 'capability_denied'
  deviceId?: Buffer
  grantedCapabilities?: string
  authorityEpoch?: string
}

interface NativePairingInvitation {
  id: Buffer
  psk: Buffer
  hostPublicKey: Buffer
  expiresAtMs: string
  capabilities: string
}

interface NativeDeviceAuthorization {
  deviceId: Buffer
  publicKey: Buffer
  displayName: string
  capabilities: string
  createdAtMs: string
  revokedAtMs?: string
  authorityEpoch: string
}

interface NativeHostSecurityStore {
  readonly hostPublicKey: Buffer
  createInvitation(nowMs: number, lifetimeMs: number, capabilities: string): NativePairingInvitation
  pairingResponder(invitationId: Buffer, nowMs: number, canonicalPrologue: Buffer): NativeHandshake
  stagePairing(invitationId: Buffer, devicePublicKey: Buffer, nowMs: number): void
  cancelInvitation(invitationId: Buffer): void
  confirmPairing(
    invitationId: Buffer,
    displayName: string,
    grantedCapabilities: string,
    nowMs: number,
  ): NativeDeviceAuthorization
  listDevices(): NativeDeviceAuthorization[]
  connectionResponder(canonicalPrologue: Buffer): NativeHandshake
  authorizeCapabilities(devicePublicKey: Buffer, requiredCapabilities: string): NativeAuthorizationDecision
  revoke(deviceId: Buffer, nowMs: number): boolean
}

interface NativeHostSecurityStoreConstructor {
  loadOrCreate(path: string): NativeHostSecurityStore
}

interface NativeSecurityAddon {
  NodeHostSecurityStore?: NativeHostSecurityStoreConstructor
}

const REMOTE_SECURITY_ADDON_PACKAGES = new Map([
  ['win32-x64', '@w2112515/dsh-remote-security-core-win32-x64'],
])

/** One authenticated ordered transport returned only after Host authorization. */
export interface RemoteSecureTransport {
  encrypt(plaintext: Buffer): Buffer
  decrypt(ciphertext: Buffer): Buffer
}

/** Host-side in-progress IK handshake. */
export interface RemoteConnectionHandshake {
  read(message: Buffer): Buffer
  write(payload: Buffer): Buffer
  finished(): boolean
  peerPublicKey(): Buffer
  verificationCode(): string
  finishTransport(): RemoteSecureTransport
}

/** Result of authorizing the static identity authenticated by Noise IK. */
export type RemoteAuthorizationDecision =
  | { decision: 'allowed'; deviceId: Buffer; grantedCapabilities: string; authorityEpoch: string }
  | { decision: 'unknown_device' | 'revoked' | 'capability_denied' }

/** Exact capability profile required by the current read projection consumer. */
export const REMOTE_READ_CAPABILITIES = '3'
/** Exact capability required to acquire or mutate a Session control lease. */
export const REMOTE_CONTROL_CAPABILITIES = '64'
/** Exact capability set rechecked at the synchronous send-input admission point. */
export const REMOTE_SEND_CONTROL_CAPABILITIES = '68'
/** Exact capability set rechecked at the synchronous Stop admission point. */
export const REMOTE_STOP_CONTROL_CAPABILITIES = '72'
/** Exact capability rechecked for an approval decision; no Session control lease is implied. */
export const REMOTE_APPROVAL_CAPABILITIES = '16'
/** Exact capability admitting a device onto the supervisor status stream (ADR-007). */
export const SUPERVISOR_OBSERVE_CAPABILITIES = '1'
/** Exact capability rechecked at every supervisor lifecycle verb (ADR-007). */
export const SUPERVISOR_MANAGE_CAPABILITIES = '256'

/** QR/manual-transfer material for one short-lived, Host-selected ceremony. */
export interface RemotePairingInvitation {
  invitationId: Buffer
  invitationPsk: Buffer
  hostPublicKey: Buffer
  expiresAtMs: string
  capabilities: string
  endpointHost: string
  endpointPort: number
}

/** Host-local review row created only after Noise authenticated the phone. */
export interface RemotePendingPairing {
  invitationId: Buffer
  devicePublicKey: Buffer
  deviceName: string
  verificationCode: string
  expiresAtMs: string
  capabilities: string
}

/** Durable Host-local device view with no private material. */
export interface RemoteDeviceAuthorization {
  deviceId: Buffer
  publicKey: Buffer
  displayName: string
  capabilities: string
  createdAtMs: string
  revokedAtMs?: string
  authorityEpoch: string
}

/** Host-local terminal decision for one pending pairing ceremony. */
export type RemotePairingDecision = 'confirmed' | 'rejected'

interface CachedInvitation {
  invitationId: Buffer
  hostPublicKey: Buffer
  expiresAtMs: string
  capabilities: string
}

interface PendingPairingRecord {
  view: RemotePendingPairing
  resolve: (decision: RemotePairingDecision) => void
  decision: Promise<RemotePairingDecision>
}

/** Capability-minimized security owner consumed by the physical carrier. */
export interface RemoteSecurityOwner {
  hostPublicKey(): Buffer
  createInvitation(
    nowMs: number,
    lifetimeMs: number,
    capabilities: string,
    endpointHost: string,
    endpointPort: number,
  ): RemotePairingInvitation
  pairingResponder(
    invitationId: Buffer,
    presentedHostPublicKey: Buffer,
    nowMs: number,
  ): RemoteConnectionHandshake
  stagePairing(
    invitationId: Buffer,
    devicePublicKey: Buffer,
    deviceName: string,
    verificationCode: string,
    nowMs: number,
  ): Promise<RemotePairingDecision>
  pendingPairings(): RemotePendingPairing[]
  confirmPairing(invitationId: Buffer, nowMs: number): RemoteDeviceAuthorization
  rejectPairing(invitationId: Buffer): void
  listDevices(): RemoteDeviceAuthorization[]
  revoke(deviceId: Buffer, nowMs: number): boolean
  connectionResponder(canonicalPrologue: Buffer): RemoteConnectionHandshake
  authorizeCapabilities(
    devicePublicKey: Buffer,
    requiredCapabilities: string,
  ): RemoteAuthorizationDecision
}

class SecurityOwner implements RemoteSecurityOwner {
  readonly #invitations = new Map<string, CachedInvitation>()
  readonly #pending = new Map<string, PendingPairingRecord>()

  constructor(private readonly store: NativeHostSecurityStore) {}

  hostPublicKey(): Buffer {
    return Buffer.from(this.store.hostPublicKey)
  }

  createInvitation(
    nowMs: number,
    lifetimeMs: number,
    capabilities: string,
    endpointHost: string,
    endpointPort: number,
  ): RemotePairingInvitation {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('invalid invitation timestamp')
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new Error('invalid invitation lifetime')
    if (endpointHost.length === 0 || endpointHost.length > 253) throw new Error('invalid invitation endpoint')
    if (!Number.isInteger(endpointPort) || endpointPort < 1 || endpointPort > 65_535) {
      throw new Error('invalid invitation endpoint port')
    }
    if (!/^(0|[1-9]\d{0,19})$/.test(capabilities)
      || BigInt(capabilities) > 18_446_744_073_709_551_615n) {
      throw new Error('invalid invitation capabilities')
    }
    const native = this.store.createInvitation(nowMs, lifetimeMs, capabilities)
    if (native.capabilities !== capabilities) throw new Error('security addon changed invitation capabilities')
    const invitation: RemotePairingInvitation = {
      invitationId: Buffer.from(native.id),
      invitationPsk: Buffer.from(native.psk),
      hostPublicKey: Buffer.from(native.hostPublicKey),
      expiresAtMs: native.expiresAtMs,
      capabilities: native.capabilities,
      endpointHost,
      endpointPort,
    }
    native.psk.fill(0)
    this.#invitations.set(invitationKey(invitation.invitationId), {
      invitationId: Buffer.from(invitation.invitationId),
      hostPublicKey: Buffer.from(invitation.hostPublicKey),
      expiresAtMs: invitation.expiresAtMs,
      capabilities: invitation.capabilities,
    })
    return invitation
  }

  pairingResponder(
    invitationId: Buffer,
    presentedHostPublicKey: Buffer,
    nowMs: number,
  ): RemoteConnectionHandshake {
    const invitation = this.#invitations.get(invitationKey(invitationId))
    if (invitation === undefined) throw new Error('pairing invitation is unavailable')
    if (presentedHostPublicKey.length !== invitation.hostPublicKey.length
      || !timingSafeEqual(presentedHostPublicKey, invitation.hostPublicKey)) {
      throw new Error('pairing Host identity does not match')
    }
    if (BigInt(nowMs) >= BigInt(invitation.expiresAtMs)) throw new Error('pairing invitation expired')
    return wrapHandshake(this.store.pairingResponder(
      Buffer.from(invitation.invitationId),
      nowMs,
      pairingPrologue(invitation),
    ))
  }

  stagePairing(
    invitationId: Buffer,
    devicePublicKey: Buffer,
    deviceName: string,
    verificationCode: string,
    nowMs: number,
  ): Promise<RemotePairingDecision> {
    const key = invitationKey(invitationId)
    const invitation = this.#invitations.get(key)
    if (invitation === undefined) throw new Error('pairing invitation is unavailable')
    const boundedName = deviceName.trim()
    if (boundedName.length === 0 || Array.from(boundedName).length > 80) throw new Error('invalid device name')
    if (!/^\d{8}$/.test(verificationCode)) throw new Error('invalid pairing verification code')
    if (this.#pending.has(key)) throw new Error('pairing already awaits confirmation')
    this.store.stagePairing(Buffer.from(invitationId), Buffer.from(devicePublicKey), nowMs)
    let resolveDecision!: (decision: RemotePairingDecision) => void
    const decision = new Promise<RemotePairingDecision>((resolve) => { resolveDecision = resolve })
    this.#pending.set(key, {
      view: {
        invitationId: Buffer.from(invitationId),
        devicePublicKey: Buffer.from(devicePublicKey),
        deviceName: boundedName,
        verificationCode,
        expiresAtMs: invitation.expiresAtMs,
        capabilities: invitation.capabilities,
      },
      resolve: resolveDecision,
      decision,
    })
    return decision
  }

  pendingPairings(): RemotePendingPairing[] {
    return [...this.#pending.values()].map(({ view }) => clonePending(view))
  }

  confirmPairing(invitationId: Buffer, nowMs: number): RemoteDeviceAuthorization {
    const key = invitationKey(invitationId)
    const pending = this.#pending.get(key)
    if (pending === undefined) throw new Error('pairing is not awaiting confirmation')
    const authorization = cloneAuthorization(this.store.confirmPairing(
      Buffer.from(invitationId),
      pending.view.deviceName,
      pending.view.capabilities,
      nowMs,
    ))
    if (authorization.capabilities !== pending.view.capabilities) {
      throw new Error('security addon changed confirmed capabilities')
    }
    this.#pending.delete(key)
    this.#invitations.delete(key)
    pending.resolve('confirmed')
    return authorization
  }

  rejectPairing(invitationId: Buffer): void {
    const key = invitationKey(invitationId)
    const pending = this.#pending.get(key)
    this.store.cancelInvitation(Buffer.from(invitationId))
    this.#pending.delete(key)
    this.#invitations.delete(key)
    pending?.resolve('rejected')
  }

  listDevices(): RemoteDeviceAuthorization[] {
    return this.store.listDevices().map(cloneAuthorization)
  }

  revoke(deviceId: Buffer, nowMs: number): boolean {
    return this.store.revoke(Buffer.from(deviceId), nowMs)
  }

  connectionResponder(canonicalPrologue: Buffer): RemoteConnectionHandshake {
    return wrapHandshake(this.store.connectionResponder(canonicalPrologue))
  }

  authorizeCapabilities(
    devicePublicKey: Buffer,
    requiredCapabilities: string,
  ): RemoteAuthorizationDecision {
    const result = this.store.authorizeCapabilities(devicePublicKey, requiredCapabilities)
    if (result.decision !== 'allowed') return { decision: result.decision }
    if (result.deviceId === undefined || result.deviceId.length !== 16) {
      throw new Error('security addon omitted the canonical allowed device id')
    }
    if (result.authorityEpoch === undefined) {
      throw new Error('security addon omitted the allowed authority epoch')
    }
    if (result.grantedCapabilities === undefined || !/^(0|[1-9]\d*)$/.test(result.grantedCapabilities)
      || BigInt(result.grantedCapabilities) > 18_446_744_073_709_551_615n) {
      throw new Error('security addon omitted the allowed capability grant')
    }
    return {
      decision: 'allowed',
      deviceId: Buffer.from(result.deviceId),
      grantedCapabilities: result.grantedCapabilities,
      authorityEpoch: result.authorityEpoch,
    }
  }
}

function wrapHandshake(handshake: NativeHandshake): RemoteConnectionHandshake {
  return {
    read: message => Buffer.from(handshake.read(message)),
    write: payload => Buffer.from(handshake.write(payload)),
    finished: () => handshake.finished,
    peerPublicKey: () => Buffer.from(handshake.peerPublicKey()),
    verificationCode: () => handshake.verificationCode(),
    finishTransport: () => {
      const transport = handshake.finishTransport()
      return {
        encrypt: plaintext => Buffer.from(transport.encrypt(plaintext)),
        decrypt: ciphertext => Buffer.from(transport.decrypt(ciphertext)),
      }
    },
  }
}

function invitationKey(invitationId: Buffer): string {
  if (invitationId.length !== 16) throw new Error('invitation id must be 16 bytes')
  return invitationId.toString('hex')
}

function clonePending(value: RemotePendingPairing): RemotePendingPairing {
  return {
    ...value,
    invitationId: Buffer.from(value.invitationId),
    devicePublicKey: Buffer.from(value.devicePublicKey),
  }
}

function cloneAuthorization(value: NativeDeviceAuthorization): RemoteDeviceAuthorization {
  return {
    ...value,
    deviceId: Buffer.from(value.deviceId),
    publicKey: Buffer.from(value.publicKey),
  }
}

/**
 * Load the shared native security owner and fail before the listener binds when
 * the addon or protected Host store cannot be opened.
 * @param addonPath - Optional absolute or process-relative Node-API addon override.
 * @param storePath - Absolute or process-relative protected Host-state path.
 * @param loadAddon - Test hook receiving the resolved path or fixed platform package.
 * @returns A capability-minimized security owner with no private-key accessor.
 */
export function loadRemoteSecurityOwner(
  addonPath: string | undefined,
  storePath: string,
  loadAddon: (specifier: string) => unknown = defaultAddonLoader(addonPath),
): RemoteSecurityOwner {
  const specifier = addonPath === undefined
    ? resolveBundledSecurityAddon()
    : resolve(addonPath)
  const loaded = loadAddon(specifier)
  const addon = nativeSecurityAddon(loaded)
  if (typeof addon.NodeHostSecurityStore?.loadOrCreate !== 'function') {
    throw new Error('security addon does not expose NodeHostSecurityStore')
  }
  const store = addon.NodeHostSecurityStore.loadOrCreate(resolve(storePath))
  if (typeof store.authorizeCapabilities !== 'function') {
    throw new Error('security addon does not expose exact capability authorization')
  }
  if (typeof store.createInvitation !== 'function' || typeof store.confirmPairing !== 'function') {
    throw new Error('security addon does not expose exact capability pairing')
  }
  return new SecurityOwner(store)
}

function defaultAddonLoader(addonPath: string | undefined): (specifier: string) => unknown {
  const packageRequire = createRequire(import.meta.url)
  if (addonPath !== undefined) return specifier => packageRequire(specifier) as unknown
  const deploymentRequire = createRequire(resolve('package.json'))
  return (specifier) => {
    let modulePath: string
    try {
      modulePath = packageRequire.resolve(specifier)
    } catch (error) {
      if (!isMissingPackage(error, specifier)) throw error
      modulePath = deploymentRequire.resolve(specifier)
    }
    return packageRequire(modulePath) as unknown
  }
}

function isMissingPackage(error: unknown, specifier: string): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'MODULE_NOT_FOUND'
    && error.message.includes(specifier)
}

function remoteSecurityAddonPackage(platform: string, arch: string): string {
  const host = `${platform}-${arch}`
  const packageName = REMOTE_SECURITY_ADDON_PACKAGES.get(host)
  if (packageName === undefined) {
    throw new Error(`DSH Remote has no reviewed security addon for ${host}`)
  }
  return packageName
}

/** Why a Host composition can load without binding the authenticated carrier. */
export type RemoteSecurityUnavailableReason = 'unsupported-platform' | 'missing-addon'

/** Result of probing the reviewed native owner without failing the whole Host. */
export type RemoteSecurityLoadResult =
  | { readonly status: 'ready'; readonly owner: RemoteSecurityOwner }
  | { readonly status: 'unavailable'; readonly reason: RemoteSecurityUnavailableReason; readonly detail: string }

/**
 * Load the native security owner, or report a recoverable absence.
 * A missing reviewed package or unsupported Host platform leaves Web Settings
 * available; a loaded but invalid addon still fails closed.
 */
export function loadRemoteSecurityOwnerOrUnavailable(
  addonPath: string | undefined,
  storePath: string,
  loadAddon: (specifier: string) => unknown = defaultAddonLoader(addonPath),
): RemoteSecurityLoadResult {
  try {
    return { status: 'ready', owner: loadRemoteSecurityOwner(addonPath, storePath, loadAddon) }
  } catch (error) {
    const reason = classifyRemoteSecurityLoadFailure(error, addonPath)
    if (reason === undefined) throw error
    return {
      status: 'unavailable',
      reason,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Distinguish a recoverable security-owner absence from a fail-closed defect.
 * @param error - rejection from {@link loadRemoteSecurityOwner}.
 * @param addonPath - the same override passed to the loader.
 */
export function classifyRemoteSecurityLoadFailure(
  error: unknown,
  addonPath: string | undefined,
): RemoteSecurityUnavailableReason | undefined {
  const detail = error instanceof Error ? error.message : String(error)
  if (detail.startsWith('DSH Remote has no reviewed security addon for ')) return 'unsupported-platform'
  if (error instanceof Error && isMissingPackage(error, remoteSecurityAddonSpecifier(addonPath))) {
    return 'missing-addon'
  }
  return undefined
}

function remoteSecurityAddonSpecifier(addonPath: string | undefined): string {
  return addonPath === undefined ? resolveBundledSecurityAddon() : resolve(addonPath)
}

/** Prefer the Windows x64 files shipped in this package; otherwise the platform package name. */
function resolveBundledSecurityAddon(): string {
  const host = `${process.platform}-${process.arch}`
  if (host === 'win32-x64') {
    for (const spec of [
      new URL('../native/win32-x64/index.mjs', import.meta.url),
      new URL('../../native/win32-x64/index.mjs', import.meta.url),
    ]) {
      const pathname = fileURLToPath(spec)
      if (existsSync(pathname)) return pathname
    }
  }
  return remoteSecurityAddonPackage(process.platform, process.arch)
}

function nativeSecurityAddon(value: unknown): NativeSecurityAddon {
  if (typeof value !== 'object' || value === null) return {}
  const module = value as NativeSecurityAddon & { default?: unknown }
  if (typeof module.default !== 'object' || module.default === null) return module
  return module.default
}

const PROLOGUE_LABEL = Buffer.from('dsh-remote/connect/v1', 'utf8')
const PAIRING_PROLOGUE_LABEL = Buffer.from('dsh-remote/pair/v1', 'utf8')

function boundedField(value: Buffer): Buffer {
  if (value.length > 65_535) throw new Error('secure prologue field exceeds 65535 bytes')
  const length = Buffer.allocUnsafe(2)
  length.writeUInt16BE(value.length)
  return Buffer.concat([length, value])
}

/**
 * Encode the unambiguous Noise IK prologue shared by the Android and Host cores.
 * @param hostPublicKey - Exact Host key pinned during pairing.
 * @param connectionId - Fresh client-selected connection identity.
 * @returns Canonical bytes binding protocol, Host, connection, and read-only capabilities.
 */
export function connectionPrologue(hostPublicKey: Buffer, connectionId: string): Buffer {
  if (hostPublicKey.length !== 32) throw new Error('Host public key must be 32 bytes')
  const connection = Buffer.from(connectionId, 'utf8')
  if (connection.length === 0 || connection.length > 128) throw new Error('invalid secure connection id')
  const capabilities = Buffer.allocUnsafe(8)
  capabilities.writeBigUInt64BE(3n)
  return Buffer.concat([
    boundedField(PROLOGUE_LABEL),
    boundedField(hostPublicKey),
    boundedField(connection),
    boundedField(capabilities),
  ])
}

/**
 * Canonical XXpsk3 transcript binding shared with Android.
 * @param invitation - exact cached invitation fields bound into the transcript.
 * @returns canonical length-prefixed pairing prologue.
 */
export function pairingPrologue(invitation: CachedInvitation): Buffer {
  if (invitation.hostPublicKey.length !== 32) throw new Error('Host public key must be 32 bytes')
  if (invitation.invitationId.length !== 16) throw new Error('invitation id must be 16 bytes')
  const expiresAt = Buffer.allocUnsafe(8)
  expiresAt.writeBigUInt64BE(BigInt(invitation.expiresAtMs))
  const capabilities = Buffer.allocUnsafe(8)
  capabilities.writeBigUInt64BE(BigInt(invitation.capabilities))
  return Buffer.concat([
    boundedField(PAIRING_PROLOGUE_LABEL),
    boundedField(invitation.hostPublicKey),
    boundedField(invitation.invitationId),
    boundedField(expiresAt),
    boundedField(capabilities),
  ])
}
