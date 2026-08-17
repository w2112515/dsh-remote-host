/** Host-local pairing administration over the shared durable security owner. */

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import protoLoader from '@grpc/proto-loader'
import type {
  RemoteDeviceAuthorization,
  RemotePairingInvitation,
  RemotePendingPairing,
  RemoteSecurityOwner,
} from './security.ts'

/** Closed Host-local profiles; mobile payloads never choose a raw capability mask. */
export type RemotePairingProfile =
  | 'read-only'
  | 'session-control'
  | 'session-operator'
  | 'approval-reviewer'
  | 'session-supervisor'
  | 'host-supervisor'

const PROFILE_CAPABILITIES: Readonly<Record<RemotePairingProfile, string>> = {
  'read-only': '3',
  'session-control': '71',
  'session-operator': '79',
  'approval-reviewer': '19',
  'session-supervisor': '95',
  'host-supervisor': '351',
}

interface MessageCodec {
  serialize(value: Record<string, unknown>): Buffer
}

/** Safe view rendered by a Host-local UI. */
export interface PairingInvitationView {
  invitationId: string
  invitationUri: string
  hostFingerprint: string
  expiresAtMs: string
  capabilities: string
  profile: RemotePairingProfile
}

/** Authenticated phone awaiting a visible Host decision. */
export interface PendingPairingView {
  invitationId: string
  deviceName: string
  deviceFingerprint: string
  verificationCode: string
  expiresAtMs: string
  capabilities: string
  profile: RemotePairingProfile
}

/** Durable authorization row for local device management. */
export interface PairedDeviceView {
  deviceId: string
  displayName: string
  deviceFingerprint: string
  capabilities: string
  createdAtMs: string
  revokedAtMs?: string
  authorityEpoch: string
  profile: RemotePairingProfile
}

/** Host-local LAN advertisement status shown on the administration page. */
export interface RemoteLanDiscoveryView {
  /** Operator intent from composition plus the `host-remote` settings section. */
  intended: boolean
  /** Whether this process currently advertises `_dsh-remote._tcp` on a private IPv4. */
  published: boolean
  displayName?: string
  address?: string
  port?: number
}

/** Empty discovery view used until the carrier publishes, or when LAN stays off. */
export const REMOTE_LAN_DISCOVERY_OFF: RemoteLanDiscoveryView = {
  intended: false,
  published: false,
}

/**
 * Local administration owner. This object is provided only inside the Host
 * Cordis context; the mobile carrier never serializes its methods or views.
 */
export class RemotePairingAdministrator {
  #endpointHost: string
  #port: number
  #discovery: RemoteLanDiscoveryView = REMOTE_LAN_DISCOVERY_OFF

  constructor(
    private readonly security: RemoteSecurityOwner,
    endpointHost: string,
    endpointPort: number,
    private readonly onAuthorizationChanged: (deviceId: string) => void = () => {},
    private readonly onLanDiscoveryChange?: (enabled: boolean) => Promise<RemoteLanDiscoveryView>,
  ) {
    this.#endpointHost = endpointHost
    this.#port = endpointPort
  }

