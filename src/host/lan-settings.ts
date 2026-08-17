/** Operator-owned LAN settings helpers for the live `host-remote` section. */

import { hostname } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { resolveRemoteLanAdvertisement } from './discovery.ts'

/** Settings namespace the Web plugin card and Mobile access page both write. */
export const HOST_REMOTE_SETTINGS_NAMESPACE = settingsNamespace('host-remote')

/** Operator-owned LAN fields persisted through `ctx.settings`. */
export interface HostRemoteSettings {
  /** Advertise `_dsh-remote._tcp` on one private IPv4 interface. @default false */
  lanDiscovery: boolean
  /** DNS-SD instance name; empty uses the machine hostname. */
  lanDisplayName: string
  /** Exact private IPv4 when more than one phone-reachable LAN remains. */
  lanAddress: string
}

/** Schema of the user-owned Remote LAN section. */
export const HOST_REMOTE_SETTINGS_SCHEMA: z<HostRemoteSettings> = z.object({
  lanDiscovery: z.boolean().default(false),
  lanDisplayName: z.string().default(''),
  lanAddress: z.string().default(''),
})

/** Composition-config fields that seed the settings section. */
export interface HostRemoteLanConfig {
  lanDiscovery?: boolean
  lanDisplayName?: string
  lanAddress?: string
}

/** Composition entry projected into the `host-remote` settings namespace. */
export function hostRemoteSettingsEntry(config: HostRemoteLanConfig): HostRemoteSettings {
  return {
    lanDiscovery: config.lanDiscovery === true,
    lanDisplayName: config.lanDisplayName ?? '',
    lanAddress: config.lanAddress ?? '',
  }
}

/** DNS-SD instance name: operator string, else the machine hostname. */
export function resolvedLanDisplayName(value: HostRemoteSettings): string {
  const named = value.lanDisplayName.trim()
  return named === '' ? hostname() : named
}

/** Whether two LAN sections would bind the same advertisement. */
export function sameHostRemoteSettings(left: HostRemoteSettings, right: HostRemoteSettings): boolean {
  return left.lanDiscovery === right.lanDiscovery
    && left.lanDisplayName === right.lanDisplayName
    && left.lanAddress === right.lanAddress
}

/**
 * Reject a LAN-on section the carrier could not bind.
 * @param value - resolved settings section.
 * @param port - configured carrier port.
 * @param hostPublicKey - native Host identity, absent when the addon did not load.
 */
export function validateHostRemoteSettings(
  value: HostRemoteSettings,
  port: number,
  hostPublicKey: Buffer | undefined,
): void {
  if (value.lanDiscovery !== true) return
  if (hostPublicKey === undefined) {
    throw new Error('host-remote: LAN discovery requires the native security owner')
  }
  resolveRemoteLanAdvertisement({
    displayName: resolvedLanDisplayName(value),
    ...(value.lanAddress.trim() === '' ? {} : { address: value.lanAddress.trim() }),
    port,
    hostPublicKey,
  })
}
