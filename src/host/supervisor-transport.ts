/**
 * Noise-authenticated gRPC carrier for the resident Host-process supervisor
 * (S-supervisor, ADR-007).
 *
 * The tiny supervisor process serves `SupervisorTransport` on its own port:
 * the same secure framing as the Remote channel (single-sourced in
 * `secure-channel.ts`), against the same durable device-authorization store.
 * The store is re-read on every handshake, so a device the dsh child paired
 * or revoked is honored here without restarting the supervisor. Pairing
 * itself never happens on this service.
 *
 * Inside the envelope the protocol is deliberately small: hello → hello_ack,
 * a status push after hello and on every lifecycle transition, three
 * idempotent verbs (start/stop/restart) gated per call on the supervise
 * capability, and heartbeats. There is no status query verb — the push
 * stream is always current.
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import {
  SecureChannelServer,
  type DecryptedSecureCall,
  type SecureChannelCall,
} from './secure-channel.ts'
import {
  SUPERVISOR_MANAGE_CAPABILITIES,
  SUPERVISOR_OBSERVE_CAPABILITIES,
  type RemoteSecurityOwner,
} from './security.ts'

const PROTOCOL_VERSION = 1
const LOOPBACK_HOST = '127.0.0.1'
const MAX_SECURE_ENVELOPE_BYTES = 70_000
const identifierPattern = /^[\x21-\x7e]{1,128}$/

/**
 * Lifecycle facts of the supervised dsh child, exactly as the supervisor
 * core reports them (`apps/cli` owns the implementation; this structural
 * port keeps the carrier free of a CLI dependency).
 */
export interface SupervisorLifecycleFacts {
  state: 'down' | 'running' | 'stopping' | 'backoff'
  downReason?: 'never-started' | 'operator' | 'crash-loop' | 'disposed'
  pid?: number
  sinceMs?: number
  lastExit?: { code: number | null; signal: string | null; atMs: number; requested: boolean }
  crashCount: number
  nextRestartAtMs?: number
}

/** The supervisor core surface this carrier drives. */
export interface SupervisorLifecyclePort {
  status(): SupervisorLifecycleFacts
  start(): Promise<SupervisorLifecycleFacts>
  stop(): Promise<SupervisorLifecycleFacts>
  restart(): Promise<SupervisorLifecycleFacts>
  /** Subscribe to transitions; returns the unsubscribe closure. */
  watch(listener: (status: SupervisorLifecycleFacts) => void): () => void
}

interface SupervisorClientFrame {
  hello?: { protocol_version?: number; client_name?: string }
  command?: {
    command_id?: string
    start?: Record<string, never> | null
    stop?: Record<string, never> | null
    restart?: Record<string, never> | null
  }
  heartbeat?: { nonce?: string }
}

type SupervisorServerFrame = Record<string, unknown>

interface SupervisorServiceDescriptor {
  service: grpc.ServiceDefinition
}

function supervisorService(): SupervisorServiceDescriptor {
  const protoPath = fileURLToPath(new URL('../protocol/v1alpha/dsh_remote_v1alpha.proto', import.meta.url))
  const definition = protoLoader.loadSync(protoPath, {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  })
  const descriptor = grpc.loadPackageDefinition(definition) as unknown as {
    dsh: { remote: { v1alpha: { SupervisorTransport: SupervisorServiceDescriptor } } }
  }
  return descriptor.dsh.remote.v1alpha.SupervisorTransport
}

/**
 * Project supervisor facts onto the wire status shape. Absence stays
 * absent: a down child has no pid, no schedule is never a zero timestamp,
 * and an exit ended by a signal carries no fabricated exit code.
 */
export function supervisorStatusWire(status: SupervisorLifecycleFacts): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    state: status.state,
    consecutive_crashes: status.crashCount,
  }
  // The disposed reason only exists while the supervisor itself drains; by
  // then every stream is ending. It reports as an operator stop — disposal
  // is always an operator-initiated shutdown of the resident process.
  if (status.downReason !== undefined) {
    wire.down_reason = status.downReason === 'disposed' ? 'operator' : status.downReason
  }
  if (status.nextRestartAtMs !== undefined) wire.next_restart_at_ms = String(status.nextRestartAtMs)
  if (status.pid !== undefined) wire.child_pid = status.pid
  if (status.sinceMs !== undefined) wire.child_since_ms = String(status.sinceMs)
  if (status.lastExit !== undefined) {
    if (status.lastExit.code !== null) wire.last_exit_code = status.lastExit.code
    if (status.lastExit.signal !== null) wire.last_exit_signal = status.lastExit.signal
  }
  return wire
}

