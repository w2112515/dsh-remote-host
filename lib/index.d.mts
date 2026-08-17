import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/host/security.d.ts
/** Host security owner loaded from the shared Rust Node-API addon. */
/** One authenticated ordered transport returned only after Host authorization. */
interface RemoteSecureTransport {
  encrypt(plaintext: Buffer): Buffer;
  decrypt(ciphertext: Buffer): Buffer;
}
/** Host-side in-progress IK handshake. */
interface RemoteConnectionHandshake {
  read(message: Buffer): Buffer;
  write(payload: Buffer): Buffer;
  finished(): boolean;
  peerPublicKey(): Buffer;
  verificationCode(): string;
  finishTransport(): RemoteSecureTransport;
}
/** Result of authorizing the static identity authenticated by Noise IK. */
type RemoteAuthorizationDecision = {
  decision: 'allowed';
  deviceId: Buffer;
  grantedCapabilities: string;
  authorityEpoch: string;
} | {
  decision: 'unknown_device' | 'revoked' | 'capability_denied';
};
/** QR/manual-transfer material for one short-lived, Host-selected ceremony. */
interface RemotePairingInvitation {
  invitationId: Buffer;
  invitationPsk: Buffer;
  hostPublicKey: Buffer;
  expiresAtMs: string;
  capabilities: string;
  endpointHost: string;
  endpointPort: number;
}
/** Host-local review row created only after Noise authenticated the phone. */
interface RemotePendingPairing {
  invitationId: Buffer;
  devicePublicKey: Buffer;
  deviceName: string;
  verificationCode: string;
  expiresAtMs: string;
  capabilities: string;
}
/** Durable Host-local device view with no private material. */
interface RemoteDeviceAuthorization {
  deviceId: Buffer;
  publicKey: Buffer;
  displayName: string;
  capabilities: string;
  createdAtMs: string;
  revokedAtMs?: string;
  authorityEpoch: string;
}
/** Host-local terminal decision for one pending pairing ceremony. */
type RemotePairingDecision = 'confirmed' | 'rejected';
/** Capability-minimized security owner consumed by the physical carrier. */
interface RemoteSecurityOwner {
  hostPublicKey(): Buffer;
  createInvitation(nowMs: number, lifetimeMs: number, capabilities: string, endpointHost: string, endpointPort: number): RemotePairingInvitation;
  pairingResponder(invitationId: Buffer, presentedHostPublicKey: Buffer, nowMs: number): RemoteConnectionHandshake;
  stagePairing(invitationId: Buffer, devicePublicKey: Buffer, deviceName: string, verificationCode: string, nowMs: number): Promise<RemotePairingDecision>;
  pendingPairings(): RemotePendingPairing[];
  confirmPairing(invitationId: Buffer, nowMs: number): RemoteDeviceAuthorization;
  rejectPairing(invitationId: Buffer): void;
  listDevices(): RemoteDeviceAuthorization[];
  revoke(deviceId: Buffer, nowMs: number): boolean;
  connectionResponder(canonicalPrologue: Buffer): RemoteConnectionHandshake;
  authorizeCapabilities(devicePublicKey: Buffer, requiredCapabilities: string): RemoteAuthorizationDecision;
}
//#endregion
//#region src/host/pairing-admin.d.ts
/** Closed Host-local profiles; mobile payloads never choose a raw capability mask. */
type RemotePairingProfile = 'read-only' | 'session-control' | 'session-operator' | 'approval-reviewer' | 'session-supervisor' | 'host-supervisor';
/** Safe view rendered by a Host-local UI. */
interface PairingInvitationView {
  invitationId: string;
  invitationUri: string;
  hostFingerprint: string;
  expiresAtMs: string;
  capabilities: string;
  profile: RemotePairingProfile;
}
/** Authenticated phone awaiting a visible Host decision. */
interface PendingPairingView {
  invitationId: string;
  deviceName: string;
  deviceFingerprint: string;
  verificationCode: string;
  expiresAtMs: string;
  capabilities: string;
  profile: RemotePairingProfile;
}
/** Durable authorization row for local device management. */
interface PairedDeviceView {
  deviceId: string;
  displayName: string;
  deviceFingerprint: string;
  capabilities: string;
  createdAtMs: string;
  revokedAtMs?: string;
  authorityEpoch: string;
  profile: RemotePairingProfile;
}
/** Host-local LAN advertisement status shown on the administration page. */
interface RemoteLanDiscoveryView {
  /** Operator intent from composition plus the `host-remote` settings section. */
  intended: boolean;
  /** Whether this process currently advertises `_dsh-remote._tcp` on a private IPv4. */
  published: boolean;
  displayName?: string;
  address?: string;
  port?: number;
}
/** Empty discovery view used until the carrier publishes, or when LAN stays off. */
declare const REMOTE_LAN_DISCOVERY_OFF: RemoteLanDiscoveryView;
/**
 * Local administration owner. This object is provided only inside the Host
 * Cordis context; the mobile carrier never serializes its methods or views.
 */
