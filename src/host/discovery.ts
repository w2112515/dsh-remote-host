/** Privacy-minimized DNS-SD advertisement for an explicitly LAN-bound Host. */

import { createHash } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { networkInterfaces, platform } from 'node:os'
import { getResponder, Protocol } from '@homebridge/ciao'

/** DNS-SD service queried by the native Android discovery flow. */
export const REMOTE_DISCOVERY_SERVICE_TYPE = 'dsh-remote'
/**
 * DNS-SD service of the resident supervisor's management channel (ADR-007).
 * A distinct type keeps Session discovery unambiguous: existing clients
 * never mistake the management endpoint for a projection endpoint, and the
 * supervisor stays discoverable while the dsh child is down.
 */
export const SUPERVISOR_DISCOVERY_SERVICE_TYPE = 'dsh-remote-sup'
/** Version of the privacy-minimized discovery TXT contract. */
export const REMOTE_DISCOVERY_VERSION = '1'

/** Operator-owned inputs for one privacy-minimized LAN advertisement. */
export interface RemoteLanAdvertisementOptions {
  displayName: string
  address?: string
  port: number
  hostPublicKey: Buffer
}

/** Validated endpoint and public identity safe to publish over DNS-SD. */
export interface ResolvedRemoteLanAdvertisement {
  displayName: string
  address: string
  port: number
  hostId: string
  platform: string
}

/** Public TXT fields; deliberately excludes every DSH Session or device fact. */
export interface RemoteLanDiscoveryTxt {
  v: string
  id: string
  platform: string
  pairing: string
}

/**
 * Supervisor TXT fields (ADR-007). No `pairing` key: pairing is never
 * served on the management port, and advertising a ceremony this endpoint
 * cannot perform would be dishonest.
 */
export interface SupervisorLanDiscoveryTxt {
  v: string
  id: string
  platform: string
}

/** One active Host interface the selector may consider. */
export type RemoteLanAddressCandidate =
  | string
  | {
    readonly name?: string
    readonly address: string
  }

function isLanIpv4(address: string): boolean {
  const octets = address.split('.').map(value => Number.parseInt(value, 10))
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false
  }
  const [first = -1, second = -1] = octets
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
    || (first === 100 && second >= 64 && second <= 127)
}

function lanCandidateAddress(candidate: RemoteLanAddressCandidate): string {
  return typeof candidate === 'string' ? candidate : candidate.address
}

function lanCandidateName(candidate: RemoteLanAddressCandidate): string {
  return typeof candidate === 'string' ? '' : (candidate.name ?? '')
}

function isLinkLocalIpv4(address: string): boolean {
  return address.startsWith('169.254.')
}

function isCgnatIpv4(address: string): boolean {
  const octets = address.split('.').map(value => Number.parseInt(value, 10))
  const [first = -1, second = -1] = octets
  return first === 100 && second >= 64 && second <= 127
}

const VIRTUAL_INTERFACE = new RegExp(
  [
    'vmware|vmnet|vethernet|hyper-?v|virtualbox|vbox|wsl|docker|virbr',
    'tailscale|zerotier|hamachi|radmin|mihomo|clash|npcap|bluetooth',
    'isatap|teredo|loopback|pseudo|tap-|tun-|\\bvpn\\b',
  ].join('|'),
  'i',
)

function isVirtualInterfaceName(name: string): boolean {
  return name !== '' && VIRTUAL_INTERFACE.test(name)
}

function isWifiInterfaceName(name: string): boolean {
  return /wi-?fi|wlan|无线/i.test(name)
}

function isEthernetInterfaceName(name: string): boolean {
  return /ethernet|以太网|local area connection/i.test(name)
}

/** Higher ranks win; `0` is ignored by automatic selection. */
function autoRank(candidate: RemoteLanAddressCandidate): 0 | 1 | 2 | 3 {
  const address = lanCandidateAddress(candidate)
  if (!isLanIpv4(address) || isLinkLocalIpv4(address) || isCgnatIpv4(address)) return 0
  const name = lanCandidateName(candidate)
  if (isVirtualInterfaceName(name)) return 0
  if (isWifiInterfaceName(name)) return 3
  if (isEthernetInterfaceName(name)) return 2
  return 1
}

