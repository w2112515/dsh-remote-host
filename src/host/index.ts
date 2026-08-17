/**
 * @deepseek-ai/dsh-host-remote — source-backed, read-only mobile projection
 * carrier. It closes `ctx.apiProxy` over a capability-minimized port and exposes
 * it only after the shared security core authenticates and authorizes a paired
 * device. Effectful commands remain explicitly rejected.
 * @module @deepseek-ai/dsh-host-remote
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@w2112515/dsh-remote-host/command'
import type {} from '@w2112515/dsh-remote-host/control'
import type { RemoteDeviceId } from '@w2112515/dsh-remote-host/control'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { RemotePairingAdministrator, REMOTE_LAN_DISCOVERY_OFF, type RemoteLanDiscoveryView } from './pairing-admin.ts'
import { advertiseRemoteLanHost, resolveRemoteLanAdvertisement } from './discovery.ts'
import {
  HOST_REMOTE_SETTINGS_NAMESPACE,
  HOST_REMOTE_SETTINGS_SCHEMA,
  hostRemoteSettingsEntry,
  resolvedLanDisplayName,
  sameHostRemoteSettings,
  validateHostRemoteSettings,
  type HostRemoteSettings,
} from './lan-settings.ts'
import { createArtifactRegistry, resolveArtifactRegistrySpec } from './artifact-registry.ts'
import { createBlobFetchServer, resolveBlobFetchSpec } from './blob-fetch.ts'
import { createBlobTransferAssembler, resolveBlobTransferSpec } from './blob-transfer.ts'
import { installApprovalPolicyOwner } from './policy-owner.ts'
import { createRemoteProjectionReadPort } from './read-port.ts'
import { loadRemoteSecurityOwner, classifyRemoteSecurityLoadFailure } from './security.ts'
import { RemoteGrpcCarrier } from './transport.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-local pairing/revocation owner; never a mobile wire surface. */
    remotePairingAdmin: RemotePairingAdministrator
  }
}

export { RemotePairingAdministrator, REMOTE_LAN_DISCOVERY_OFF } from './pairing-admin.ts'
export type { RemoteLanDiscoveryView } from './pairing-admin.ts'
export {
  HOST_REMOTE_SETTINGS_NAMESPACE,
  HOST_REMOTE_SETTINGS_SCHEMA,
  type HostRemoteSettings,
} from './lan-settings.ts'

/** Stable Cordis function-plugin name. */
export const name = 'host-remote'
/** The sole privileged dependency, narrowed before the carrier sees it. */
export const inject = ['apiProxy']

/** Gate 0E authenticated loopback carrier configuration. */
export interface Config {
  /** IPv4 loopback port; `0` asks the OS for an ephemeral port (tests only). @default 50051 */
  port?: number
  /** Tail history message budget for one fresh snapshot. @default 200 */
  maxHistoryMessages?: number
  /** Maximum serialized presenter characters in one tool card. @default 8192 */
  maxToolContentChars?: number
  /** Offline lifetime for a detached same-process resume generation. @default 30000 */
  resumeRetentionTtlMs?: number
  /** Maximum projected events retained by one resume generation. @default 512 */
  maxRetainedEvents?: number
  /** Maximum UTF-8 JSON bytes retained by one resume generation. @default 2097152 */
  maxRetainedJsonBytes?: number
  /** Maximum retained generations across all authenticated devices. @default 64 */
  maxRetainedGenerations?: number
  /** Explicit Node-API binary override; omitted resolves the reviewed package for this Host platform. */
  securityAddonPath?: string
  /** Current-user protected Host identity and device-authorization store. */
  securityStorePath: string
  /** Explicitly advertise and bind the carrier on one private IPv4 interface. @default false */
  lanDiscovery?: boolean
  /** Stable operator-facing DNS-SD instance name; required when LAN discovery is enabled. */
  lanDisplayName?: string
  /** Active private IPv4 interface; required when automatic selection is ambiguous. */
  lanAddress?: string
  /**
   * Operator project registry (S-project): sessions whose cwd equals a `root`
   * or sits under it carry that row's `label` in directory summaries. Roots
   * never cross the carrier; sessions without a match carry no label.
   * @default []
   */
  projects?: { root: string; label: string }[]
  /** Sessions scanned per artifact roster build (S-artifacts). @default 20 */
  artifactScanSessions?: number
  /** History events scanned per session for the artifact roster. @default 500 */
  artifactScanEvents?: number
  /** Maximum artifact roster rows carried in the hello snapshot. @default 100 */
  artifactRosterCap?: number
  /**
   * Blob upload staging root (S-blob): incomplete transfers live here until
   * they resume, complete, or hit the sweep TTL.
   * @default <dsh-home>/remote-blob-staging/v1
   */
  blobStagingDir?: string
}