declare class RemotePairingAdministrator {
  #private;
  private readonly security;
  private readonly onAuthorizationChanged;
  private readonly onLanDiscoveryChange?;
  constructor(security: RemoteSecurityOwner, endpointHost: string, endpointPort: number, onAuthorizationChanged?: (deviceId: string) => void, onLanDiscoveryChange?: ((enabled: boolean) => Promise<RemoteLanDiscoveryView>) | undefined);
  /**
   * Update an OS-assigned test port after the carrier binds.
   * @param port - bound IPv4 loopback port.
   */
  setEndpointPort(port: number): void;
  /**
   * Point later invitations at the address the carrier currently binds.
   * @param host - IPv4 bind address.
   * @param port - bound TCP port.
   */
  setEndpoint(host: string, port: number): void;
  /** Current LAN advertisement facts for the Host-local settings page. */
  discovery(): RemoteLanDiscoveryView;
  /**
   * Record the live advertisement after a successful bind or withdraw.
   * @param value - actual published state, not merely operator intent.
   */
  setDiscovery(value: RemoteLanDiscoveryView): void;
  /**
   * Persist operator intent and rebind when this Host wired a settings owner.
   * @param enabled - whether nearby phones should discover this Host.
   */
  setLanDiscovery(enabled: boolean): Promise<RemoteLanDiscoveryView>;
  /**
   * Mint one five-minute invitation for an exact closed Host-selected profile.
   * @param profile - explicit local access profile; read-only remains the default.
   * @param lifetimeMs - invitation lifetime in milliseconds.
   * @param nowMs - Host wall-clock timestamp.
   * @returns safe Host-local invitation view.
   */
  createInvitation(profile?: RemotePairingProfile, lifetimeMs?: number, nowMs?: number): PairingInvitationView;
  /**
   * List only Noise-authenticated ceremonies that require local review.
   * @returns current immutable review rows.
   */
  pendingPairings(): PendingPairingView[];
  /**
   * Commit the exact pending identity with the invitation-bound profile.
   * @param invitationId - reviewed invitation identifier.
   * @param nowMs - Host wall-clock timestamp.
   * @returns durable authorization view.
   */
  confirm(invitationId: string, nowMs?: number): PairedDeviceView;
  /**
   * Reject and retire a pending invitation without creating authorization.
   * @param invitationId - reviewed invitation identifier.
   */
  reject(invitationId: string): void;
  /**
   * List active and revoked device records for Host-local administration.
   * @returns current durable device views.
   */
  devices(): PairedDeviceView[];
  /**
   * Revoke one durable device identity, advance its fencing epoch, and terminate stale live authority.
   * @param deviceId - durable Host device identifier.
   * @param nowMs - Host wall-clock timestamp.
   * @returns whether an active authorization changed.
   */
  revoke(deviceId: string, nowMs?: number): boolean;
}
//#endregion
//#region src/host/lan-settings.d.ts
/** Settings namespace the Web plugin card and Mobile access page both write. */
declare const HOST_REMOTE_SETTINGS_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;
/** Operator-owned LAN fields persisted through `ctx.settings`. */
interface HostRemoteSettings {
  /** Advertise `_dsh-remote._tcp` on one private IPv4 interface. @default false */
  lanDiscovery: boolean;
  /** DNS-SD instance name; empty uses the machine hostname. */
  lanDisplayName: string;
  /** Exact private IPv4 when more than one phone-reachable LAN remains. */
  lanAddress: string;
}
/** Schema of the user-owned Remote LAN section. */
declare const HOST_REMOTE_SETTINGS_SCHEMA: z<HostRemoteSettings>;
//#endregion
//#region src/host/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-local pairing/revocation owner; never a mobile wire surface. */
    remotePairingAdmin: RemotePairingAdministrator;
  }
}
/** Stable Cordis function-plugin name. */
declare const name = "host-remote";
/** The sole privileged dependency, narrowed before the carrier sees it. */
declare const inject: string[];
/** Gate 0E authenticated loopback carrier configuration. */
interface Config {
  /** IPv4 loopback port; `0` asks the OS for an ephemeral port (tests only). @default 50051 */
  port?: number;
  /** Tail history message budget for one fresh snapshot. @default 200 */
  maxHistoryMessages?: number;
  /** Maximum serialized presenter characters in one tool card. @default 8192 */
  maxToolContentChars?: number;
  /** Offline lifetime for a detached same-process resume generation. @default 30000 */
  resumeRetentionTtlMs?: number;
  /** Maximum projected events retained by one resume generation. @default 512 */
  maxRetainedEvents?: number;
  /** Maximum UTF-8 JSON bytes retained by one resume generation. @default 2097152 */
  maxRetainedJsonBytes?: number;
  /** Maximum retained generations across all authenticated devices. @default 64 */
  maxRetainedGenerations?: number;
  /** Explicit Node-API binary override; omitted resolves the reviewed package for this Host platform. */
  securityAddonPath?: string;
  /** Current-user protected Host identity and device-authorization store. */
  securityStorePath: string;
  /** Explicitly advertise and bind the carrier on one private IPv4 interface. @default false */
  lanDiscovery?: boolean;
  /** Stable operator-facing DNS-SD instance name; required when LAN discovery is enabled. */
  lanDisplayName?: string;
  /** Active private IPv4 interface; required when automatic selection is ambiguous. */
  lanAddress?: string;
  /**
   * Operator project registry (S-project): sessions whose cwd equals a `root`
   * or sits under it carry that row's `label` in directory summaries. Roots
   * never cross the carrier; sessions without a match carry no label.
   * @default []
   */
  projects?: {
    root: string;
    label: string;
  }[];
  /** Sessions scanned per artifact roster build (S-artifacts). @default 20 */
  artifactScanSessions?: number;
  /** History events scanned per session for the artifact roster. @default 500 */
  artifactScanEvents?: number;
  /** Maximum artifact roster rows carried in the hello snapshot. @default 100 */
  artifactRosterCap?: number;
  /**
   * Blob upload staging root (S-blob): incomplete transfers live here until
   * they resume, complete, or hit the sweep TTL.
   * @default <dsh-home>/remote-blob-staging/v1
   */
  blobStagingDir?: string;
}
declare const Config: z<Config>;
/**
 * Start the authenticated carrier and join every stream plus the listener
 * during plugin disposal. LAN advertisement follows the live `host-remote`
 * settings section when one is registered.
 */
declare function apply(ctx: Context, config: Config): Promise<void>;
//#endregion
export { Config, HOST_REMOTE_SETTINGS_NAMESPACE, HOST_REMOTE_SETTINGS_SCHEMA, type HostRemoteSettings, REMOTE_LAN_DISCOVERY_OFF, type RemoteLanDiscoveryView, RemotePairingAdministrator, apply, inject, name };
//# sourceMappingURL=index.d.mts.map