/**
 * Resolve one phone-reachable private IPv4 interface.
 * Virtual, link-local and CGNAT/VPN addresses are ignored unless the operator
 * names them with `lanAddress`. Two remaining physical LANs still fail closed.
 * @param preferredAddress - Optional operator-selected address.
 * @returns The unique eligible LAN address.
 */
export function resolveRemoteLanAddress(preferredAddress?: string): string {
  const candidates: Array<{ name: string; address: string }> = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isLanIpv4(entry.address)) {
        candidates.push({ name, address: entry.address })
      }
    }
  }
  return selectRemoteLanAddress(candidates, preferredAddress)
}

/**
 * Select one private interface from a captured Host network snapshot.
 * @param candidates - Active non-loopback IPv4 interfaces, optionally named.
 * @param preferredAddress - Optional operator-selected address.
 * @returns The unique eligible LAN address.
 */
export function selectRemoteLanAddress(
  candidates: readonly RemoteLanAddressCandidate[],
  preferredAddress?: string,
): string {
  const usable = candidates.filter(candidate => isLanIpv4(lanCandidateAddress(candidate)))
  const unique = [...new Set(usable.map(lanCandidateAddress))].sort()
  if (preferredAddress !== undefined) {
    if (!isIPv4(preferredAddress) || !isLanIpv4(preferredAddress) || !unique.includes(preferredAddress)) {
      throw new Error('host-remote: lanAddress must be an active private IPv4 interface')
    }
    return preferredAddress
  }
  if (unique.length === 0) throw new Error('host-remote: LAN discovery found no private IPv4 interface')
  const ranked = usable
    .map(candidate => ({ address: lanCandidateAddress(candidate), rank: autoRank(candidate) }))
    .filter(entry => entry.rank > 0)
  const bestRank = ranked.reduce((best, entry) => Math.max(best, entry.rank), 0)
  const chosen = [...new Set(ranked.filter(entry => entry.rank === bestRank).map(entry => entry.address))].sort()
  if (chosen.length === 1) return chosen[0] as string
  const options = (chosen.length > 1 ? chosen : unique).join(', ')
  throw new Error(`host-remote: LAN discovery is ambiguous; choose lanAddress from ${options}`)
}

/**
 * Validate and minimize the public discovery record before multicast publication.
 * @param options - Operator identity, bound endpoint and stable Host public key.
 * @returns Bounded advertisement fields with no DSH Session metadata.
 */
export function resolveRemoteLanAdvertisement(
  options: RemoteLanAdvertisementOptions,
): ResolvedRemoteLanAdvertisement {
  const displayName = options.displayName.trim()
  if (displayName.length === 0 || Buffer.byteLength(displayName, 'utf8') > 63) {
    throw new Error('host-remote: lanDisplayName must contain 1-63 UTF-8 bytes')
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error('host-remote: LAN discovery port is invalid')
  }
  if (options.hostPublicKey.length !== 32) throw new Error('host-remote: Host public key is invalid')
  return {
    displayName,
    address: resolveRemoteLanAddress(options.address),
    port: options.port,
    hostId: remoteLanHostId(options.hostPublicKey),
    platform: platform(),
  }
}

/**
 * Derive the non-secret stable discovery identity from the Host public key.
 * @param hostPublicKey - Pinned 32-byte Host public key.
 * @returns Uppercase SHA-256 fingerprint without separators.
 */
export function remoteLanHostId(hostPublicKey: Buffer): string {
  if (hostPublicKey.length !== 32) throw new Error('host-remote: Host public key is invalid')
  return createHash('sha256').update(hostPublicKey).digest('hex').toUpperCase()
}

/**
 * Build the complete allowlisted TXT record.
 * @param resolved - Validated advertisement identity.
 * @returns Exact public discovery fields.
 */
export function remoteLanDiscoveryTxt(
  resolved: ResolvedRemoteLanAdvertisement,
): RemoteLanDiscoveryTxt {
  return {
    v: REMOTE_DISCOVERY_VERSION,
    id: resolved.hostId,
    platform: resolved.platform,
    pairing: 'required',
  }
}