export const Config: z<Config> = z.object({
  port: z.natural().max(65_535).default(50_051),
  maxHistoryMessages: z.number().step(1).min(1).max(1_000).default(200),
  maxToolContentChars: z.number().step(1).min(256).max(65_536).default(8_192),
  resumeRetentionTtlMs: z.number().step(1).min(100).max(300_000).default(30_000),
  maxRetainedEvents: z.number().step(1).min(1).max(10_000).default(512),
  maxRetainedJsonBytes: z.number().step(1).min(1_024).max(67_108_864).default(2_097_152),
  maxRetainedGenerations: z.number().step(1).min(1).max(1_024).default(64),
  securityAddonPath: z.string(),
  securityStorePath: z.string().required(),
  lanDiscovery: z.boolean().default(false),
  lanDisplayName: z.string(),
  lanAddress: z.string(),
  projects: z.array(z.object({
    root: z.string().min(1).max(1_024),
    label: z.string().min(1).max(100),
  })).max(256).default([]),
  artifactScanSessions: z.number().step(1).min(1).max(100).default(20),
  artifactScanEvents: z.number().step(1).min(1).max(2_000).default(500),
  artifactRosterCap: z.number().step(1).min(1).max(1_000).default(100),
  blobStagingDir: z.string(),
})

/**
 * Start the authenticated carrier and join every stream plus the listener
 * during plugin disposal. LAN advertisement follows the live `host-remote`
 * settings section when one is registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // S-policy owner: event vocabulary, projection unit, prepended answerer,
  // and the ctx.remoteApprovalPolicy face the command executor consumes.
  installApprovalPolicyOwner(ctx)
  const source = createRemoteProjectionReadPort(ctx.apiProxy, { projects: config.projects ?? [] })
  const port = config.port ?? 50_051
  const entry = hostRemoteSettingsEntry(config)
  let security: ReturnType<typeof loadRemoteSecurityOwner> | undefined
  try {
    security = loadRemoteSecurityOwner(config.securityAddonPath, config.securityStorePath)
  } catch (error) {
    const reason = classifyRemoteSecurityLoadFailure(error, config.securityAddonPath)
    if (reason === undefined) throw error
    ctx.logger.warn(`host-remote: ${error instanceof Error ? error.message : String(error)}`)
  }
  let settingsSource: () => HostRemoteSettings = () => entry
  let appliedLan = entry
  let lanRuntime: { replace(next: HostRemoteSettings): Promise<void> } | undefined
  installSettingsSection(ctx, HOST_REMOTE_SETTINGS_NAMESPACE, HOST_REMOTE_SETTINGS_SCHEMA, entry, {
    validate: (value) => {
      validateHostRemoteSettings(value, port, security?.hostPublicKey())
    },
    setSource: (current) => {
      settingsSource = current
    },
    onChange: () => {
      const next = settingsSource()
      if (sameHostRemoteSettings(appliedLan, next)) return
      appliedLan = next
      void lanRuntime?.replace(next).catch((error: unknown) => {
        ctx.logger.warn(`host-remote: LAN rebind failed: ${String(error)}`)
      })
    },
  })
  if (security === undefined) return

  const artifacts = createArtifactRegistry(resolveArtifactRegistrySpec({
    listSessions: async () => (await source.list()).map(session => ({
      sessionId: session.sessionId,
      updatedAtMs: session.updatedAt,
    })),
    readHistory: async (sessionId, maxEvents) => {
      const [cut, cwd] = await Promise.all([
        source.history(sessionId, maxEvents),
        source.sessionCwd(sessionId),
      ])
      return { entries: cut.entries, cwd }
    },
    maxSessions: config.artifactScanSessions ?? 20,
    maxEventsPerSession: config.artifactScanEvents ?? 500,
    rosterCap: config.artifactRosterCap ?? 100,
    contentCharCap: config.maxToolContentChars ?? 8_192,
  }))
  const securityOwner = security
  await ctx.effect(async () => {
    // Blob channel owners (S-blob, ADR-005). Uploads exist only when the
    // deployment composes an attachment store — the commit callback IS that
    // owner's saveImage, so a stored blob is a committed, deduped image.
    // Fetches are always composed: artifact resolution needs no attachment
    // owner, and the attachment ACL simply denies when none exists.
    const attachments = ctx.get('attachments')
    const assembler = attachments === undefined
      ? undefined
      : await createBlobTransferAssembler(resolveBlobTransferSpec({
        stagingDir: config.blobStagingDir ?? join(resolveDshHome(undefined), 'remote-blob-staging', 'v1'),
        maxBlobBytes: attachments.imageLimits.maxImageBytes,
        commit: async (staged) => {
          const declared = staged.declaration.mediaType
          if (declared === undefined
            || !(attachments.imageLimits.mediaTypes as readonly string[]).includes(declared)) {
            throw new Error(`declared media type "${declared ?? ''}" is not an accepted image type`)
          }
          // saveImage re-validates the raster against fully decoded bytes; the
          // declared type is only a routing hint until that check passes.
          const data = await readFile(staged.path)
          const ref = await attachments.saveImage({ data, mediaType: declared as ImageMediaType })
          return String(ref.attachmentId)
        },
      }))
    const fetchServer = createBlobFetchServer(resolveBlobFetchSpec({
      resolveAttachment: (attachmentId, sessionId) =>
        attachments === undefined
          ? Promise.resolve(undefined)
          : source.attachmentRef(sessionId, attachmentId),
      readAttachment: async (ref) => {
        if (attachments === undefined) throw new Error('attachment service is not composed')
        const stored = await attachments.readImage(ref)
        return stored.data
      },
      resolveArtifact: (artifactId, sessionId) =>
        Promise.resolve(artifacts.resolve(artifactId, sessionId)),
    }))
    const sweepTimer = setInterval(() => {
      void assembler?.sweep().catch((error: unknown) => {
        ctx.logger.warn(`host-remote: blob transfer sweep failed: ${String(error)}`)
      })
      void fetchServer.sweep().catch((error: unknown) => {
        ctx.logger.warn(`host-remote: blob fetch sweep failed: ${String(error)}`)
      })
    }, 600_000)
    sweepTimer.unref()
    const disposeBlobOwners = async (): Promise<void> => {
      clearInterval(sweepTimer)
      await assembler?.dispose()
      await fetchServer.dispose()
    }
    interface CarrierSession {
      readonly carrier: RemoteGrpcCarrier
      stop(): Promise<void>
    }

    const startSession = async (lanSettings: HostRemoteSettings): Promise<CarrierSession> => {
      const lan = lanSettings.lanDiscovery === true
        ? resolveRemoteLanAdvertisement({
          displayName: resolvedLanDisplayName(lanSettings),
          ...(lanSettings.lanAddress.trim() === '' ? {} : { address: lanSettings.lanAddress.trim() }),
          port,
          hostPublicKey: securityOwner.hostPublicKey(),
        })
        : undefined
      const carrier = new RemoteGrpcCarrier(source, {
        ...(lan === undefined ? {} : { host: lan.address }),
        port,
        maxHistoryMessages: config.maxHistoryMessages ?? 200,
        maxToolContentChars: config.maxToolContentChars ?? 8_192,
        resumeRetentionTtlMs: config.resumeRetentionTtlMs ?? 30_000,
        maxRetainedEvents: config.maxRetainedEvents ?? 512,
        maxRetainedJsonBytes: config.maxRetainedJsonBytes ?? 2_097_152,
        maxRetainedGenerations: config.maxRetainedGenerations ?? 64,
        hostInstanceId: randomUUID(),
        hostDisplayName: resolvedLanDisplayName(lanSettings),
        security: securityOwner,
        control: () => ctx.get('remoteControl'),
        commands: () => ctx.get('remoteCommands'),
        policy: () => ctx.get('remoteApprovalPolicy'),
        artifacts,
        blobs: {
          ...(assembler === undefined ? {} : { assembler }),
          fetch: fetchServer,
          ...(attachments === undefined ? {} : { attachmentLimits: attachments.imageLimits }),
        },
      })
      const boundPort = await carrier.start()
      let disposeAdvertisement: (() => Promise<void>) | undefined
      try {
        disposeAdvertisement = lan === undefined
          ? undefined
          : await advertiseRemoteLanHost({ ...lan, port: boundPort }, (renamed) => {
            ctx.logger.warn(`host-remote: LAN advertisement renamed to "${renamed}" — another responder already defends "${lan.displayName}"; choose a unique lanDisplayName`)
          })
      } catch (error) {
        await carrier.stop()
        throw error
      }
      const discovery: RemoteLanDiscoveryView = lan === undefined
        ? { ...REMOTE_LAN_DISCOVERY_OFF }
        : {
          intended: true,
          published: true,
          displayName: lan.displayName,
          address: lan.address,
          port: boundPort,
        }
      pairingAdmin.setEndpoint(lan?.address ?? '127.0.0.1', boundPort)
      pairingAdmin.setDiscovery(discovery)
      return {
        carrier,
        stop: async () => {
          try {
            await disposeAdvertisement?.()
          } finally {
            await carrier.stop()
          }
        },
      }
    }

    const pairingAdmin: RemotePairingAdministrator = new RemotePairingAdministrator(
      securityOwner,
      '127.0.0.1',
      port,
      (deviceId) => {
        live?.carrier.fenceAuthorizationChanges()
        const control = ctx.get('remoteControl')
        if (control !== undefined) {
          void control.invalidateDevice(deviceId as RemoteDeviceId).catch((error: unknown) => {
            ctx.logger.warn(`host-remote: revoked device lease cleanup failed: ${String(error)}`)
          })
        }
      },
      async (enabled): Promise<RemoteLanDiscoveryView> => {
        const next = { ...settingsSource(), lanDiscovery: enabled }
        validateHostRemoteSettings(next, port, securityOwner.hostPublicKey())
        if (lanRuntime === undefined) throw new Error('LAN discovery cannot be changed in this deployment')
        await lanRuntime.replace(next)
        appliedLan = next
        const settings = ctx.get('settings') as { update(ns: typeof HOST_REMOTE_SETTINGS_NAMESPACE, patch: object): Promise<void> } | undefined
        if (settings !== undefined) await settings.update(HOST_REMOTE_SETTINGS_NAMESPACE, { lanDiscovery: enabled })
        return pairingAdmin.discovery()
      },
    )
    let live: CarrierSession | undefined
    let replacing = Promise.resolve()
    const replaceSession = async (next: HostRemoteSettings): Promise<void> => {
      const session = await startSession(next)
      const previous = live
      live = session
      appliedLan = next
      if (previous !== undefined) await previous.stop()
    }
    lanRuntime = {
      replace: (next) => {
        replacing = replacing.then(() => replaceSession(next), () => replaceSession(next))
        return replacing
      },
    }
    try {
      await replaceSession(settingsSource())
    } catch (error) {
      await disposeBlobOwners()
      throw error
    }
    const disposePairingAdmin = ctx.provide('remotePairingAdmin', pairingAdmin)
    return async () => {
      lanRuntime = undefined
      disposePairingAdmin()
      try {
        await replacing
        await live?.stop()
      } finally {
        await disposeBlobOwners()
      }
    }
  }, 'host-remote: authenticated gRPC carrier')
}
