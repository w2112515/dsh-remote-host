/** Noise-authenticated gRPC carrier for the read-only Remote projection. */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import type {
  HostApprovalPolicy,
  RemoteCommandAuthority,
  RemoteApprovalCommandId,
  RemoteCommandControlProof,
  RemoteCommandService,
  RemoteCommandTerminal,
  RemoteCreateSessionCommandId,
  RemoteForkSessionCommandId,
  RemoteRevokeApprovalRuleCommandId,
  RemoteSelectAgentPresetCommandId,
  RemoteSelectModelCommandId,
  RemoteSendCommandId,
  RemoteSetSessionBudgetCommandId,
  RemoteStopCommandId,
  RemoteStopTerminal,
} from '@w2112515/dsh-remote-host/command'
import { sanitizeRemoteWorkspaceName } from '@w2112515/dsh-remote-host/command'
import type {
  RemoteControlFailure,
  RemoteControlLease,
  RemoteControlProof,
  RemoteControlService,
  RemoteDeviceId,
} from '@w2112515/dsh-remote-host/control'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { BlobFetchError, type BlobFetchFailureCode, type BlobFetchServer, type BlobFetchSource } from './blob-fetch.ts'
import {
  BLOB_CHUNK_BYTES,
  BLOB_SHA256_PATTERN,
  BLOB_TRANSFER_ID_PATTERN,
  BlobTransferError,
  type BlobTransferAssembler,
  type BlobTransferFailureCode,
} from './blob-transfer.ts'
import {
  type ProjectionCursorDomain,
  type ProjectionDelivery,
  RetainedProjectionCursorStore,
  type RetainedProjectionGeneration,
} from './cursor.ts'
import type { RemoteProjectionReadPort, RemoteReadFrame } from './read-port.ts'
import { RemoteReadError } from './read-port.ts'
import {
  PROJECTION_VERSION, modelSelectionWire, projectApprovalFrame, projectInputAttentionFrame, projectLiveFrame,
  projectPolicyFrame, projectSnapshot, projectSubagentFrame, projectUsageFrame, sessionUsageWire, subagentViewWire,
} from './projection.ts'
import type { ArtifactRegistry } from './artifact-registry.ts'
import {
  MAX_NOISE_MESSAGE_BYTES,
  MAX_NOISE_PLAINTEXT_BYTES,
  SecureChannelServer,
  type SecureChannelCall,
} from './secure-channel.ts'
import {
  REMOTE_APPROVAL_CAPABILITIES,
  REMOTE_CONTROL_CAPABILITIES,
  REMOTE_READ_CAPABILITIES,
  REMOTE_SEND_CONTROL_CAPABILITIES,
  REMOTE_STOP_CONTROL_CAPABILITIES,
  type RemoteConnectionHandshake,
  type RemoteSecureTransport,
  type RemoteSecurityOwner,
} from './security.ts'

const PROTOCOL_VERSION = 1
const LOOPBACK_HOST = '127.0.0.1'
const MAX_SECURE_ENVELOPE_BYTES = 70_000

interface ClientFrame {
  hello?: { protocol_version?: number }
  subscribe?: {
    session_id?: string
    resume?: { stream_id?: string; projection_version?: number; highest_contiguous_sequence?: string }
    force_fresh_snapshot?: boolean
  }
  ack?: { stream_id?: string; projection_version?: number; highest_contiguous_sequence?: string }
  command?: {
    command_id?: string
    session_id?: string
    control?: { epoch?: string; token?: string }
    send_input?: { text?: string; attachment_ids?: string[] }
    stop_active?: { expected_activity_revision?: string }
    decide_approval?: { approval_id?: string; revision?: string; decision?: string }
    create_session?: { agent_preset?: string; workspace_id?: string; new_workspace_name?: string }
    select_agent_preset?: { agent_preset?: string }
    select_model?: { provider?: string; model?: string; reasoning_effort?: string }
    fork_session?: { child_session_id?: string; at_seq?: string }
    revoke_approval_rule?: { rule_id?: string }
    set_session_budget?: { max_total_tokens?: string }
  }
  control_request?: {
    request_id?: string
    session_id?: string
    acquire?: Record<string, never>
    renew?: { control?: { epoch?: string; token?: string } }
    release?: { control?: { epoch?: string; token?: string } }
  }
  // Blob logical channel (S-blob, ADR-005): optional fields decode as null,
  // uint64 as string, enum as its proto name, bytes as Buffer.
  blob_begin?: {
    transfer_id?: string
    sha256_hex?: string
    total_bytes?: string
    media_type?: string | null
  }
  blob_chunk?: { transfer_id?: string; offset?: string; data?: Buffer }
  blob_control?: { transfer_id?: string; action?: string }
  blob_fetch?: {
    fetch_id?: string
    open?: { attachment_id?: string; artifact_id?: string; session_id?: string } | null
    chunk_offset?: string
  }
  heartbeat?: { nonce?: string }
}

type ServerFrame = Record<string, unknown>
type ConnectCall = grpc.ServerDuplexStream<ClientFrame, ServerFrame>