interface SupervisorSession {
  readonly call: DecryptedSecureCall<SupervisorClientFrame, SupervisorServerFrame>
  readonly devicePublicKey: Buffer
  readonly grantedCapabilities: string
  helloComplete: boolean
  closed: boolean
  unwatch?: () => void
  /** Verbs serialize per session so results correlate to their commands. */
  verbs: Promise<void>
}

/** One supervisor management carrier; the boot mode owns its lifecycle. */
export class SupervisorGrpcCarrier {
  readonly #server = new grpc.Server({ 'grpc.max_receive_message_length': MAX_SECURE_ENVELOPE_BYTES })
  readonly #secureChannel: SecureChannelServer<SupervisorClientFrame, SupervisorServerFrame>
  readonly #sessions = new Set<SupervisorSession>()
  #disposed = false

  constructor(
    private readonly options: {
      host?: string
      port: number
      hostInstanceId: string
      /**
       * Fresh authority per handshake (ADR-007): every accepted call re-reads
       * the durable store, so pairings and revocations made by the dsh child
       * process are honored without restarting the supervisor.
       */
      security: () => RemoteSecurityOwner
      supervisor: SupervisorLifecyclePort
    },
  ) {
    const descriptor = supervisorService()
    const superviseMethod = descriptor.service.Supervise as grpc.MethodDefinition<SupervisorClientFrame, SupervisorServerFrame>
    this.#secureChannel = new SecureChannelServer<SupervisorClientFrame, SupervisorServerFrame>({
      security: this.options.security,
      admissionCapabilities: SUPERVISOR_OBSERVE_CAPABILITIES,
      deserializeClient: bytes => superviseMethod.requestDeserialize(bytes),
      serializeServer: frame => Buffer.from(superviseMethod.responseSerialize(frame)),
      onAuthenticated: (session) => {
        this.#supervise(session.call, session.devicePublicKey, session.grantedCapabilities)
      },
    })
    this.#server.addService(descriptor.service, {
      // The plaintext verb exists only to refuse pre-secure clients honestly,
      // mirroring RemoteTransport.Connect.
      Supervise: (call: grpc.ServerDuplexStream<SupervisorClientFrame, SupervisorServerFrame>) => {
        const error = new Error('paired device authentication required') as grpc.ServiceError
        error.code = grpc.status.UNAUTHENTICATED
        error.details = error.message
        error.metadata = new grpc.Metadata()
        call.emit('error', error)
      },
      SecureConnect: (call: SecureChannelCall) => {
        if (this.#disposed) {
          call.destroy(new Error('supervisor carrier disposed'))
          return
        }
        this.#secureChannel.accept(call)
      },
    })
  }

  /**
   * Bind the management listener.
   * @returns The actual bound port.
   */
  async start(): Promise<number> {
    if (this.#disposed) throw new Error('supervisor carrier is disposed')
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

  /** End every live session, then release the listener. */
  async stop(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    for (const session of [...this.#sessions]) {
      session.closed = true
      session.unwatch?.()
      session.call.end()
    }
    await this.#secureChannel.stop()
    await Promise.allSettled([...this.#sessions].map(session => session.verbs))
    await new Promise<void>((resolve) => {
      this.#server.tryShutdown(() => {
        resolve()
      })
    })
    this.#sessions.clear()
  }

  #supervise(
    call: DecryptedSecureCall<SupervisorClientFrame, SupervisorServerFrame>,
    devicePublicKey: Buffer,
    grantedCapabilities: string,
  ): void {
    if (this.#disposed) {
      call.destroy(new Error('supervisor carrier disposed'))
      return
    }
    const session: SupervisorSession = {
      call,
      devicePublicKey,
      grantedCapabilities,
      helloComplete: false,
      closed: false,
      verbs: Promise.resolve(),
    }
    this.#sessions.add(session)
    const dispose = (): void => {
      if (session.closed) return
      session.closed = true
      session.unwatch?.()
      this.#sessions.delete(session)
    }
    call.once('cancelled', dispose)
    call.once('close', dispose)
    call.once('error', dispose)
    call.on('end', () => {
      dispose()
      call.end()
    })
    call.on('data', (message: SupervisorClientFrame) => { this.#onFrame(session, message) })
  }

  #onFrame(session: SupervisorSession, message: SupervisorClientFrame): void {
    if (session.closed) return
    if (message.hello !== undefined) {
      if (session.helloComplete) {
        this.#writeError(session, 'ERROR_CODE_INVALID_REQUEST', 'supervisor hello already received')
        return
      }
      if (message.hello.protocol_version !== PROTOCOL_VERSION) {
        this.#writeError(session, 'ERROR_CODE_INCOMPATIBLE_VERSION', `expected protocol ${PROTOCOL_VERSION}`)
        session.call.end()
        return
      }
      session.helloComplete = true
      session.call.write(frame({
        hello_ack: {
          host_instance_id: this.options.hostInstanceId,
          granted_capabilities: session.grantedCapabilities,
        },
      }))
      // One status immediately after hello, then a push per transition —
      // subscribers never poll and never observe a gap.
      session.call.write(frame({ status: supervisorStatusWire(this.options.supervisor.status()) }))
      session.unwatch = this.options.supervisor.watch((status) => {
        if (session.closed) return
        session.call.write(frame({ status: supervisorStatusWire(status) }))
      })
      return
    }

    if (!session.helloComplete) {
      this.#writeError(session, 'ERROR_CODE_INVALID_REQUEST', 'supervisor hello required')
      return
    }

    if (message.command !== undefined) {
      const commandId = message.command.command_id
      if (typeof commandId !== 'string' || !identifierPattern.test(commandId)) {
        this.#writeError(session, 'ERROR_CODE_INVALID_REQUEST', 'command_id required')
        return
      }
      const operation = message.command.start !== undefined && message.command.start !== null
        ? 'start'
        : message.command.stop !== undefined && message.command.stop !== null
          ? 'stop'
          : message.command.restart !== undefined && message.command.restart !== null
            ? 'restart'
            : undefined
      if (operation === undefined) {
        this.#writeCommandResult(session, commandId, 'COMMAND_OUTCOME_REJECTED', {
          errorCode: 'ERROR_CODE_INVALID_REQUEST',
          detail: 'unknown supervisor operation',
        })
        return
      }
      session.verbs = session.verbs
        .then(async () => { await this.#executeVerb(session, commandId, operation) })
        .catch(() => undefined)
      return
    }

    if (message.heartbeat !== undefined) {
      const nonce = message.heartbeat.nonce
      if (typeof nonce !== 'string' || !identifierPattern.test(nonce)) {
        this.#writeError(session, 'ERROR_CODE_INVALID_REQUEST', 'heartbeat nonce required')
        return
      }
      session.call.write(frame({ heartbeat_ack: { nonce } }))
      return
    }

    this.#writeError(session, 'ERROR_CODE_INVALID_REQUEST', 'unknown supervisor frame')
  }

  async #executeVerb(
    session: SupervisorSession,
    commandId: string,
    operation: 'start' | 'stop' | 'restart',
  ): Promise<void> {
    if (session.closed) return
    // The supervise capability is re-proved against a fresh read of the
    // durable store at every verb: a device the child revoked a moment ago
    // may keep observing until its stream ends, but can no longer act.
    let allowed = false
    try {
      const decision = this.options.security().authorizeCapabilities(
        session.devicePublicKey,
        SUPERVISOR_MANAGE_CAPABILITIES,
      )
      allowed = decision.decision === 'allowed'
    } catch {
      allowed = false
    }
    if (!allowed) {
      this.#writeCommandResult(session, commandId, 'COMMAND_OUTCOME_REJECTED', {
        errorCode: 'ERROR_CODE_AUTHORIZATION_DENIED',
        detail: 'supervise capability required',
      })
      return
    }
    try {
      await this.options.supervisor[operation]()
    } catch (error) {
      this.#writeCommandResult(session, commandId, 'COMMAND_OUTCOME_REJECTED', {
        errorCode: 'ERROR_CODE_COMMAND_UNAVAILABLE',
        detail: error instanceof Error ? error.message : 'supervisor verb failed',
      })
      return
    }
    this.#writeCommandResult(session, commandId, 'COMMAND_OUTCOME_COMMITTED')
  }

  #writeCommandResult(
    session: SupervisorSession,
    commandId: string,
    outcome: 'COMMAND_OUTCOME_COMMITTED' | 'COMMAND_OUTCOME_REJECTED',
    failure?: { errorCode: string; detail: string },
  ): void {
    if (session.closed) return
    session.call.write(frame({
      command_result: {
        command_id: commandId,
        outcome,
        ...(failure !== undefined ? { error_code: failure.errorCode, detail: failure.detail } : {}),
      },
    }))
  }

  #writeError(session: SupervisorSession, code: string, detail: string): void {
    if (session.closed) return
    session.call.write(frame({ error: { code, detail } }))
  }
}

function frame(payload: Record<string, unknown>): SupervisorServerFrame {
  return { frame_id: randomUUID(), ...payload }
}
