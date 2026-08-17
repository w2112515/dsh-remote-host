/** Strict browser wrapper for the Host-local Remote administration channel. */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {
  RemoteAdminSnapshot,
  RemoteInvitationResult,
  RemoteInvitationView,
  RemoteLanDiscoveryView,
  RemotePairedDeviceView,
  RemotePendingPairingView,
  RemotePairingProfile,
} from '../types.js'

/** Strict browser-side administration client. */
export interface RemoteAdminClient {
  snapshot(): Promise<RemoteAdminSnapshot>
  createInvitation(profile: RemotePairingProfile): Promise<RemoteInvitationResult>
  confirm(invitationId: string): Promise<RemoteAdminSnapshot>
  reject(invitationId: string): Promise<RemoteAdminSnapshot>
  revoke(deviceId: string): Promise<RemoteAdminSnapshot>
  setDiscovery(enabled: boolean): Promise<RemoteAdminSnapshot>
}

/**
 * Bind typed administration calls to the generic Connection carrier.
 * @param rpc - trusted loopback Connection RPC client.
 * @returns strict Remote administration facade.
 */
export function createRemoteAdminClient(rpc: ClientConnectionRpc): RemoteAdminClient {
  const call = async (endpoint: string, payload: unknown): Promise<unknown> => {
    const result = await rpc.call('/remote-admin', endpoint, payload)
    if (!result.ok) throw new Error(`remote administration failed: ${result.error.code}`)
    return result.value
  }
  return {
    snapshot: async () => snapshot(await call('snapshot', {})),
    createInvitation: async profileValue => invitationResult(await call('invitation/create', { profile: profileValue })),
    confirm: async invitationId => snapshot(await call('pairing/confirm', { invitationId })),
    reject: async invitationId => snapshot(await call('pairing/reject', { invitationId })),
    revoke: async deviceId => snapshot(await call('device/revoke', { deviceId })),
    setDiscovery: async enabled => snapshot(await call('discovery/set', { enabled })),
  }
}

function snapshot(value: unknown): RemoteAdminSnapshot {
  const row = record(value)
  if (typeof row.available !== 'boolean'
    || !Array.isArray(row.pendingPairings)
    || !Array.isArray(row.devices)) throw new TypeError('invalid Remote administration snapshot')
  return {
    available: row.available,
    pendingPairings: row.pendingPairings.map(pending),
    devices: row.devices.map(device),
    discovery: discovery(row.discovery),
  }
}

function invitationResult(value: unknown): RemoteInvitationResult {
  const row = record(value)
  return { invitation: invitation(row.invitation), snapshot: snapshot(row.snapshot) }
}

function invitation(value: unknown): RemoteInvitationView {
  const row = record(value)
  return {
    invitationId: string(row, 'invitationId'),
    invitationUri: string(row, 'invitationUri'),
    hostFingerprint: string(row, 'hostFingerprint'),
    expiresAtMs: decimal(row, 'expiresAtMs'),
    capabilities: string(row, 'capabilities'),
    profile: profile(row, 'profile'),
  }
}

function pending(value: unknown): RemotePendingPairingView {
  const row = record(value)
  return {
    invitationId: identifier(row, 'invitationId'),
    deviceName: string(row, 'deviceName'),
    deviceFingerprint: string(row, 'deviceFingerprint'),
    verificationCode: string(row, 'verificationCode'),
    expiresAtMs: decimal(row, 'expiresAtMs'),
    capabilities: string(row, 'capabilities'),
    profile: profile(row, 'profile'),
  }
}

function device(value: unknown): RemotePairedDeviceView {
  const row = record(value)
  const revokedAtMs = row.revokedAtMs === undefined ? undefined : decimal(row, 'revokedAtMs')
  return {
    deviceId: identifier(row, 'deviceId'),
    displayName: string(row, 'displayName'),
    deviceFingerprint: string(row, 'deviceFingerprint'),
    capabilities: string(row, 'capabilities'),
    createdAtMs: decimal(row, 'createdAtMs'),
    ...(revokedAtMs === undefined ? {} : { revokedAtMs }),
    authorityEpoch: decimal(row, 'authorityEpoch'),
    profile: profile(row, 'profile'),
  }
}

function discovery(value: unknown): RemoteLanDiscoveryView {
  const row = record(value)
  if (typeof row.intended !== 'boolean' || typeof row.published !== 'boolean') {
    throw new TypeError('invalid Remote LAN discovery view')
  }
  return {
    intended: row.intended,
    published: row.published,
    ...(typeof row.displayName === 'string' ? { displayName: row.displayName } : {}),
    ...(typeof row.address === 'string' ? { address: row.address } : {}),
    ...(typeof row.port === 'number' ? { port: row.port } : {}),
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('expected object')
  return value as Record<string, unknown>
}

function string(row: Record<string, unknown>, key: string): string {
  if (typeof row[key] !== 'string') throw new TypeError(`expected string field ${key}`)
  return row[key]
}

function decimal(row: Record<string, unknown>, key: string): string {
  const value = string(row, key)
  if (!/^\d+$/u.test(value)) throw new TypeError(`expected decimal field ${key}`)
  return value
}

function identifier(row: Record<string, unknown>, key: string): string {
  const value = string(row, key)
  if (!/^[0-9a-f]{32}$/iu.test(value)) throw new TypeError(`expected identifier field ${key}`)
  return value
}

function profile(row: Record<string, unknown>, key: string): RemotePairingProfile {
  const value = string(row, key)
  if (value !== 'read-only'
    && value !== 'approval-reviewer'
    && value !== 'session-control'
    && value !== 'session-operator'
    && value !== 'session-supervisor'
    && value !== 'host-supervisor') {
    throw new TypeError(`expected Remote pairing profile field ${key}`)
  }
  return value
}