/**
 * Publish one RFC 6763 service and return a goodbye-packet disposal closure.
 * @param resolved - Validated privacy-minimized advertisement.
 * @param onNameChange - Observes a DNS-SD conflict rename (another responder
 * on the LAN already defends this instance name); absent, ciao's fallback
 * console warning stays.
 * @returns Async cleanup that withdraws the service and closes its responder.
 */
export async function advertiseRemoteLanHost(
  resolved: ResolvedRemoteLanAdvertisement,
  onNameChange?: (name: string) => void,
): Promise<() => Promise<void>> {
  return await advertiseLanService(resolved, REMOTE_DISCOVERY_SERVICE_TYPE, remoteLanDiscoveryTxt(resolved), {
    ...(onNameChange === undefined ? {} : { onNameChange }),
  })
}

/**
 * Build the supervisor's allowlisted TXT record (ADR-007).
 * @param resolved - Validated advertisement identity.
 * @returns Exact public discovery fields; no pairing claim.
 */
export function supervisorLanDiscoveryTxt(
  resolved: ResolvedRemoteLanAdvertisement,
): SupervisorLanDiscoveryTxt {
  return {
    v: REMOTE_DISCOVERY_VERSION,
    id: resolved.hostId,
    platform: resolved.platform,
  }
}

/**
 * The supervisor responder's mDNS hostname (ADR-007). ciao defaults a
 * service's hostname to its instance name, so the resident supervisor and
 * every dsh child it spawns would both probe `<displayName>.local` — the
 * child then loses to the established supervisor and renames itself to
 * "<displayName> (2)" on the phone's discovery list at every restart. The
 * supervisor therefore claims a fingerprint-derived hostname (never
 * user-visible; discovery UIs show the instance name) and the child keeps
 * the pristine default.
 * @param hostId - Uppercase SHA-256 Host fingerprint from {@link remoteLanHostId}.
 * @returns A stable single-label hostname distinct from any display name.
 */
export function supervisorLanHostname(hostId: string): string {
  return `dsh-sup-${hostId.slice(0, 16).toLowerCase()}`
}

/**
 * Publish the supervisor management presence (ADR-007). Identity fields are
 * identical to the Remote advertisement — the same `id` fingerprint lets a
 * paired phone bind the management endpoint to its pinned Host — while the
 * distinct service type keeps Session discovery lists clean.
 * @param resolved - Validated privacy-minimized advertisement (management port).
 * @param onNameChange - Observes a DNS-SD conflict rename (another responder
 * on the LAN already defends this instance name); absent, ciao's fallback
 * console warning stays.
 * @returns Async cleanup that withdraws the service and closes its responder.
 */
export async function advertiseSupervisorLanHost(
  resolved: ResolvedRemoteLanAdvertisement,
  onNameChange?: (name: string) => void,
): Promise<() => Promise<void>> {
  return await advertiseLanService(resolved, SUPERVISOR_DISCOVERY_SERVICE_TYPE, supervisorLanDiscoveryTxt(resolved), {
    hostname: supervisorLanHostname(resolved.hostId),
    ...(onNameChange === undefined ? {} : { onNameChange }),
  })
}

async function advertiseLanService(
  resolved: ResolvedRemoteLanAdvertisement,
  serviceType: string,
  txt: RemoteLanDiscoveryTxt | SupervisorLanDiscoveryTxt,
  options?: { hostname?: string; onNameChange?: (name: string) => void },
): Promise<() => Promise<void>> {
  const responder = getResponder({ interface: resolved.address, disableIpv6: true })
  const service = responder.createService({
    name: resolved.displayName,
    type: serviceType,
    protocol: Protocol.TCP,
    port: resolved.port,
    restrictedAddresses: [resolved.address],
    disabledIpv6: true,
    txt,
    ...(options?.hostname === undefined ? {} : { hostname: options.hostname }),
  })
  const onNameChange = options?.onNameChange
  if (onNameChange !== undefined) {
    service.on('name-change', onNameChange)
  }
  try {
    await service.advertise()
  } catch (error) {
    await responder.shutdown().catch(() => undefined)
    throw error
  }
  return async () => {
    try {
      await service.destroy()
    } finally {
      await responder.shutdown()
    }
  }
}