  /**
   * Update an OS-assigned test port after the carrier binds.
   * @param port - bound IPv4 loopback port.
   */
  setEndpointPort(port: number): void {
    this.setEndpoint(this.#endpointHost, port)
  }

  /**
   * Point later invitations at the address the carrier currently binds.
   * @param host - IPv4 bind address.
   * @param port - bound TCP port.
   */
  setEndpoint(host: string, port: number): void {
    if (host.trim() === '') throw new Error('invalid pairing endpoint host')
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid pairing endpoint port')
    this.#endpointHost = host
    this.#port = port
  }

  /** Current LAN advertisement facts for the Host-local settings page. */
  discovery(): RemoteLanDiscoveryView {
    return this.#discovery
  }

  /**
   * Record the live advertisement after a successful bind or withdraw.
   * @param value - actual published state, not merely operator intent.
   */
  setDiscovery(value: RemoteLanDiscoveryView): void {
    this.#discovery = value
  }

  /**
   * Persist operator intent and rebind when this Host wired a settings owner.
   * @param enabled - whether nearby phones should discover this Host.
   */
  async setLanDiscovery(enabled: boolean): Promise<RemoteLanDiscoveryView> {
    if (this.onLanDiscoveryChange === undefined) {
      throw new Error('LAN discovery cannot be changed in this deployment')
    }
    this.#discovery = await this.onLanDiscoveryChange(enabled)
    return this.#discovery
  }

  /**
   * Mint one five-minute invitation for an exact closed Host-selected profile.
   * @param profile - explicit local access profile; read-only remains the default.
   * @param lifetimeMs - invitation lifetime in milliseconds.
   * @param nowMs - Host wall-clock timestamp.
   * @returns safe Host-local invitation view.
   */
  createInvitation(
    profile: RemotePairingProfile = 'read-only',
    lifetimeMs: number = 5 * 60_000,
    nowMs: number = Date.now(),
  ): PairingInvitationView {
    if (!Object.hasOwn(PROFILE_CAPABILITIES, profile)) throw new Error('unsupported Remote pairing profile')
    const invitation = this.security.createInvitation(
      nowMs,
      lifetimeMs,
      PROFILE_CAPABILITIES[profile],
      this.#endpointHost,
      this.#port,
    )
    try {
      return invitationView(invitation)
    } finally {
      invitation.invitationPsk.fill(0)
    }
  }

  /**
   * List only Noise-authenticated ceremonies that require local review.
   * @returns current immutable review rows.
   */
  pendingPairings(): PendingPairingView[] {
    return this.security.pendingPairings().map(pendingView)
  }

  /**
   * Commit the exact pending identity with the invitation-bound profile.
   * @param invitationId - reviewed invitation identifier.
   * @param nowMs - Host wall-clock timestamp.
   * @returns durable authorization view.
   */
  confirm(invitationId: string, nowMs: number = Date.now()): PairedDeviceView {
    return deviceView(this.security.confirmPairing(parseIdentifier(invitationId), nowMs))
  }

  /**
   * Reject and retire a pending invitation without creating authorization.
   * @param invitationId - reviewed invitation identifier.
   */
  reject(invitationId: string): void {
    this.security.rejectPairing(parseIdentifier(invitationId))
  }

  /**
   * List active and revoked device records for Host-local administration.
   * @returns current durable device views.
   */
  devices(): PairedDeviceView[] {
    return this.security.listDevices().map(deviceView)
  }

  /**
   * Revoke one durable device identity, advance its fencing epoch, and terminate stale live authority.
   * @param deviceId - durable Host device identifier.
   * @param nowMs - Host wall-clock timestamp.
   * @returns whether an active authorization changed.
   */
  revoke(deviceId: string, nowMs: number = Date.now()): boolean {
    const changed = this.security.revoke(parseIdentifier(deviceId), nowMs)
    if (changed) this.onAuthorizationChanged(deviceId.toLowerCase())
    return changed
  }
}

let cachedInvitationCodec: MessageCodec | undefined

function invitationCodec(): MessageCodec {
  if (cachedInvitationCodec !== undefined) return cachedInvitationCodec
  const path = fileURLToPath(new URL('../protocol/v1alpha/dsh_remote_v1alpha.proto', import.meta.url))
  const definition = protoLoader.loadSync(path, {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  })
  const codec = definition['dsh.remote.v1alpha.PairingInvitation'] as MessageCodec | undefined
  if (codec === undefined || typeof codec.serialize !== 'function') {
    throw new Error('pairing invitation protobuf codec is unavailable')
  }
  cachedInvitationCodec = codec
  return codec
}

function invitationView(invitation: RemotePairingInvitation): PairingInvitationView {
  const bytes = invitationCodec().serialize({
    protocol_version: 1,
    invitation_id: invitation.invitationId,
    invitation_psk: invitation.invitationPsk,
    host_public_key: invitation.hostPublicKey,
    expires_at_ms: invitation.expiresAtMs,
    capabilities: invitation.capabilities,
    endpoint_host: invitation.endpointHost,
    endpoint_port: invitation.endpointPort,
  })
  return {
    invitationId: invitation.invitationId.toString('hex'),
    invitationUri: `dsh-remote://pair/v1#${bytes.toString('base64url')}`,
    hostFingerprint: fingerprint(invitation.hostPublicKey),
    expiresAtMs: invitation.expiresAtMs,
    capabilities: invitation.capabilities,
    profile: profileForCapabilities(invitation.capabilities),
  }
}

function pendingView(value: RemotePendingPairing): PendingPairingView {
  return {
    invitationId: value.invitationId.toString('hex'),
    deviceName: value.deviceName,
    deviceFingerprint: fingerprint(value.devicePublicKey),
    verificationCode: value.verificationCode,
    expiresAtMs: value.expiresAtMs,
    capabilities: value.capabilities,
    profile: profileForCapabilities(value.capabilities),
  }
}

function deviceView(value: RemoteDeviceAuthorization): PairedDeviceView {
  return {
    deviceId: value.deviceId.toString('hex'),
    displayName: value.displayName,
    deviceFingerprint: fingerprint(value.publicKey),
    capabilities: value.capabilities,
    createdAtMs: value.createdAtMs,
    ...(value.revokedAtMs === undefined ? {} : { revokedAtMs: value.revokedAtMs }),
    authorityEpoch: value.authorityEpoch,
    profile: profileForCapabilities(value.capabilities),
  }
}

function fingerprint(publicKey: Buffer): string {
  const hex = createHash('sha256')
    .update(publicKey)
    .digest('hex')
    .toUpperCase()
  return Array.from({ length: hex.length / 4 }, (_, index) => hex.slice(index * 4, index * 4 + 4)).join(' ')
}

function parseIdentifier(value: string): Buffer {
  if (!/^[0-9a-f]{32}$/i.test(value)) throw new Error('identifier must be 16-byte hexadecimal')
  return Buffer.from(value, 'hex')
}

function profileForCapabilities(capabilities: string): RemotePairingProfile {
  for (const profile of [
    'read-only', 'approval-reviewer', 'session-control', 'session-operator', 'session-supervisor', 'host-supervisor',
  ] as const) {
    if (PROFILE_CAPABILITIES[profile] === capabilities) return profile
  }
  throw new Error('device authorization uses an unsupported Remote profile')
}
