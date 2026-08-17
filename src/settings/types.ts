/** JSON-safe contracts shared by the Host-local gateway and browser surface. */

/** Closed Host-selected profile; raw capability masks never cross from the browser. */
export type RemotePairingProfile =
  | 'read-only'
  | 'approval-reviewer'
  | 'session-control'
  | 'session-operator'
  | 'session-supervisor'
  | 'host-supervisor'

/** Single-use Host invitation shown only on the local administration surface. */
export interface RemoteInvitationView {
  invitationId: string
  invitationUri: string
  hostFingerprint: string
  expiresAtMs: string
  capabilities: string
  profile: RemotePairingProfile
}

/** Authenticated phone awaiting a visible Host-local decision. */
export interface RemotePendingPairingView {
  invitationId: string
  deviceName: string
  deviceFingerprint: string
  verificationCode: string
  expiresAtMs: string
  capabilities: string
  profile: RemotePairingProfile
}

/** Active or revoked durable device authorization. */
export interface RemotePairedDeviceView {
  deviceId: string
  displayName: string
  deviceFingerprint: string
  capabilities: string
  createdAtMs: string
  revokedAtMs?: string
  authorityEpoch: string
  profile: RemotePairingProfile
}

/** Complete refreshable state of the Host-local Remote settings section. */
export interface RemoteAdminSnapshot {
  available: boolean
  pendingPairings: RemotePendingPairingView[]
  devices: RemotePairedDeviceView[]
  discovery: RemoteLanDiscoveryView
}

/** Host-local LAN advertisement status shown on the administration page. */
export interface RemoteLanDiscoveryView {
  intended: boolean
  published: boolean
  displayName?: string
  address?: string
  port?: number
}

/** Newly minted invitation plus the post-mutation administration snapshot. */
export interface RemoteInvitationResult {
  invitation: RemoteInvitationView
  snapshot: RemoteAdminSnapshot
}