interface RemoteCall {
  write(message: ServerFrame): boolean
  end(): void
  destroy(error?: Error): void
  on(event: 'data', listener: (message: ClientFrame) => void): unknown
  on(event: 'end', listener: () => void): unknown
  once(event: 'cancelled' | 'close', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

interface PairingClientFrame {
  hello?: {
    protocol_version?: number
    invitation_id?: Buffer
    host_public_key?: Buffer
    device_name?: string
  }
  handshake_message?: Buffer
}

type PairingServerFrame = Record<string, unknown>
type PairingCall = grpc.ServerDuplexStream<PairingClientFrame, PairingServerFrame>

interface RemoteServiceDescriptor {
  service: grpc.ServiceDefinition
}

interface ConnectionState {
  readonly connectionId: string
  readonly call: RemoteCall
  readonly deviceId: Buffer
  readonly grantedCapabilities: string
  readonly domain: Omit<ProjectionCursorDomain, 'sessionId' | 'projectionVersion'>
  delivery: ProjectionDelivery
  helloComplete: boolean
  subscribed: boolean
  closed: boolean
  sessionId?: string
  streamId?: string
  incoming: Promise<void>
  setupAbort?: AbortController
  generation?: RetainedProjectionGeneration
}

interface PairingConnectionState {
  readonly call: PairingCall
  incoming: Promise<void>
  phase: 'awaiting-hello' | 'handshaking' | 'awaiting-confirmation' | 'closed'
  invitationId?: Buffer
  deviceName?: string
  handshake?: RemoteConnectionHandshake
  transport?: RemoteSecureTransport
}

class AsyncFrameQueue {
  readonly #frames: RemoteReadFrame[] = []
  readonly #waiters: Array<(value: IteratorResult<RemoteReadFrame>) => void> = []
  #closed = false

  push(frame: RemoteReadFrame): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) waiter({ done: false, value: frame })
    else this.#frames.push(frame)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  async next(): Promise<IteratorResult<RemoteReadFrame>> {
    const frame = this.#frames.shift()
    if (frame !== undefined) return { done: false, value: frame }
    if (this.#closed) return { done: true, value: undefined }
    return await new Promise(resolve => this.#waiters.push(resolve))
  }
}

function resolveProtocolDescriptor(): string {
  for (const spec of [
    new URL('../protocol/v1alpha/dsh_remote_v1alpha.proto', import.meta.url),
    new URL('../../protocol/v1alpha/dsh_remote_v1alpha.proto', import.meta.url),
  ]) {
    const pathname = fileURLToPath(spec)
    if (existsSync(pathname)) return pathname
  }
  throw new Error('DSH Remote protocol descriptor is missing from the installed package')
}

function remoteService(): RemoteServiceDescriptor {
  const protoPath = resolveProtocolDescriptor()
  const definition = protoLoader.loadSync(protoPath, {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  })
  const descriptor = grpc.loadPackageDefinition(definition) as unknown as {
    dsh: { remote: { v1alpha: { RemoteTransport: RemoteServiceDescriptor } } }
  }
  return descriptor.dsh.remote.v1alpha.RemoteTransport
}

function serverFrame(payload: Record<string, unknown>): ServerFrame {
  return { frame_id: randomUUID(), ...payload }
}

const uint64Pattern = /^(0|[1-9]\d*)$/
const controlTokenPattern = /^[A-Za-z0-9_-]{43}$/
const remoteIdentifierPattern = /^[\x21-\x7e]{1,128}$/
const UINT64_MAX = 18_446_744_073_709_551_615n

function validSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const length = Array.from(value).length
  return length >= 1 && length <= 256
}

function controlFailure(reason: RemoteControlFailure): { code: string; detail: string } {
  return {
    'held-by-other': {
      code: 'ERROR_CODE_CONTROL_HELD_BY_OTHER', detail: 'Session control is held by another device',
    },
    unheld: { code: 'ERROR_CODE_CONTROL_UNHELD', detail: 'Session control is not currently held' },
    expired: { code: 'ERROR_CODE_CONTROL_EXPIRED', detail: 'Session control lease expired' },
    'stale-fence': { code: 'ERROR_CODE_CONTROL_STALE_FENCE', detail: 'Session control fence is stale' },
  }[reason]
}

function commandError(
  terminal: Extract<RemoteCommandTerminal, { outcome: 'rejected' | 'unknown' }>,
): { code: string; detail: string } {
  if (terminal.outcome === 'unknown') {
    return {
      code: 'ERROR_CODE_COMMAND_OUTCOME_UNKNOWN',
      detail: 'The Host cannot currently prove the command outcome; retry with the same command_id',
    }
  }
  return {
    'command-id-reused': {
      code: 'ERROR_CODE_COMMAND_ID_REUSED', detail: 'command_id was already bound to different semantics',
    },
    'authorization-denied': {
      code: 'ERROR_CODE_AUTHORIZATION_DENIED', detail: 'The authenticated device is not authorized for this command',
    },
    'control-held-by-other': controlFailure('held-by-other'),
    'control-unheld': controlFailure('unheld'),
    'control-expired': controlFailure('expired'),
    'control-stale-fence': controlFailure('stale-fence'),
    'session-not-found': {
      code: 'ERROR_CODE_SESSION_NOT_FOUND', detail: 'The requested Session is unavailable',
    },
    'invalid-control-proof': {
      code: 'ERROR_CODE_INVALID_REQUEST', detail: 'The command control proof is invalid',
    },
    'approval-revision-stale': {
      code: 'ERROR_CODE_APPROVAL_REVISION_STALE', detail: 'The approval revision is stale',
    },
    'approval-not-pending': {
      code: 'ERROR_CODE_APPROVAL_NOT_PENDING', detail: 'The approval is no longer pending',
    },
    'approval-outcome-not-allowed': {
      code: 'ERROR_CODE_APPROVAL_OUTCOME_NOT_ALLOWED', detail: 'The requested approval outcome is not allowed',
    },
    'approval-already-settled': {
      code: 'ERROR_CODE_APPROVAL_REVISION_STALE', detail: 'The approval already settled with another outcome',
    },
    'agent-preset-not-found': {
      code: 'ERROR_CODE_AGENT_PRESET_NOT_FOUND', detail: 'The named agent preset is not in the deployment roster',
    },
    'agent-preset-locked': {
      code: 'ERROR_CODE_AGENT_PRESET_LOCKED', detail: 'The Session already started; its agent preset is fixed',
    },
    'agent-preset-invalid': {
      code: 'ERROR_CODE_AGENT_PRESET_INVALID', detail: 'The named agent preset cannot compose a Session',
    },
    'model-unavailable': {
      code: 'ERROR_CODE_MODEL_UNAVAILABLE', detail: 'The provider, model, or reasoning effort cannot serve this Session',
    },
    'fork-unavailable': {
      code: 'ERROR_CODE_FORK_UNAVAILABLE', detail: 'The Session has no completed turn at the requested fork anchor',
    },
    'session-conflict': {
      code: 'ERROR_CODE_SESSION_CONFLICT', detail: 'The preallocated session_id is bound to different semantics',
    },
    'fork-conflict': {
      code: 'ERROR_CODE_SESSION_CONFLICT', detail: 'The preallocated child_session_id is bound to different lineage',
    },
    'attachment-error': {
      code: 'ERROR_CODE_ATTACHMENT_UNAVAILABLE',
      detail: 'An attached image is unknown, not yet committed, or not an accepted image',
    },
    'budget-exhausted': {
      code: 'ERROR_CODE_BUDGET_EXHAUSTED',
      detail: 'The session token budget is exhausted; raise the ceiling to continue',
    },
    'workspace-not-found': {
      code: 'ERROR_CODE_WORKSPACE_NOT_FOUND',
      detail: 'The named workspace is not in the Host registry',
    },
    'workspace-invalid-name': {
      code: 'ERROR_CODE_WORKSPACE_INVALID_NAME',
      detail: 'new_workspace_name must be a single folder name under an existing workspace',
    },
    'workspace-create-failed': {
      code: 'ERROR_CODE_WORKSPACE_CREATE_FAILED',
      detail: 'The Host could not create or register the child workspace folder',
    },
    'workspace-invalid-path': {
      code: 'ERROR_CODE_WORKSPACE_CREATE_FAILED',
      detail: 'The Host could not create or register the child workspace folder',
    },
    'rule-not-found': {
      code: 'ERROR_CODE_INVALID_REQUEST', detail: 'The named approval rule is not active',
    },
    'approval-class-underivable': {
      code: 'ERROR_CODE_APPROVAL_OUTCOME_NOT_ALLOWED',
      detail: 'No honest rule class is derivable for this approval',
    },
    'approval-rule-limit': {
      code: 'ERROR_CODE_APPROVAL_OUTCOME_NOT_ALLOWED',
      detail: 'The session already holds the maximum number of active approval rules',
    },
    'approval-policy-unavailable': {
      code: 'ERROR_CODE_COMMAND_UNAVAILABLE', detail: 'The approval policy owner is not composed in this Host',
    },
    'budget-meter-unavailable': {
      code: 'ERROR_CODE_COMMAND_UNAVAILABLE', detail: 'No usage meter is composed; a session budget cannot bind',
    },
    'invalid-budget': {
      code: 'ERROR_CODE_INVALID_REQUEST', detail: 'The session budget must be a positive integer ceiling',
    },
  }[terminal.errorCode] ?? {
    code: 'ERROR_CODE_COMMAND_UNAVAILABLE', detail: 'The command owner rejected this request before execution',
  }
}

/** Map an assembler failure onto the proto transfer vocabulary (S-blob). */
function blobTransferErrorWire(error: BlobTransferError): Record<string, unknown> {
  const code = {
    'invalid-declaration': 'BLOB_TRANSFER_ERROR_INVALID_DECLARATION',
    'declaration-conflict': 'BLOB_TRANSFER_ERROR_DECLARATION_CONFLICT',
    'unknown-transfer': 'BLOB_TRANSFER_ERROR_UNKNOWN_TRANSFER',
    'too-many-transfers': 'BLOB_TRANSFER_ERROR_TOO_MANY_TRANSFERS',
    'chunk-too-large': 'BLOB_TRANSFER_ERROR_CHUNK_TOO_LARGE',
    'offset-mismatch': 'BLOB_TRANSFER_ERROR_OFFSET_MISMATCH',
    'size-mismatch': 'BLOB_TRANSFER_ERROR_SIZE_MISMATCH',
    'digest-mismatch': 'BLOB_TRANSFER_ERROR_DIGEST_MISMATCH',
    'commit-rejected': 'BLOB_TRANSFER_ERROR_COMMIT_REJECTED',
  } satisfies Record<BlobTransferFailureCode, string>
  return {
    code: code[error.code],
    detail: error.message,
    ...(error.resumeOffset === undefined ? {} : { resume_offset: String(error.resumeOffset) }),
  }
}

/** Map a fetch-server failure onto the proto fetch vocabulary (S-blob). */
function blobFetchErrorWire(error: BlobFetchError): { code: string; detail: string } {
  const code = {
    'invalid-request': 'BLOB_FETCH_ERROR_INVALID_REQUEST',
    'fetch-conflict': 'BLOB_FETCH_ERROR_CONFLICT',
    'too-many-fetches': 'BLOB_FETCH_ERROR_TOO_MANY_FETCHES',
    'unknown-fetch': 'BLOB_FETCH_ERROR_UNKNOWN_FETCH',
    'unauthorized': 'BLOB_FETCH_ERROR_UNAUTHORIZED',
    'content-too-large': 'BLOB_FETCH_ERROR_CONTENT_TOO_LARGE',
    'offset-out-of-range': 'BLOB_FETCH_ERROR_OFFSET_OUT_OF_RANGE',
    'source-changed': 'BLOB_FETCH_ERROR_SOURCE_CHANGED',
  } satisfies Record<BlobFetchFailureCode, string>
  return { code: code[error.code], detail: error.message }
}

function stopError(
  terminal: Extract<RemoteStopTerminal, { outcome: 'rejected' | 'unknown' }>,
): { code: string; detail: string } {
  if (terminal.outcome === 'unknown') {
    return {
      code: 'ERROR_CODE_STOP_SETTLEMENT_UNKNOWN',
      detail: 'The Host cannot prove Stop settlement; reconcile with the same command_id',
    }
  }
  return {
    'command-id-reused': {
      code: 'ERROR_CODE_COMMAND_ID_REUSED', detail: 'command_id was already bound to different semantics',
    },
    'authorization-denied': {
      code: 'ERROR_CODE_AUTHORIZATION_DENIED', detail: 'The authenticated device is not authorized to Stop',
    },
    'control-held-by-other': controlFailure('held-by-other'),
    'control-unheld': controlFailure('unheld'),
    'control-expired': controlFailure('expired'),
    'control-stale-fence': controlFailure('stale-fence'),
    'session-not-found': {
      code: 'ERROR_CODE_SESSION_NOT_FOUND', detail: 'The requested Session is unavailable',
    },
    'activity-revision-stale': {
      code: 'ERROR_CODE_ACTIVITY_REVISION_STALE', detail: 'The requested activity is no longer the active turn',
    },
    'invalid-control-proof': {
      code: 'ERROR_CODE_INVALID_REQUEST', detail: 'The Stop control proof is invalid',
    },
  }[terminal.errorCode] ?? {
    code: 'ERROR_CODE_COMMAND_UNAVAILABLE', detail: 'The Stop owner rejected this request before execution',
  }
}

/** One private carrier instance; lifecycle is owned by the plugin effect. */
export class RemoteGrpcCarrier {
  readonly #server = new grpc.Server({ 'grpc.max_receive_message_length': MAX_SECURE_ENVELOPE_BYTES })
  readonly #connections = new Set<ConnectionState>()
  readonly #secureChannel: SecureChannelServer<ClientFrame, ServerFrame>
  readonly #pairingConnections = new Set<PairingConnectionState>()
  readonly #tasks = new Set<Promise<void>>()
  readonly #cursors: RetainedProjectionCursorStore
  #disposed = false

  constructor(
    private readonly source: RemoteProjectionReadPort,
    private readonly options: {
      host?: string
      port: number
      maxHistoryMessages: number
      maxToolContentChars: number
      resumeRetentionTtlMs: number
      maxRetainedEvents: number
      maxRetainedJsonBytes: number
      maxRetainedGenerations: number
      hostInstanceId: string
      /**
       * Operator-facing Host name carried in every hello (config
       * lanDisplayName, else the machine hostname). Stable across restarts,
       * unlike the per-boot hostInstanceId.
       */
      hostDisplayName: string
      security: RemoteSecurityOwner
      control?: () => RemoteControlService | undefined
      commands?: () => RemoteCommandService | undefined
      /**
       * Approval-policy owner face (S-policy): the budget `exhausted` flag
       * asserted on snapshots and policy_changed frames is the owner's
       * admission decision, never a client-side derivation. Absent, budgets
       * cross without an exhaustion claim.
       */
      policy?: () => HostApprovalPolicy | undefined
      /**
       * Host-owned artifact registry (S-artifacts). Absent, the hello roster
       * is empty and no live registration is projected — absence is honest,
       * never a claim that no file was produced.
       */
      artifacts?: ArtifactRegistry
      /**
       * Blob logical channel owners (S-blob, ADR-005). Absent entirely, the
       * hello carries no attachment_limits and every blob frame is refused
       * with a transfer/fetch-scoped error. `assembler` absent alone means
       * this composition accepts no uploads while fetches still serve;
       * `attachmentLimits` is the deployment intake bound advertised in hello.
       */
      blobs?: {
        assembler?: BlobTransferAssembler
        fetch: BlobFetchServer
        attachmentLimits?: ImageAttachmentLimits
      }
    },
  ) {
    this.#cursors = new RetainedProjectionCursorStore({
      maxEvents: options.maxRetainedEvents,
      maxJsonBytes: options.maxRetainedJsonBytes,
      detachedTtlMs: options.resumeRetentionTtlMs,
      maxGenerations: options.maxRetainedGenerations,
    })
    const descriptor = remoteService()
    const connectMethod = descriptor.service.Connect as grpc.MethodDefinition<ClientFrame, ServerFrame>
    const pairMethod = descriptor.service.Pair as grpc.MethodDefinition<PairingClientFrame, PairingServerFrame>
    this.#secureChannel = new SecureChannelServer<ClientFrame, ServerFrame>({
      security: () => this.options.security,
      admissionCapabilities: REMOTE_READ_CAPABILITIES,
      deserializeClient: bytes => connectMethod.requestDeserialize(bytes),
      serializeServer: frame => Buffer.from(connectMethod.responseSerialize(frame)),
      onAuthenticated: (session) => {
        this.#connect(
          session.call,
          session.devicePublicKey,
          session.deviceId,
          session.grantedCapabilities,
          session.authorityEpoch,
        )
      },
    })
    this.#server.addService(descriptor.service, {
      Connect: (call: ConnectCall) => {
        const error = new Error('paired device authentication required') as grpc.ServiceError
        error.code = grpc.status.UNAUTHENTICATED
        error.details = error.message
        error.metadata = new grpc.Metadata()
        call.emit('error', error)
      },
      SecureConnect: (call: SecureChannelCall) => {
        if (this.#disposed) {
          call.destroy(new Error('remote carrier disposed'))
          return
        }
        this.#secureChannel.accept(call)
      },
      Pair: (call: PairingCall) => {
        this.#pair(call, frame => Buffer.from(pairMethod.responseSerialize(frame)))
      },
    })
  }

  /**
   * Bind the insecure gRPC listener beneath the authenticated Noise carrier.
   * @returns The actual bound port.
   */
  async start(): Promise<number> {
    if (this.#disposed) throw new Error('remote carrier is disposed')
    return await new Promise<number>((resolve, reject) => {
      this.#server.bindAsync(
        `${this.options.host ?? LOOPBACK_HOST}:${this.options.port}`,
        grpc.ServerCredentials.createInsecure(),
        (error, port) => {
          if (error === null) resolve(port)
          else reject(error)
        },
      )
    })
  }

  /** Terminate authenticated streams whose durable authority no longer matches their connection epoch. */
  fenceAuthorizationChanges(): void {
    this.#secureChannel.fenceAll()
    this.#cursors.fenceAuthorization((domain) => {
      const current = this.options.security.authorizeCapabilities(
        Buffer.from(domain.devicePublicKey, 'hex'),
        REMOTE_READ_CAPABILITIES,
      )
      return current.decision === 'allowed' && current.authorityEpoch === domain.authorityEpoch
    })
  }

  /** End active streams, await carrier tasks, and release the listener. */
  async stop(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#cursors.stop()
    for (const state of [...this.#connections]) {
      state.setupAbort?.abort()
      state.call.end()
    }
    // Ends every live secure call synchronously; the returned settlement is
    // awaited below alongside the plain and pairing streams.
    const secureStopped = this.#secureChannel.stop()
    for (const state of [...this.#pairingConnections]) {
      if (state.phase === 'awaiting-confirmation' && state.invitationId !== undefined) {
        this.options.security.rejectPairing(state.invitationId)
      }
      state.phase = 'closed'
      state.call.end()
    }
    await Promise.allSettled([
      ...this.#tasks,
      ...[...this.#connections].map(state => state.incoming),
      secureStopped,
      ...[...this.#pairingConnections].map(state => state.incoming),
    ])
    await new Promise<void>((resolve) => {
      this.#server.tryShutdown(() => {
        resolve()
      })
    })
    this.#connections.clear()
    this.#pairingConnections.clear()
  }

  #track(task: Promise<void>): Promise<void> {
    this.#tasks.add(task)
    void task.finally(() => {
      this.#tasks.delete(task)
    })
    return task
  }

  #pair(call: PairingCall, serializeServer: (frame: PairingServerFrame) => Buffer): void {
    if (this.#disposed) {
      call.destroy(new Error('remote carrier disposed'))
      return
    }
    const state: PairingConnectionState = {
      call,
      incoming: Promise.resolve(),
      phase: 'awaiting-hello',
    }
    this.#pairingConnections.add(state)
    const dispose = (): void => {
      if (state.phase === 'awaiting-confirmation' && state.invitationId !== undefined) {
        this.options.security.rejectPairing(state.invitationId)
      }
      state.phase = 'closed'
      this.#pairingConnections.delete(state)
    }
    call.once('cancelled', dispose)
    call.once('close', dispose)
    call.once('error', dispose)
    call.on('end', () => {
      dispose()
      call.end()
    })
    call.on('data', (message: PairingClientFrame) => {
      state.incoming = state.incoming
        .then(() => { this.#onPairingFrame(state, message, serializeServer) })
        .catch(() => {
          this.#writePairingError(state, 'SECURE_ERROR_CODE_CRYPTOGRAPHIC_FAILURE', 'pairing failed closed')
          state.phase = 'closed'
          state.call.end()
        })
    })
  }

  #onPairingFrame(
    state: PairingConnectionState,
    message: PairingClientFrame,
    serializeServer: (frame: PairingServerFrame) => Buffer,
  ): void {
    if (state.phase === 'closed') return
    if (message.hello !== undefined) {
      if (state.phase !== 'awaiting-hello') {
        this.#writePairingError(state, 'SECURE_ERROR_CODE_INVALID_REQUEST', 'pairing hello already received')
        return
      }
      const { protocol_version: version, invitation_id: invitationId, host_public_key: hostKey } = message.hello
      const deviceName = message.hello.device_name?.trim()
      if (version !== PROTOCOL_VERSION) {
        this.#writePairingError(state, 'SECURE_ERROR_CODE_INCOMPATIBLE_VERSION', `expected protocol ${PROTOCOL_VERSION}`)
        state.call.end()
        return
      }
      if (!Buffer.isBuffer(invitationId) || !Buffer.isBuffer(hostKey) || deviceName === undefined) {
        this.#writePairingError(state, 'SECURE_ERROR_CODE_INVALID_REQUEST', 'pairing hello fields required')
        return
      }
      state.handshake = this.options.security.pairingResponder(
        Buffer.from(invitationId),
        Buffer.from(hostKey),
        Date.now(),
      )
      state.invitationId = Buffer.from(invitationId)
      state.deviceName = deviceName
      state.phase = 'handshaking'
      return
    }

    if (message.handshake_message !== undefined) {
      if (state.phase !== 'handshaking' || state.handshake === undefined
        || state.invitationId === undefined || state.deviceName === undefined) {
        this.#writePairingError(state, 'SECURE_ERROR_CODE_INVALID_REQUEST', 'pairing hello required')
        return
      }
      if (message.handshake_message.length > MAX_NOISE_MESSAGE_BYTES) {
        throw new Error('pairing handshake message exceeds the Noise bound')
      }
      const payload = state.handshake.read(Buffer.from(message.handshake_message))
      if (payload.length !== 0) throw new Error('pairing handshake payload is not allowed')
      if (!state.handshake.finished()) {
        const response = state.handshake.write(Buffer.alloc(0))
        state.call.write(serverFrame({ handshake_message: response }))
        return
      }

      const verificationCode = state.handshake.verificationCode()
      const devicePublicKey = state.handshake.peerPublicKey()
      const transport = state.handshake.finishTransport()
      state.transport = transport
      delete state.handshake
      state.phase = 'awaiting-confirmation'
      const decision = this.options.security.stagePairing(
        state.invitationId,
        devicePublicKey,
        state.deviceName,
        verificationCode,
        Date.now(),
      )
      this.#writePairingStatus(state, serializeServer, 'STATE_AWAITING_HOST_CONFIRMATION', verificationCode)
      void this.#track(decision.then((result) => {
        if (state.phase !== 'awaiting-confirmation') return
        this.#writePairingStatus(
          state,
          serializeServer,
          result === 'confirmed' ? 'STATE_CONFIRMED' : 'STATE_REJECTED',
          verificationCode,
        )
        state.phase = 'closed'
        state.call.end()
      }))
      return
    }

    this.#writePairingError(state, 'SECURE_ERROR_CODE_INVALID_REQUEST', 'unknown pairing frame')
  }

  #writePairingStatus(
    state: PairingConnectionState,
    serializeServer: (frame: PairingServerFrame) => Buffer,
    pairingState: string,
    verificationCode: string,
  ): void {
    const transport = state.transport
    if (transport === undefined) throw new Error('pairing transport is unavailable')
    const plaintext = serializeServer(serverFrame({
      status: { state: pairingState, verification_code: verificationCode },
    }))
    if (plaintext.length > MAX_NOISE_PLAINTEXT_BYTES) throw new Error('pairing status exceeds Noise bound')
    state.call.write(serverFrame({ ciphertext: transport.encrypt(plaintext) }))
  }

  #writePairingError(state: PairingConnectionState, code: string, detail: string): void {
    if (state.phase === 'closed') return
    state.call.write(serverFrame({ error: { code, detail } }))
  }

  #connect(
    call: RemoteCall,
    devicePublicKey: Buffer,
    deviceId: Buffer,
    grantedCapabilities: string,
    authorityEpoch: string,
  ): void {
    if (this.#disposed) {
      call.destroy(new Error('remote carrier disposed'))
      return
    }
    const stateRef: { current: ConnectionState | undefined } = { current: undefined }
    const currentState = (): ConnectionState => {
      if (stateRef.current === undefined) throw new Error('Remote connection delivery is not initialized')
      return stateRef.current
    }
    const delivery: ProjectionDelivery = {
      active: () => !currentState().closed,
      write: frame => currentState().call.write(serverFrame(frame)),
      backpressure: () => {
        const error = new Error('Remote client exceeded the delivery backpressure bound') as grpc.ServiceError
        error.code = grpc.status.RESOURCE_EXHAUSTED
        error.details = error.message
        error.metadata = new grpc.Metadata()
        currentState().call.destroy(error)
      },
    }
    const state: ConnectionState = {
      connectionId: randomUUID(),
      call,
      deviceId: Buffer.from(deviceId),
      grantedCapabilities,
      domain: { devicePublicKey: devicePublicKey.toString('hex'), authorityEpoch },
      delivery,
      helloComplete: false,
      subscribed: false,
      closed: false,
      incoming: Promise.resolve(),
    }
    stateRef.current = state
    this.#connections.add(state)
    const dispose = (): void => {
      if (state.closed) return
      state.closed = true
      state.setupAbort?.abort()
      if (state.generation !== undefined) void state.generation.detach(state.delivery)
      this.#connections.delete(state)
    }
    call.once('cancelled', dispose)
    call.once('close', dispose)
    call.once('error', dispose)
    call.on('end', () => {
      dispose()
      call.end()
    })
    call.on('data', (message: ClientFrame) => {
      state.incoming = state.incoming
        .then(() => this.#onClientFrame(state, message))
        .catch((cause: unknown) => {
          this.#writeError(state, 'ERROR_CODE_INVALID_REQUEST', cause instanceof Error ? cause.message : String(cause))
        })
    })
  }

  async #onClientFrame(state: ConnectionState, message: ClientFrame): Promise<void> {
    if (message.hello !== undefined) {
      if (message.hello.protocol_version !== PROTOCOL_VERSION) {
        this.#writeError(state, 'ERROR_CODE_INCOMPATIBLE_VERSION', `expected protocol ${PROTOCOL_VERSION}`)
        state.call.end()
        return
      }
      const [sessions, presets, catalog, artifacts, workspaces] = await Promise.all([
        this.source.list(), this.source.presets(), this.source.modelCatalog(),
        this.options.artifacts === undefined ? Promise.resolve([]) : this.options.artifacts.roster(),
        this.source.workspaces(),
      ])
      state.helloComplete = true
      state.call.write(serverFrame({
        hello: {
          protocol_version: PROTOCOL_VERSION,
          connection_id: state.connectionId,
          host_instance_id: this.options.hostInstanceId,
          host_display_name: this.options.hostDisplayName,
          granted_capabilities: state.grantedCapabilities,
          sessions: sessions.map(session => ({
            session_id: session.sessionId,
            title: session.title ?? '',
            running: session.running,
            updated_at_ms: String(session.updatedAt),
            workspace_label: session.workspaceLabel ?? '',
            pending_approval_count: session.pendingApprovalCount,
            pending_input_count: session.pendingInputCount,
            ...(sessionUsageWire(session.usage) === undefined
              ? {}
              : { usage: sessionUsageWire(session.usage) }),
            ...(session.parentSessionId === undefined ? {} : { parent_session_id: session.parentSessionId }),
            ...(session.origin === undefined ? {} : { origin: session.origin }),
            ...(subagentViewWire(session.subagent) === undefined
              ? {}
              : { subagent: subagentViewWire(session.subagent) }),
            ...(session.agentPreset === undefined ? {} : { agent_preset: session.agentPreset }),
            ...(modelSelectionWire(session.model) === undefined
              ? {}
              : { model: modelSelectionWire(session.model) }),
            ...(session.projectLabel === undefined ? {} : { project_label: session.projectLabel }),
          })),
          agent_presets: presets.map(preset => ({
            id: preset.id,
            trust: preset.trust === 'user' ? 'TRUST_USER' : 'TRUST_SYSTEM',
            is_default: preset.isDefault,
            ...(preset.name === undefined ? {} : { name: preset.name }),
            ...(preset.description === undefined ? {} : { description: preset.description }),
            ...(preset.broken === undefined ? {} : { broken: preset.broken }),
          })),
          model_catalog: catalog.groups.map(group => ({
            id: group.id,
            ...(group.name === undefined ? {} : { name: group.name }),
            models: group.models.map(entry => ({
              id: entry.id,
              ...(entry.name === undefined ? {} : { name: entry.name }),
              reasoning_efforts: entry.reasoningEfforts,
              ...(entry.defaultReasoningEffort === undefined
                ? {}
                : { default_reasoning_effort: entry.defaultReasoningEffort }),
              ...(entry.inputModalities === undefined ? {} : { input_modalities: entry.inputModalities }),
            })),
          })),
          model_catalog_failures: catalog.failures.map(failure => ({
            provider_id: failure.providerId,
            ...(failure.detail === undefined ? {} : { detail: failure.detail }),
          })),
          artifacts,
          // Absent limits are the honest "no image intake" signal: the
          // composer affordance keys off this field's presence.
          ...(this.options.blobs?.attachmentLimits === undefined ? {} : {
            attachment_limits: {
              max_image_bytes: String(this.options.blobs.attachmentLimits.maxImageBytes),
              max_images_per_message: this.options.blobs.attachmentLimits.maxImagesPerMessage,
              media_types: [...this.options.blobs.attachmentLimits.mediaTypes],
            },
          }),
          workspaces: workspaces.map(workspace => ({
            workspace_id: workspace.workspaceId,
            label: workspace.label,
          })),
        },
      }))
      return
    }
    if (!state.helloComplete) {
      this.#writeError(state, 'ERROR_CODE_INVALID_REQUEST', 'hello required')
      return
    }
    if (message.subscribe !== undefined) {
      await this.#subscribe(state, message.subscribe)
    } else if (message.ack !== undefined) {
      this.#ack(state, message.ack)
    } else if (message.command !== undefined) {
      void this.#track(this.#command(state, message.command))
    } else if (message.control_request !== undefined) {
      await this.#control(state, message.control_request)
    } else if (message.blob_begin !== undefined) {
      await this.#blobBegin(state, message.blob_begin)
    } else if (message.blob_chunk !== undefined) {
      await this.#blobChunk(state, message.blob_chunk)
    } else if (message.blob_control !== undefined) {
      await this.#blobControl(state, message.blob_control)
    } else if (message.blob_fetch !== undefined) {
      await this.#blobFetch(state, message.blob_fetch)
    } else if (message.heartbeat !== undefined) {
      const nonce = message.heartbeat.nonce
      if (typeof nonce !== 'string' || !remoteIdentifierPattern.test(nonce)) {
        this.#writeError(state, 'ERROR_CODE_INVALID_REQUEST', 'heartbeat nonce required')
        return
      }
      state.call.write(serverFrame({ heartbeat_ack: { nonce } }))
    } else {
      this.#writeError(state, 'ERROR_CODE_INVALID_REQUEST', 'unknown client frame')
    }
  }

  /** Upload fence: session-input capability, transfer-scoped on denial (S-blob). */
  #blobUploadAuthorized(state: ConnectionState): boolean {
    try {
      this.#requireAuthorization(state, REMOTE_SEND_CONTROL_CAPABILITIES)
      return true
    } catch {
      return false
    }
  }

  #writeBlobTransferResult(state: ConnectionState, result: Record<string, unknown>): void {
    state.call.write(serverFrame({ blob_transfer_result: result }))
  }

  /** Refuse one upload frame with a transfer-scoped error; the carrier lives on. */
  #blobTransferRefusal(state: ConnectionState, transferId: string | undefined, code: string, detail: string): void {
    this.#writeBlobTransferResult(state, {
      transfer_id: typeof transferId === 'string' ? transferId : '',
      received_bytes: '0',
      error: { code, detail },
    })
  }

  /** Refuse one fetch frame with a fetch-scoped error; the carrier lives on. */
  #blobFetchRefusal(state: ConnectionState, fetchId: string | undefined, code: string, detail: string): void {
    state.call.write(serverFrame({
      blob_fetch_result: {
        fetch_id: typeof fetchId === 'string' ? fetchId : '',
        error: { code, detail },
      },
    }))
  }

  async #blobBegin(state: ConnectionState, begin: NonNullable<ClientFrame['blob_begin']>): Promise<void> {
    const transferId = begin.transfer_id
    if (!this.#blobUploadAuthorized(state)) {
      this.#blobTransferRefusal(state, transferId, 'BLOB_TRANSFER_ERROR_UNAUTHORIZED',
        'The authenticated device is not authorized to send session input')
      return
    }
    const assembler = this.options.blobs?.assembler
    if (assembler === undefined) {
      this.#blobTransferRefusal(state, transferId, 'BLOB_TRANSFER_ERROR_COMMIT_REJECTED',
        'blob uploads are not enabled in this Host composition')
      return
    }
    const mediaType = begin.media_type === null ? undefined : begin.media_type
    const totalText = begin.total_bytes
    const totalBytes = typeof totalText === 'string' && uint64Pattern.test(totalText)
      && BigInt(totalText) >= 1n && BigInt(totalText) <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(totalText)
      : undefined
    if (typeof transferId !== 'string' || !BLOB_TRANSFER_ID_PATTERN.test(transferId)
      || typeof begin.sha256_hex !== 'string' || !BLOB_SHA256_PATTERN.test(begin.sha256_hex)
      || totalBytes === undefined
      || (mediaType !== undefined && !remoteIdentifierPattern.test(mediaType))) {
      this.#blobTransferRefusal(state, transferId, 'BLOB_TRANSFER_ERROR_INVALID_DECLARATION',
        'transfer_id, sha256_hex, a positive canonical total_bytes, and an optional bounded media_type are required')
      return
    }
    try {
      const cursor = await assembler.begin({
        transferId,
        sha256Hex: begin.sha256_hex,
        totalBytes,
        ...(mediaType === undefined ? {} : { mediaType }),
      })
      this.#writeBlobTransferResult(state, {
        transfer_id: transferId,
        received_bytes: String(cursor.receivedBytes),
      })
    } catch (error: unknown) {
      if (!(error instanceof BlobTransferError)) throw error
      this.#writeBlobTransferResult(state, {
        transfer_id: transferId, received_bytes: '0', error: blobTransferErrorWire(error),
      })
    }
  }

  async #blobChunk(state: ConnectionState, chunk: NonNullable<ClientFrame['blob_chunk']>): Promise<void> {
    const transferId = chunk.transfer_id
    if (!this.#blobUploadAuthorized(state)) {
      this.#blobTransferRefusal(state, transferId, 'BLOB_TRANSFER_ERROR_UNAUTHORIZED',
        'The authenticated device is not authorized to send session input')
      return
    }
    const assembler = this.options.blobs?.assembler
    if (assembler === undefined) {
      this.#blobTransferRefusal(state, transferId, 'BLOB_TRANSFER_ERROR_COMMIT_REJECTED',
        'blob uploads are not enabled in this Host composition')
      return
    }
    const offsetText = chunk.offset
    const offset = typeof offsetText === 'string' && uint64Pattern.test(offsetText)
      && BigInt(offsetText) <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(offsetText)
      : undefined
    const data = chunk.data
    if (typeof transferId !== 'string' || !BLOB_TRANSFER_ID_PATTERN.test(transferId)
      || offset === undefined || data === undefined || data.length === 0) {
      this.#blobTransferRefusal(state, transferId, 'BLOB_TRANSFER_ERROR_INVALID_DECLARATION',
        'transfer_id, a canonical offset, and non-empty chunk data are required')
      return
    }
    try {
      const cursor = await assembler.chunk(transferId, offset, data)
      this.#writeBlobTransferResult(state, {
        transfer_id: transferId,
        received_bytes: String(cursor.receivedBytes),
      })
    } catch (error: unknown) {
      if (!(error instanceof BlobTransferError)) throw error
      this.#writeBlobTransferResult(state, {
        transfer_id: transferId, received_bytes: '0', error: blobTransferErrorWire(error),
      })
    }
  }

  async #blobControl(state: ConnectionState, control: NonNullable<ClientFrame['blob_control']>): Promise<void> {
    const transferId = control.transfer_id
    if (!this.#blobUploadAuthorized(state)) {
      this.#blobTransferRefusal(state, transferId, 'BLOB_TRANSFER_ERROR_UNAUTHORIZED',
        'The authenticated device is not authorized to send session input')
      return
    }
    const assembler = this.options.blobs?.assembler
    if (assembler === undefined) {
      this.#blobTransferRefusal(state, transferId, 'BLOB_TRANSFER_ERROR_COMMIT_REJECTED',
        'blob uploads are not enabled in this Host composition')
      return
    }
    if (typeof transferId !== 'string' || !BLOB_TRANSFER_ID_PATTERN.test(transferId)) {
      this.#blobTransferRefusal(state, transferId, 'BLOB_TRANSFER_ERROR_INVALID_DECLARATION',
        'a valid transfer_id is required')
      return
    }
    try {
      switch (control.action) {
        case 'BLOB_TRANSFER_ACTION_COMPLETE': {
          const committed = await assembler.complete(transferId)
          // Staging is dropped at commit; blob_id, not a cursor, marks success.
          this.#writeBlobTransferResult(state, {
            transfer_id: transferId, received_bytes: '0', blob_id: committed.blobId,
          })
          return
        }
        case 'BLOB_TRANSFER_ACTION_ABORT': {
          await assembler.abort(transferId)
          this.#writeBlobTransferResult(state, { transfer_id: transferId, received_bytes: '0' })
          return
        }
        case 'BLOB_TRANSFER_ACTION_STATUS': {
          const cursor = await assembler.status(transferId)
          if (cursor === undefined) {
            this.#writeBlobTransferResult(state, {
              transfer_id: transferId,
              received_bytes: '0',
              error: { code: 'BLOB_TRANSFER_ERROR_UNKNOWN_TRANSFER', detail: 'the transfer is unknown or already settled' },
            })
            return
          }
          this.#writeBlobTransferResult(state, {
            transfer_id: transferId, received_bytes: String(cursor.receivedBytes),
          })
          return
        }
        default:
          this.#blobTransferRefusal(state, transferId, 'BLOB_TRANSFER_ERROR_INVALID_DECLARATION',
            'a known blob control action is required')
      }
    } catch (error: unknown) {
      if (!(error instanceof BlobTransferError)) throw error
      this.#writeBlobTransferResult(state, {
        transfer_id: transferId, received_bytes: '0', error: blobTransferErrorWire(error),
      })
    }
  }

  async #blobFetch(state: ConnectionState, fetch: NonNullable<ClientFrame['blob_fetch']>): Promise<void> {
    const fetchId = fetch.fetch_id
    const server = this.options.blobs?.fetch
    if (server === undefined) {
      this.#blobFetchRefusal(state, fetchId, 'BLOB_FETCH_ERROR_INVALID_REQUEST',
        'blob fetches are not enabled in this Host composition')
      return
    }
    if (typeof fetchId !== 'string' || !BLOB_TRANSFER_ID_PATTERN.test(fetchId)) {
      this.#blobFetchRefusal(state, fetchId, 'BLOB_FETCH_ERROR_INVALID_REQUEST',
        'fetch_id must be client-minted lowercase hex')
      return
    }
    const open = fetch.open
    if (open !== undefined && open !== null) {
      const sessionId = open.session_id
      const attachmentId = open.attachment_id
      const artifactId = open.artifact_id
      const hasAttachment = typeof attachmentId === 'string' && attachmentId !== ''
      const hasArtifact = typeof artifactId === 'string' && artifactId !== ''
      if (typeof sessionId !== 'string' || !validSessionId(sessionId) || hasAttachment === hasArtifact) {
        this.#blobFetchRefusal(state, fetchId, 'BLOB_FETCH_ERROR_INVALID_REQUEST',
          'a valid session_id and exactly one fetch source are required')
        return
      }
      const source: BlobFetchSource = hasAttachment
        ? { kind: 'attachment', attachmentId, sessionId }
        : { kind: 'artifact', artifactId: artifactId as string, sessionId }
      try {
        const opened = await server.open({ fetchId, source })
        state.call.write(serverFrame({
          blob_fetch_result: {
            fetch_id: fetchId,
            opened: {
              total_bytes: String(opened.totalBytes),
              ...(opened.sha256Hex === undefined ? {} : { sha256_hex: opened.sha256Hex }),
              ...(opened.mediaType === undefined ? {} : { media_type: opened.mediaType }),
            },
          },
        }))
      } catch (error: unknown) {
        if (!(error instanceof BlobFetchError)) throw error
        const wire = blobFetchErrorWire(error)
        this.#blobFetchRefusal(state, fetchId, wire.code, wire.detail)
      }
      return
    }
    const offsetText = fetch.chunk_offset
    const offset = typeof offsetText === 'string' && uint64Pattern.test(offsetText)
      && BigInt(offsetText) <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(offsetText)
      : undefined
    if (offset === undefined) {
      this.#blobFetchRefusal(state, fetchId, 'BLOB_FETCH_ERROR_INVALID_REQUEST',
        'blob_fetch requires open or a canonical chunk_offset')
      return
    }
    try {
      const chunk = await server.chunk(fetchId, offset, BLOB_CHUNK_BYTES)
      state.call.write(serverFrame({
        blob_fetch_result: {
          fetch_id: fetchId,
          chunk: { offset: String(chunk.offset), data: Buffer.from(chunk.data), complete: chunk.complete },
        },
      }))
    } catch (error: unknown) {
      if (!(error instanceof BlobFetchError)) throw error
      const wire = blobFetchErrorWire(error)
      this.#blobFetchRefusal(state, fetchId, wire.code, wire.detail)
    }
  }

  /**
   * The policy owner's current budget admission decision (S-policy). `false`
   * covers every unevaluable case — no owner, no budget, no usage meter —
   * because an exhaustion claim without an evaluation would be dishonest.
   */
  #budgetExhausted(sessionId: string): boolean {
    try {
      return this.options.policy?.()?.evaluateBudget(sessionId as SessionId)?.exhausted === true
    } catch {
      return false
    }
  }

  async #subscribe(state: ConnectionState, subscription: NonNullable<ClientFrame['subscribe']>): Promise<void> {
    const sessionId = subscription.session_id
    if (typeof sessionId !== 'string' || sessionId === '') {
      this.#writeError(state, 'ERROR_CODE_INVALID_REQUEST', 'session_id required')
      return
    }
    if (subscription.resume !== undefined && subscription.force_fresh_snapshot !== true) {
      await this.#resume(state, sessionId, subscription.resume)
      return
    }

    state.setupAbort?.abort()
    delete state.setupAbort
    if (state.generation !== undefined) await state.generation.detach(state.delivery)
    delete state.generation
    const abort = new AbortController()
    state.setupAbort = abort
    state.subscribed = false
    state.sessionId = sessionId
    delete state.streamId

    const queue = new AsyncFrameQueue()
    const pump = this.#track((async () => {
      try {
        for await (const frame of this.source.watch(sessionId, abort.signal)) queue.push(frame)
      } finally {
        queue.close()
      }
    })())

    try {
      // The history cut doubles as the session lookup: unlike the directory
      // listing it resolves blank sessions too, so a freshly created session
      // is subscribable before its first turn.
      const history = await this.source.history(sessionId, this.options.maxHistoryMessages)
      const cwd = this.options.artifacts === undefined
        ? undefined
        : await this.source.sessionCwd(sessionId)
      const baseline = projectSnapshot({
        sessionId,
        running: history.running,
        ...(history.title === undefined ? {} : { title: history.title }),
        ...(history.usage === undefined ? {} : { usage: history.usage }),
        ...(history.subagent === undefined ? {} : { subagent: history.subagent }),
        ...(history.agentPreset === undefined ? {} : { agentPreset: history.agentPreset }),
        ...(history.model === undefined ? {} : { model: history.model }),
        ...(history.policy === undefined ? {} : { policy: history.policy }),
        budgetExhausted: this.#budgetExhausted(sessionId),
        entries: history.entries,
        historyTruncated: history.hasMore,
        sourceWatermark: history.sourceWatermark,
        projectionWatermark: history.projectionWatermark,
        maxToolContentChars: this.options.maxToolContentChars,
        approvals: history.approvals,
        pendingInputCount: history.pendingInputCount,
        ...(cwd === undefined ? {} : { cwd }),
      })
      if (state.closed) throw new Error('connection closed during subscription setup')
      const streamId = randomUUID()
      const generation = this.#cursors.create(
        streamId,
        {
          sessionId,
          ...state.domain,
          projectionVersion: PROJECTION_VERSION,
        },
        abort,
        state.delivery,
      )
      state.generation = generation
      state.streamId = streamId
      delete state.setupAbort
      if (!state.delivery.write({
        snapshot: {
          stream_id: streamId,
          projection_version: PROJECTION_VERSION,
          snapshot_end_sequence: '0',
          session: baseline.session,
        },
      })) {
        state.delivery.backpressure()
        await generation.detach(state.delivery)
        state.subscribed = false
        return
      }
      state.subscribed = true

      const live = this.#track(this.#drainLive(
        state, generation, queue, abort, baseline,
        cwd === undefined ? {} : { cwd },
      ))
      void live.catch((cause: unknown) => {
        if (abort.signal.aborted) return
        void generation.invalidate({
          error: {
            code: 'ERROR_CODE_INVALID_REQUEST',
            detail: cause instanceof Error ? cause.message : String(cause),
            retryable: true,
          },
        })
        if (state.generation === generation) state.subscribed = false
      })
    } catch (cause) {
      abort.abort()
      await pump
      if (cause instanceof RemoteReadError && cause.code === 'session-not-found') {
        this.#writeError(state, 'ERROR_CODE_SESSION_NOT_FOUND', cause.message)
      } else {
        this.#writeError(state, 'ERROR_CODE_INVALID_REQUEST', cause instanceof Error ? cause.message : String(cause), true)
      }
    }
  }

  async #resume(
    state: ConnectionState,
    sessionId: string,
    cursor: NonNullable<NonNullable<ClientFrame['subscribe']>['resume']>,
  ): Promise<void> {
    const streamId = cursor.stream_id
    const sequenceText = cursor.highest_contiguous_sequence
    if (typeof streamId !== 'string' || streamId === ''
      || typeof cursor.projection_version !== 'number'
      || typeof sequenceText !== 'string'
      || !/^(0|[1-9]\d*)$/.test(sequenceText)) {
      this.#writeError(state, 'ERROR_CODE_INVALID_REQUEST', 'complete resume cursor required')
      return
    }
    const highestContiguousSequence = BigInt(sequenceText)
    if (highestContiguousSequence > 18_446_744_073_709_551_615n) {
      this.#writeError(state, 'ERROR_CODE_INVALID_REQUEST', 'resume sequence exceeds uint64')
      return
    }
    const priorGeneration = state.generation
    if (priorGeneration !== undefined && priorGeneration.streamId !== streamId) {
      await priorGeneration.detach(state.delivery)
      if (state.generation === priorGeneration) {
        delete state.generation
        state.subscribed = false
      }
    }
    if (state.closed) return
    const result = await this.#cursors.resume(
      {
        sessionId,
        ...state.domain,
        projectionVersion: PROJECTION_VERSION,
      },
      {
        streamId,
        projectionVersion: cursor.projection_version,
        highestContiguousSequence,
      },
      state.delivery,
    )
    if (!result.accepted) {
      const detail = {
        'generation-unavailable': 'resume generation is unavailable in this Host process',
        'domain-changed': 'resume session, device authority, or projection changed',
        'cursor-ahead': 'resume cursor is ahead of the retained generation',
        'cursor-too-old': 'resume cursor fell behind retained events',
      }[result.reason]
      this.#writeError(state, 'ERROR_CODE_SNAPSHOT_REQUIRED', detail, true)
      return
    }
    if (!state.delivery.active()) {
      await result.generation.detach(state.delivery)
      return
    }
    state.setupAbort?.abort()
    delete state.setupAbort
    if (state.generation !== result.generation && state.generation !== undefined) {
      await state.generation.detach(state.delivery)
    }
    state.generation = result.generation
    state.sessionId = sessionId
    state.streamId = streamId
    state.subscribed = true
  }

  async #drainLive(
    state: ConnectionState,
    generation: RetainedProjectionGeneration,
    queue: AsyncFrameQueue,
    abort: AbortController,
    baseline: ReturnType<typeof projectSnapshot>,
    sessionFacts: { cwd?: string },
  ): Promise<void> {
    while (!abort.signal.aborted) {
      const next = await queue.next()
      if (next.done) return
      const frame = next.value
      if (frame.type === 'session/subscribed') continue
      if (frame.type === 'approval/requested' || frame.type === 'approval/resolved') {
        await generation.append(projectApprovalFrame(frame, this.options.maxToolContentChars))
        continue
      }
      if (frame.type === 'question/attention') {
        await generation.append(projectInputAttentionFrame(frame))
        continue
      }
      if (frame.type === 'session/projection') {
        if (frame.seq <= baseline.projectionWatermark) continue
        if (frame.key === 'title' && typeof frame.value === 'string') {
          await generation.append({
            event_id: `source-projection-title-${frame.seq}`,
            source_sequence: String(frame.seq),
            session_title_changed: { title: frame.value },
          })
          continue
        }
        const usagePayload = projectUsageFrame(frame)
        if (usagePayload !== null) await generation.append(usagePayload)
        const subagentPayload = projectSubagentFrame(frame)
        if (subagentPayload !== null) await generation.append(subagentPayload)
        const policyPayload = projectPolicyFrame(frame, this.#budgetExhausted(state.sessionId as string))
        if (policyPayload !== null) await generation.append(policyPayload)
        continue
      }
      if (frame.event.seq <= baseline.sourceWatermark) continue
      const projected = projectLiveFrame({
        event: frame.event,
        ...(frame.view === undefined ? {} : { view: frame.view }),
        toolNames: baseline.toolNames,
        maxToolContentChars: this.options.maxToolContentChars,
        ...(sessionFacts.cwd === undefined ? {} : { cwd: sessionFacts.cwd }),
      })
      if (projected.kind === 'ignore') continue
      if (projected.kind === 'snapshot-required') {
        await generation.invalidate({
          error: { code: 'ERROR_CODE_SNAPSHOT_REQUIRED', detail: projected.detail, retryable: true },
        })
        state.subscribed = false
        return
      }
      await generation.append(projected.payload)
      // Live artifact registration (S-artifacts): the same frame, folded by
      // render intent into the Host-owned registry. Recognition shares one
      // fold with the hello roster scan, so the two paths cannot drift.
      const registered = this.options.artifacts?.observeLive({
        sessionId: state.sessionId as string,
        ...(sessionFacts.cwd === undefined ? {} : { cwd: sessionFacts.cwd }),
        event: frame.event,
        ...(frame.view === undefined ? {} : { view: frame.view }),
      }) ?? []
      for (const artifact of registered) {
        await generation.append({
          event_id: `artifact-${artifact.artifact_id}`,
          source_sequence: String(frame.event.seq),
          artifact_registered: { artifact },
        })
      }
    }
  }

  #ack(state: ConnectionState, ack: NonNullable<ClientFrame['ack']>): void {
    const generation = state.generation
    if (!state.subscribed || generation === undefined) {
      this.#writeError(state, 'ERROR_CODE_INVALID_REQUEST', 'subscription required')
      return
    }
    const sequenceText = ack.highest_contiguous_sequence
    if (ack.stream_id !== state.streamId || ack.projection_version !== PROJECTION_VERSION
      || typeof sequenceText !== 'string' || !/^(0|[1-9]\d*)$/.test(sequenceText)
      || BigInt(sequenceText) > generation.latestSequence) {
      this.#writeError(state, 'ERROR_CODE_SNAPSHOT_REQUIRED', 'ack domain changed', true)
    }
  }

  async #control(
    state: ConnectionState,
    request: NonNullable<ClientFrame['control_request']>,
  ): Promise<void> {
    const requestId = request.request_id
    const sessionId = request.session_id
    if (typeof requestId !== 'string' || !remoteIdentifierPattern.test(requestId)
      || !validSessionId(sessionId)) {
      this.#writeError(state, 'ERROR_CODE_INVALID_REQUEST', 'control request_id and session_id required')
      return
    }
    const operations = [request.acquire, request.renew, request.release]
      .filter(operation => operation !== undefined)
    if (operations.length !== 1) {
      this.#writeControlResult(state, requestId, sessionId, 'CONTROL_OUTCOME_REJECTED', {
        code: 'ERROR_CODE_INVALID_REQUEST', detail: 'exactly one control operation required',
      })
      return
    }
    const control = this.options.control?.()
    if (control === undefined) {
      this.#writeControlResult(state, requestId, sessionId, 'CONTROL_OUTCOME_REJECTED', {
        code: 'ERROR_CODE_EFFECTFUL_COMMANDS_DISABLED',
        detail: 'Session control is not enabled in this Host composition',
      })
      return
    }
    try {
      this.#requireAuthorization(state, REMOTE_CONTROL_CAPABILITIES)
    } catch {
      this.#writeControlResult(state, requestId, sessionId, 'CONTROL_OUTCOME_REJECTED', {
        code: 'ERROR_CODE_AUTHORIZATION_DENIED',
        detail: 'The authenticated device is not authorized for Session control',
      })
      return
    }
    const deviceId = state.deviceId.toString('hex') as RemoteDeviceId
    try {
      if (request.acquire !== undefined) {
        const result = await control.acquireControl(sessionId as SessionId, deviceId)
        if (!result.ok) {
          this.#writeControlResult(
            state, requestId, sessionId, 'CONTROL_OUTCOME_REJECTED', controlFailure(result.reason),
          )
          return
        }
        this.#writeControlLease(state, requestId, 'CONTROL_OUTCOME_ACQUIRED', result.lease)
        return
      }
      const rawFence = request.renew?.control ?? request.release?.control
      const proof = this.#controlProof(sessionId, deviceId, rawFence)
      if (proof === undefined) {
        this.#writeControlResult(state, requestId, sessionId, 'CONTROL_OUTCOME_REJECTED', {
          code: 'ERROR_CODE_INVALID_REQUEST', detail: 'complete canonical control fence required',
        })
        return
      }
      if (request.renew !== undefined) {
        const result = await control.renewControl(proof)
        if (!result.ok) {
          this.#writeControlResult(
            state, requestId, sessionId, 'CONTROL_OUTCOME_REJECTED', controlFailure(result.reason),
          )
          return
        }
        this.#writeControlLease(state, requestId, 'CONTROL_OUTCOME_RENEWED', result.lease)
        return
      }
      const result = await control.releaseControl(proof)
      if (!result.ok) {
        this.#writeControlResult(
          state, requestId, sessionId, 'CONTROL_OUTCOME_REJECTED', controlFailure(result.reason),
        )
        return
      }
      this.#writeControlResult(state, requestId, sessionId, 'CONTROL_OUTCOME_RELEASED')
    } catch {
      this.#writeControlResult(state, requestId, sessionId, 'CONTROL_OUTCOME_REJECTED', {
        code: 'ERROR_CODE_CONTROL_UNAVAILABLE',
        detail: 'The Host control owner is temporarily unavailable',
      })
    }
  }

  async #command(state: ConnectionState, command: NonNullable<ClientFrame['command']>): Promise<void> {
    const commandId = command.command_id
    if (typeof commandId !== 'string' || !remoteIdentifierPattern.test(commandId)) {
      this.#writeError(state, 'ERROR_CODE_INVALID_REQUEST', 'command_id required')
      return
    }
    const sessionId = command.session_id
    const text = command.send_input?.text
    const stopRevisionText = command.stop_active?.expected_activity_revision
    const approval = command.decide_approval
    const create = command.create_session
    const selectPreset = command.select_agent_preset
    const selectModel = command.select_model
    const fork = command.fork_session
    const revoke = command.revoke_approval_rule
    const budget = command.set_session_budget
    const operations = [
      command.send_input, command.stop_active, approval, create, selectPreset, selectModel, fork, revoke, budget,
    ].filter(operation => operation !== undefined)
    if (!validSessionId(sessionId) || operations.length !== 1) {
      this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, {
        code: 'ERROR_CODE_INVALID_REQUEST', detail: 'session_id and exactly one command operation required',
      })
      return
    }
    const stopping = command.stop_active !== undefined
    const deciding = approval !== undefined
    const creating = create !== undefined
    const selecting = selectPreset !== undefined
    const selectingModel = selectModel !== undefined
    const forking = fork !== undefined
    const revoking = revoke !== undefined
    const budgeting = budget !== undefined
    const presetIdPattern = /^[\x21-\x7e]{1,100}$/
    const modelIdPattern = /^[\x21-\x7e]{1,200}$/
    const ruleIdPattern = /^[0-9a-f]{16,64}$/
    const createAgentPreset = create?.agent_preset
    const createWorkspaceId = create?.workspace_id
    const createNewWorkspaceName = create?.new_workspace_name
    const selectAgentPreset = selectPreset?.agent_preset
    const modelProvider = selectModel?.provider
    const modelId = selectModel?.model
    const modelEffort = selectModel?.reasoning_effort
    const forkChildId = fork?.child_session_id
    const forkAtSeq = fork?.at_seq
    const revokeRuleId = revoke?.rule_id
    const budgetCeilingText = budget?.max_total_tokens
    const approvalDecision = approval?.decision
    // ALLOW_SAME_KIND settles as allowed-once and additionally mints the
    // same-kind rule (S-policy): the outcome vocabulary stays closed and the
    // grant intent travels as a distinct command flag.
    const approvalOutcome = approvalDecision === 'APPROVAL_DECISION_ALLOW_ONCE'
      || approvalDecision === 'APPROVAL_DECISION_ALLOW_SAME_KIND'
      ? 'allowed-once'
      : approvalDecision === 'APPROVAL_DECISION_DENY'
        ? 'rejected'
        : undefined
    const grantSameKind = approvalDecision === 'APPROVAL_DECISION_ALLOW_SAME_KIND'
    if ((!stopping && !deciding && !creating && !selecting && !selectingModel && !forking && !revoking && !budgeting
        && (typeof text !== 'string' || text === ''))
      || (stopping && (typeof stopRevisionText !== 'string'
        || !uint64Pattern.test(stopRevisionText)
        || BigInt(stopRevisionText) > BigInt(Number.MAX_SAFE_INTEGER)
        || stopRevisionText === '0'))
      || (deciding && (typeof approval.approval_id !== 'string'
        || !remoteIdentifierPattern.test(approval.approval_id)
        || typeof approval.revision !== 'string'
        || !remoteIdentifierPattern.test(approval.revision)
        || approvalOutcome === undefined))
      || (creating && createAgentPreset !== undefined
        && (typeof createAgentPreset !== 'string' || !presetIdPattern.test(createAgentPreset)))
      || (creating && createWorkspaceId !== undefined
        && (typeof createWorkspaceId !== 'string' || !presetIdPattern.test(createWorkspaceId)))
      || (creating && createNewWorkspaceName !== undefined
        && (typeof createNewWorkspaceName !== 'string'
          || sanitizeRemoteWorkspaceName(createNewWorkspaceName) === undefined))
      || (creating && createNewWorkspaceName !== undefined && createWorkspaceId === undefined)
      || (selecting && (typeof selectAgentPreset !== 'string' || !presetIdPattern.test(selectAgentPreset)))
      || (selectingModel && (typeof modelProvider !== 'string' || !presetIdPattern.test(modelProvider)
        || typeof modelId !== 'string' || !modelIdPattern.test(modelId)
        || (modelEffort !== undefined && (typeof modelEffort !== 'string' || !presetIdPattern.test(modelEffort)))))
      || (forking && (typeof forkChildId !== 'string' || !validSessionId(forkChildId)
        || (forkAtSeq !== undefined && (typeof forkAtSeq !== 'string'
          || !uint64Pattern.test(forkAtSeq)
          || BigInt(forkAtSeq) > BigInt(Number.MAX_SAFE_INTEGER)))))
      || (revoking && (typeof revokeRuleId !== 'string' || !ruleIdPattern.test(revokeRuleId)))
      || (budgeting && (typeof budgetCeilingText !== 'string'
        || !uint64Pattern.test(budgetCeilingText)
        || budgetCeilingText === '0'
        || BigInt(budgetCeilingText) > BigInt(Number.MAX_SAFE_INTEGER)))) {
      if (stopping) {
        this.#writeStopResult(state, commandId, sessionId, '0', 'STOP_OUTCOME_REJECTED', false, {
          code: 'ERROR_CODE_INVALID_REQUEST', detail: 'positive canonical expected_activity_revision required',
        })
      } else if (creating) {
        const workspaceShape = (createNewWorkspaceName !== undefined && createWorkspaceId === undefined)
          || (createNewWorkspaceName !== undefined
            && sanitizeRemoteWorkspaceName(String(createNewWorkspaceName ?? '')) === undefined)
          || (createWorkspaceId !== undefined && (typeof createWorkspaceId !== 'string' || !presetIdPattern.test(createWorkspaceId)))
        this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, {
          code: workspaceShape ? 'ERROR_CODE_WORKSPACE_INVALID_NAME' : 'ERROR_CODE_INVALID_REQUEST',
          detail: workspaceShape
            ? 'new_workspace_name must be a single folder name under an existing workspace'
            : 'a bounded printable agent_preset id is required',
        })
      } else if (selecting) {
        this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, {
          code: 'ERROR_CODE_INVALID_REQUEST', detail: 'a bounded printable agent_preset id is required',
        })
      } else if (selectingModel) {
        this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, {
          code: 'ERROR_CODE_INVALID_REQUEST', detail: 'bounded printable provider and model ids are required',
        })
      } else if (forking) {
        this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, {
          code: 'ERROR_CODE_INVALID_REQUEST', detail: 'a valid child_session_id and optional canonical at_seq are required',
        })
      } else if (revoking) {
        this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, {
          code: 'ERROR_CODE_INVALID_REQUEST', detail: 'a canonical hex rule_id is required',
        })
      } else if (budgeting) {
        this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, {
          code: 'ERROR_CODE_INVALID_REQUEST', detail: 'a positive canonical max_total_tokens ceiling is required',
        })
      } else if (!deciding) {
        this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, {
          code: 'ERROR_CODE_INVALID_REQUEST', detail: 'non-empty send_input.text required',
        })
      } else {
        this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, {
          code: 'ERROR_CODE_INVALID_REQUEST', detail: 'complete approval identity, revision, and decision required',
        })
      }
      return
    }
    // S-blob: committed image references join the send. Absent repeated fields
    // decode as [], so only a non-empty list is shape-checked and fenced.
    const attachmentIds = command.send_input?.attachment_ids ?? []
    if (attachmentIds.some(id => typeof id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(id))) {
      this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, {
        code: 'ERROR_CODE_INVALID_REQUEST',
        detail: 'attachment_ids must be committed sha256 image ids',
      })
      return
    }
    if (attachmentIds.length > 0) {
      const limits = this.options.blobs?.attachmentLimits
      if (limits === undefined) {
        this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, {
          code: 'ERROR_CODE_ATTACHMENT_UNAVAILABLE',
          detail: 'this deployment accepts no image attachments',
        })
        return
      }
      if (attachmentIds.length > limits.maxImagesPerMessage) {
        this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, {
          code: 'ERROR_CODE_ATTACHMENT_UNAVAILABLE',
          detail: `at most ${limits.maxImagesPerMessage} images per message`,
        })
        return
      }
    }
    const commands = this.options.commands?.()
    if (commands === undefined) {
      const error = {
        code: 'ERROR_CODE_EFFECTFUL_COMMANDS_DISABLED',
        detail: 'effectful commands are not enabled in this Host composition',
      }
      if (stopping) {
        this.#writeStopResult(
          state, commandId, sessionId, stopRevisionText as string, 'STOP_OUTCOME_REJECTED', false, error,
        )
      } else this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, error)
      return
    }
    const deviceId = state.deviceId.toString('hex') as RemoteDeviceId
    // Policy mutations are lease-free like fork/create: they change durable
    // policy facts, not the in-flight input stream, so there is no effect to
    // fence (S-policy).
    const leaseFree = deciding || creating || selecting || forking || revoking || budgeting
    const control = leaseFree ? undefined : this.#controlProof(sessionId, deviceId, command.control)
    if (!leaseFree && control === undefined) {
      const error = {
        code: 'ERROR_CODE_INVALID_REQUEST', detail: 'complete canonical command control fence required',
      }
      if (stopping) {
        this.#writeStopResult(
          state, commandId, sessionId, stopRevisionText as string, 'STOP_OUTCOME_REJECTED', false, error,
        )
      } else this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, error)
      return
    }
    // Rule revocation shares the approval trust domain (the same authority
    // that creates rules); budget setting is session administration and rides
    // the send/control set like select_model (S-policy).
    const requiredCapabilities = deciding || revoking
      ? REMOTE_APPROVAL_CAPABILITIES
      : stopping ? REMOTE_STOP_CONTROL_CAPABILITIES : REMOTE_SEND_CONTROL_CAPABILITIES
    const authority: RemoteCommandAuthority = Object.freeze({
      deviceId,
      authorityEpoch: state.domain.authorityEpoch,
      authorize: () => { this.#requireAuthorization(state, requiredCapabilities) },
    })
    try {
      authority.authorize()
    } catch {
      const error = {
        code: 'ERROR_CODE_AUTHORIZATION_DENIED',
        detail: stopping
          ? 'The authenticated device is not authorized to Stop'
          : deciding
            ? 'The authenticated device is not authorized to decide approvals'
            : 'The authenticated device is not authorized for this command',
      }
      if (stopping) {
        this.#writeStopResult(
          state, commandId, sessionId, stopRevisionText as string, 'STOP_OUTCOME_REJECTED', false, error,
        )
      } else this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_REJECTED', false, error)
      return
    }
    try {
      if (creating) {
        const boundName = typeof createNewWorkspaceName === 'string'
          ? sanitizeRemoteWorkspaceName(createNewWorkspaceName)
          : undefined
        const terminal = await commands.createSession(authority, {
          commandId: commandId as RemoteCreateSessionCommandId,
          sessionId: sessionId as SessionId,
          ...(createAgentPreset === undefined ? {} : { agentPreset: createAgentPreset }),
          ...(createWorkspaceId === undefined ? {} : { workspaceId: createWorkspaceId }),
          ...(boundName === undefined ? {} : { newWorkspaceName: boundName }),
        }, (receipt) => {
          this.#writeCommandResult(
            state, receipt.commandId, 'COMMAND_OUTCOME_RECEIVED', receipt.replayed,
          )
        })
        if (terminal.outcome === 'committed') {
          this.#writeCommandResult(
            state, terminal.commandId, 'COMMAND_OUTCOME_COMMITTED', terminal.replayed,
          )
          return
        }
        this.#writeCommandResult(
          state,
          terminal.commandId,
          terminal.outcome === 'rejected' ? 'COMMAND_OUTCOME_REJECTED' : 'COMMAND_OUTCOME_UNKNOWN',
          terminal.replayed,
          commandError(terminal),
        )
        return
      }
      if (selecting) {
        const terminal = await commands.selectAgentPreset(authority, {
          commandId: commandId as RemoteSelectAgentPresetCommandId,
          sessionId: sessionId as SessionId,
          agentPreset: selectAgentPreset as string,
        }, (receipt) => {
          this.#writeCommandResult(
            state, receipt.commandId, 'COMMAND_OUTCOME_RECEIVED', receipt.replayed,
          )
        })
        if (terminal.outcome === 'committed') {
          this.#writeCommandResult(
            state, terminal.commandId, 'COMMAND_OUTCOME_COMMITTED', terminal.replayed,
          )
          return
        }
        this.#writeCommandResult(
          state,
          terminal.commandId,
          terminal.outcome === 'rejected' ? 'COMMAND_OUTCOME_REJECTED' : 'COMMAND_OUTCOME_UNKNOWN',
          terminal.replayed,
          commandError(terminal),
        )
        return
      }
      if (selectingModel) {
        const terminal = await commands.selectModel(authority, {
          commandId: commandId as RemoteSelectModelCommandId,
          sessionId: sessionId as SessionId,
          provider: modelProvider as string,
          model: modelId as string,
          ...(modelEffort === undefined ? {} : { reasoningEffort: modelEffort }),
          control: control as RemoteCommandControlProof,
        }, (receipt) => {
          this.#writeCommandResult(
            state, receipt.commandId, 'COMMAND_OUTCOME_RECEIVED', receipt.replayed,
          )
        })
        if (terminal.outcome === 'committed') {
          this.#writeCommandResult(
            state, terminal.commandId, 'COMMAND_OUTCOME_COMMITTED', terminal.replayed,
          )
          return
        }
        this.#writeCommandResult(
          state,
          terminal.commandId,
          terminal.outcome === 'rejected' ? 'COMMAND_OUTCOME_REJECTED' : 'COMMAND_OUTCOME_UNKNOWN',
          terminal.replayed,
          commandError(terminal),
        )
        return
      }
      if (forking) {
        const terminal = await commands.forkSession(authority, {
          commandId: commandId as RemoteForkSessionCommandId,
          sessionId: sessionId as SessionId,
          childSessionId: forkChildId as SessionId,
          ...(forkAtSeq === undefined ? {} : { atSeq: Number(forkAtSeq) }),
        }, (receipt) => {
          this.#writeCommandResult(
            state, receipt.commandId, 'COMMAND_OUTCOME_RECEIVED', receipt.replayed,
          )
        })
        if (terminal.outcome === 'committed') {
          this.#writeCommandResult(
            state, terminal.commandId, 'COMMAND_OUTCOME_COMMITTED', terminal.replayed,
          )
          return
        }
        this.#writeCommandResult(
          state,
          terminal.commandId,
          terminal.outcome === 'rejected' ? 'COMMAND_OUTCOME_REJECTED' : 'COMMAND_OUTCOME_UNKNOWN',
          terminal.replayed,
          commandError(terminal),
        )
        return
      }
      if (revoking) {
        const terminal = await commands.revokeApprovalRule(authority, {
          commandId: commandId as RemoteRevokeApprovalRuleCommandId,
          sessionId: sessionId as SessionId,
          ruleId: revokeRuleId as string,
        }, (receipt) => {
          this.#writeCommandResult(
            state, receipt.commandId, 'COMMAND_OUTCOME_RECEIVED', receipt.replayed,
          )
        })
        if (terminal.outcome === 'committed') {
          this.#writeCommandResult(
            state, terminal.commandId, 'COMMAND_OUTCOME_COMMITTED', terminal.replayed,
          )
          return
        }
        this.#writeCommandResult(
          state,
          terminal.commandId,
          terminal.outcome === 'rejected' ? 'COMMAND_OUTCOME_REJECTED' : 'COMMAND_OUTCOME_UNKNOWN',
          terminal.replayed,
          commandError(terminal),
        )
        return
      }
      if (budgeting) {
        const terminal = await commands.setSessionBudget(authority, {
          commandId: commandId as RemoteSetSessionBudgetCommandId,
          sessionId: sessionId as SessionId,
          maxTotalTokens: Number(budgetCeilingText),
        }, (receipt) => {
          this.#writeCommandResult(
            state, receipt.commandId, 'COMMAND_OUTCOME_RECEIVED', receipt.replayed,
          )
        })
        if (terminal.outcome === 'committed') {
          this.#writeCommandResult(
            state, terminal.commandId, 'COMMAND_OUTCOME_COMMITTED', terminal.replayed,
          )
          return
        }
        this.#writeCommandResult(
          state,
          terminal.commandId,
          terminal.outcome === 'rejected' ? 'COMMAND_OUTCOME_REJECTED' : 'COMMAND_OUTCOME_UNKNOWN',
          terminal.replayed,
          commandError(terminal),
        )
        return
      }
      if (deciding) {
        const terminal = await commands.decideApproval(authority, {
          commandId: commandId as RemoteApprovalCommandId,
          sessionId: sessionId as SessionId,
          approvalId: approval.approval_id as string,
          approvalRevision: approval.revision as string,
          outcome: approvalOutcome as 'allowed-once' | 'rejected',
          ...(grantSameKind ? { grantSameKind: true as const } : {}),
        }, (receipt) => {
          this.#writeCommandResult(
            state, receipt.commandId, 'COMMAND_OUTCOME_RECEIVED', receipt.replayed,
          )
        })
        if (terminal.outcome === 'committed') {
          this.#writeCommandResult(
            state, terminal.commandId, 'COMMAND_OUTCOME_COMMITTED', terminal.replayed,
          )
          return
        }
        const error = terminal.outcome === 'unknown'
          ? {
            code: 'ERROR_CODE_APPROVAL_SETTLEMENT_UNKNOWN',
            detail: 'The Host cannot prove approval settlement; retry with the same command_id',
          }
          : commandError(terminal)
        this.#writeCommandResult(
          state,
          terminal.commandId,
          terminal.outcome === 'rejected' ? 'COMMAND_OUTCOME_REJECTED' : 'COMMAND_OUTCOME_UNKNOWN',
          terminal.replayed,
          error,
        )
        return
      }
      if (stopping) {
        const expectedActivityRevision = Number(stopRevisionText)
        const terminal = await commands.stop(authority, {
          commandId: commandId as RemoteStopCommandId,
          sessionId: sessionId as SessionId,
          expectedActivityRevision,
          control: control as RemoteControlProof,
        }, (receipt) => {
          this.#writeStopResult(
            state,
            receipt.commandId,
            sessionId,
            String(receipt.expectedActivityRevision),
            'STOP_OUTCOME_REQUESTED',
            receipt.replayed,
          )
        })
        if (terminal.outcome === 'stopped') {
          this.#writeStopResult(
            state,
            terminal.commandId,
            sessionId,
            String(terminal.expectedActivityRevision),
            'STOP_OUTCOME_STOPPED',
            terminal.replayed,
            undefined,
            terminal.currentRunning,
          )
          return
        }
        this.#writeStopResult(
          state,
          terminal.commandId,
          sessionId,
          String(terminal.expectedActivityRevision),
          terminal.outcome === 'rejected' ? 'STOP_OUTCOME_REJECTED' : 'STOP_OUTCOME_UNKNOWN',
          terminal.replayed,
          stopError(terminal),
        )
        return
      }
      const terminal = await commands.sendInput(authority, {
        commandId: commandId as RemoteSendCommandId,
        sessionId: sessionId as SessionId,
        text: text as string,
        ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
        control: control as RemoteControlProof,
      }, (receipt) => {
        this.#writeCommandResult(
          state,
          receipt.commandId,
          'COMMAND_OUTCOME_RECEIVED',
          receipt.replayed,
        )
      })
      if (terminal.outcome === 'committed') {
        this.#writeCommandResult(
          state, terminal.commandId, 'COMMAND_OUTCOME_COMMITTED', terminal.replayed,
        )
        return
      }
      const error = commandError(terminal)
      this.#writeCommandResult(
        state,
        terminal.commandId,
        terminal.outcome === 'rejected' ? 'COMMAND_OUTCOME_REJECTED' : 'COMMAND_OUTCOME_UNKNOWN',
        terminal.replayed,
        error,
      )
    } catch {
      if (stopping) {
        this.#writeStopResult(
          state, commandId, sessionId, stopRevisionText as string, 'STOP_OUTCOME_UNKNOWN', false, {
            code: 'ERROR_CODE_STOP_SETTLEMENT_UNKNOWN',
            detail: 'The Host Stop owner failed after admission; reconcile with the same command_id',
          },
        )
      } else {
        this.#writeCommandResult(state, commandId, 'COMMAND_OUTCOME_UNKNOWN', false, {
          code: deciding ? 'ERROR_CODE_APPROVAL_SETTLEMENT_UNKNOWN' : 'ERROR_CODE_COMMAND_OUTCOME_UNKNOWN',
          detail: deciding
            ? 'The Host approval owner failed after admission; retry with the same command_id'
            : 'The Host command owner failed after admission; retry with the same command_id',
        })
      }
    }
  }

  #controlProof(
    sessionId: string,
    deviceId: RemoteDeviceId,
    raw: { epoch?: string; token?: string } | undefined | null,
  ): RemoteControlProof | undefined {
    // Protobuf decodes an absent message field as null, not undefined.
    if (raw === undefined || raw === null || typeof raw.epoch !== 'string' || !uint64Pattern.test(raw.epoch)
      || BigInt(raw.epoch) > UINT64_MAX || typeof raw.token !== 'string'
      || !controlTokenPattern.test(raw.token)) return undefined
    return Object.freeze({
      sessionId: sessionId as SessionId,
      holderDeviceId: deviceId,
      epoch: raw.epoch as RemoteControlProof['epoch'],
      token: raw.token as RemoteControlProof['token'],
    })
  }

  #requireAuthorization(state: ConnectionState, requiredCapabilities: string): void {
    const current = this.options.security.authorizeCapabilities(
      Buffer.from(state.domain.devicePublicKey, 'hex'),
      requiredCapabilities,
    )
    if (current.decision !== 'allowed' || current.authorityEpoch !== state.domain.authorityEpoch
      || current.deviceId.length !== state.deviceId.length
      || !timingSafeEqual(current.deviceId, state.deviceId)) {
      throw new Error('authenticated device authority changed or lacks capability')
    }
  }

  #writeControlLease(
    state: ConnectionState,
    requestId: string,
    outcome: 'CONTROL_OUTCOME_ACQUIRED' | 'CONTROL_OUTCOME_RENEWED',
    lease: RemoteControlLease,
  ): void {
    this.#writeControlResult(state, requestId, lease.sessionId, outcome, undefined, lease)
  }

  #writeControlResult(
    state: ConnectionState,
    requestId: string,
    sessionId: string,
    outcome: string,
    error?: { code: string; detail: string },
    lease?: RemoteControlLease,
  ): void {
    state.call.write(serverFrame({
      control_result: {
        request_id: requestId,
        session_id: sessionId,
        outcome,
        ...(lease === undefined ? {} : {
          control: { epoch: lease.epoch, token: lease.token },
          expires_at_ms: String(lease.expiresAtMs),
        }),
        error_code: error?.code ?? 'ERROR_CODE_UNSPECIFIED',
        detail: error?.detail ?? '',
      },
    }))
  }

  #writeCommandResult(
    state: ConnectionState,
    commandId: string,
    outcome: string,
    replayed: boolean,
    error?: { code: string; detail: string },
  ): void {
    state.call.write(serverFrame({
      command_result: {
        command_id: commandId,
        outcome,
        replayed,
        error_code: error?.code ?? 'ERROR_CODE_UNSPECIFIED',
        detail: error?.detail ?? '',
      },
    }))
  }

  #writeStopResult(
    state: ConnectionState,
    commandId: string,
    sessionId: string,
    expectedActivityRevision: string,
    outcome: string,
    replayed: boolean,
    error?: { code: string; detail: string },
    currentRunning?: boolean,
  ): void {
    state.call.write(serverFrame({
      stop_result: {
        command_id: commandId,
        session_id: sessionId,
        expected_activity_revision: expectedActivityRevision,
        outcome,
        replayed,
        current_running: currentRunning ?? false,
        current_running_known: currentRunning !== undefined,
        error_code: error?.code ?? 'ERROR_CODE_UNSPECIFIED',
        detail: error?.detail ?? '',
      },
    }))
  }

  #writeError(
    state: ConnectionState,
    code: string,
    detail: string,
    retryable = false,
  ): void {
    state.call.write(serverFrame({ error: { code, detail, retryable } }))
  }
}
