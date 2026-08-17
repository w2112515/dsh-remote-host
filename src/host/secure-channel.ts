/**
 * Server side of the Noise-authenticated secure framing (`SecureConnect`).
 *
 * One implementation serves every v1alpha secure carrier: the Remote
 * projection channel and the supervisor management channel (ADR-007) run the
 * exact same hello → IK → authorize → AEAD state machine, differing only in
 * the security authority they present, the capability mask that admits a
 * device, and the plaintext protocol spoken inside the envelope. Keeping the
 * framing single-sourced is a security property — the channels cannot drift.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type grpc from '@grpc/grpc-js'
import { connectionPrologue, type RemoteConnectionHandshake, type RemoteSecureTransport, type RemoteSecurityOwner } from './security.ts'

/** Secure hello must speak this framing version. */
const SECURE_PROTOCOL_VERSION = 1
/** Largest Noise message either side may frame. */
export const MAX_NOISE_MESSAGE_BYTES = 65_535
/** Largest plaintext that still fits one Noise message with its AEAD tag. */
export const MAX_NOISE_PLAINTEXT_BYTES = MAX_NOISE_MESSAGE_BYTES - 16

/** Wire shape of one client → server secure envelope frame. */
export interface SecureClientFrame {
  hello?: { protocol_version?: number; connection_id?: string; host_public_key?: Buffer }
  handshake_message?: Buffer
  ciphertext?: Buffer
}

/** Server → client secure envelopes are loosely typed like every carrier frame. */
export type SecureServerEnvelope = Record<string, unknown>

/** The gRPC duplex stream a secure channel serves. */
export type SecureChannelCall = grpc.ServerDuplexStream<SecureClientFrame, SecureServerEnvelope>

/**
 * One authenticated secure call: AEAD framing plus the per-frame
 * authorization fence around an inner plaintext protocol.
 */
export interface DecryptedSecureCall<TClient, TServer> {
  write(message: TServer): boolean
  end(): void
  destroy(error?: Error): void
  fenceAuthorizationChange(closeAfterWrite?: boolean): void
  on(event: 'data', listener: (message: TClient) => void): unknown
  on(event: 'end', listener: () => void): unknown
  once(event: 'cancelled' | 'close', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

/** Facts of one admitted device, exactly as the authority decided them. */
export interface SecureChannelSession<TClient, TServer> {
  call: DecryptedSecureCall<TClient, TServer>
  devicePublicKey: Buffer
  deviceId: Buffer
  grantedCapabilities: string
  authorityEpoch: string
}

/** Channel policy: authority, admission mask, and the inner frame codecs. */
export interface SecureChannelOptions<TClient, TServer> {
  /**
   * Security authority for one accepted call, resolved per call. The Remote
   * carrier passes its resident owner; the supervisor re-reads the durable
   * store here so pairings made by the dsh child admit without a restart
   * (ADR-007 "re-read on every handshake").
   */
  security: () => RemoteSecurityOwner
  /** Capability mask a device must hold at handshake time to be admitted. */
  admissionCapabilities: string
  deserializeClient: (bytes: Buffer) => TClient
  serializeServer: (frame: TServer) => Buffer
  /** Called exactly once per call after IK completes and the device is admitted. */
  onAuthenticated: (session: SecureChannelSession<TClient, TServer>) => void
}

interface SecureConnectionState {
  readonly call: SecureChannelCall
  incoming: Promise<void>
  phase: 'awaiting-hello' | 'handshaking' | 'authenticated' | 'closed'
  security?: RemoteSecurityOwner
  handshake?: RemoteConnectionHandshake
  remoteCall?: SecureCallImpl<unknown, unknown>
}

function envelope(payload: Record<string, unknown>): SecureServerEnvelope {
  return { frame_id: randomUUID(), ...payload }
}

class SecureCallImpl<TClient, TServer> extends EventEmitter implements DecryptedSecureCall<TClient, TServer> {
  #closed = false
  #authorizationFenced = false
  #fenceTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly call: SecureChannelCall,
    private readonly transport: RemoteSecureTransport,
    private readonly deserializeClient: (bytes: Buffer) => TClient,
    private readonly serializeServer: (frame: TServer) => Buffer,
    private readonly authorized: () => boolean,
  ) {
    super()
    call.once('cancelled', () => { this.#close('cancelled') })
    call.once('close', () => { this.#close('close') })
    call.once('error', (error) => { this.#close('error', error) })
    call.on('end', () => { this.#close('end') })
  }

  receive(ciphertext: Buffer): void {
    if (this.#closed) return
    if (ciphertext.length > MAX_NOISE_MESSAGE_BYTES) {
      this.destroy(new Error('secure frame exceeds the Noise message bound'))
      return
    }
    if (!this.authorized()) {
      this.fenceAuthorizationChange(true)
      return
    }
    try {
      const plaintext = this.transport.decrypt(ciphertext)
      this.emit('data', this.deserializeClient(plaintext))
    } catch {
      this.destroy(new Error('secure frame authentication failed'))
    }
  }

  write(message: TServer): boolean {
    if (this.#closed) return false
    if (!this.authorized()) {
      this.fenceAuthorizationChange(true)
      return false
    }
    try {
      const plaintext = this.serializeServer(message)
      if (plaintext.length > MAX_NOISE_PLAINTEXT_BYTES) {
        this.destroy(new Error('remote frame exceeds the Noise plaintext bound'))
        return false
      }
      const ciphertext = this.transport.encrypt(plaintext)
      return this.call.write(envelope({ ciphertext }))
    } catch {
      this.destroy(new Error('secure frame encryption failed'))
      return false
    }
  }

  fenceAuthorizationChange(closeAfterWrite: boolean = false): void {
    if (!this.#closed && !this.authorized()) {
      if (!this.#authorizationFenced || closeAfterWrite) {
        this.call.write(envelope({
          error: {
            code: 'SECURE_ERROR_CODE_UNAUTHORIZED_DEVICE',
            detail: 'device authorization changed',
          },
        }))
      }
      this.#authorizationFenced = true
      if (closeAfterWrite) {
        this.#terminateAuthorizationFence(true)
      } else if (this.#fenceTimer === undefined) {
        this.#fenceTimer = setTimeout(() => { this.#terminateAuthorizationFence(false) }, 15_000)
        this.#fenceTimer.unref()
      }
    }
  }

  end(): void {
    if (this.#closed) return
    this.#closed = true
    this.#clearFenceTimer()
    this.call.end()
    this.emit('end')
  }

  destroy(error?: Error): void {
    if (this.#closed) return
    this.#closed = true
    this.#clearFenceTimer()
    if (error === undefined) {
      this.call.end()
      this.emit('close')
    } else {
      this.call.emit('error', error)
      this.emit('error', error)
    }
  }

  #close(event: 'cancelled' | 'close' | 'error' | 'end', error?: Error): void {
    if (this.#closed) return
    this.#closed = true
    this.#clearFenceTimer()
    if (event === 'error') this.emit('error', error ?? new Error('secure carrier failed'))
    else this.emit(event)
  }

  #terminateAuthorizationFence(deferEnd: boolean): void {
    if (this.#closed) return
    this.#closed = true
    this.#clearFenceTimer()
    const end = (): void => { this.call.end() }
    if (deferEnd) setImmediate(end)
    else end()
    this.emit('error', new Error('device authorization changed'))
  }

  #clearFenceTimer(): void {
    if (this.#fenceTimer === undefined) return
    clearTimeout(this.#fenceTimer)
    this.#fenceTimer = undefined
  }
}

/**
 * All live secure calls of one gRPC service: accepts streams, walks each
 * through the handshake state machine, and owns their teardown.
 */
export class SecureChannelServer<TClient, TServer> {
  readonly #connections = new Set<SecureConnectionState>()
  #disposed = false

  constructor(private readonly options: SecureChannelOptions<TClient, TServer>) {}

  /** Serve one incoming `SecureConnect` stream until either side ends it. */
  accept(call: SecureChannelCall): void {
    if (this.#disposed) {
      call.destroy(new Error('secure channel disposed'))
      return
    }
    const state: SecureConnectionState = {
      call,
      incoming: Promise.resolve(),
      phase: 'awaiting-hello',
    }
    this.#connections.add(state)
    const dispose = (): void => {
      state.phase = 'closed'
      this.#connections.delete(state)
    }
    call.once('cancelled', dispose)
    call.once('close', dispose)
    call.once('error', dispose)
    call.on('end', () => {
      dispose()
      call.end()
    })
    call.on('data', (message: SecureClientFrame) => {
      state.incoming = state.incoming
        .then(() => { this.#onFrame(state, message) })
        .catch(() => {
          this.#writeError(state, 'SECURE_ERROR_CODE_CRYPTOGRAPHIC_FAILURE', 'secure connection failed closed')
          state.phase = 'closed'
          state.call.end()
        })
    })
  }

  /** Re-check every authenticated call against its authority epoch. */
  fenceAll(): void {
    for (const state of this.#connections) state.remoteCall?.fenceAuthorizationChange()
  }

  /** End every live call and await their incoming chains. */
  async stop(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const states = [...this.#connections]
    for (const state of states) {
      state.phase = 'closed'
      state.call.end()
    }
    await Promise.allSettled(states.map(state => state.incoming))
    this.#connections.clear()
  }

  #onFrame(state: SecureConnectionState, message: SecureClientFrame): void {
    if (state.phase === 'closed') return
    if (message.hello !== undefined) {
      if (state.phase !== 'awaiting-hello') {
        this.#writeError(state, 'SECURE_ERROR_CODE_INVALID_REQUEST', 'secure hello already received')
        return
      }
      if (message.hello.protocol_version !== SECURE_PROTOCOL_VERSION) {
        this.#writeError(
          state,
          'SECURE_ERROR_CODE_INCOMPATIBLE_VERSION',
          `expected protocol ${SECURE_PROTOCOL_VERSION}`,
        )
        state.call.end()
        return
      }
      const connectionId = message.hello.connection_id
      const presentedHostKey = message.hello.host_public_key
      if (typeof connectionId !== 'string' || !Buffer.isBuffer(presentedHostKey)) {
        this.#writeError(state, 'SECURE_ERROR_CODE_INVALID_REQUEST', 'secure hello fields required')
        return
      }
      // The per-call authority is resolved at hello time and serves the whole
      // call: the handshake, admission, and the per-frame fence all see one
      // consistent snapshot of the durable store.
      state.security = this.options.security()
      const hostPublicKey = state.security.hostPublicKey()
      if (presentedHostKey.length !== hostPublicKey.length || !timingSafeEqual(presentedHostKey, hostPublicKey)) {
        this.#writeError(
          state,
          'SECURE_ERROR_CODE_HOST_IDENTITY_MISMATCH',
          'pinned Host identity does not match',
        )
        state.call.end()
        return
      }
      state.handshake = state.security.connectionResponder(
        connectionPrologue(hostPublicKey, connectionId),
      )
      state.phase = 'handshaking'
      return
    }

    if (message.handshake_message !== undefined) {
      if (state.phase !== 'handshaking' || state.handshake === undefined || state.security === undefined) {
        this.#writeError(state, 'SECURE_ERROR_CODE_INVALID_REQUEST', 'secure hello required')
        return
      }
      if (message.handshake_message.length > MAX_NOISE_MESSAGE_BYTES) {
        throw new Error('handshake message exceeds the Noise bound')
      }
      const security = state.security
      const payload = state.handshake.read(Buffer.from(message.handshake_message))
      if (payload.length !== 0) throw new Error('handshake payload is not allowed')
      const response = state.handshake.write(Buffer.alloc(0))
      state.call.write(envelope({ handshake_message: response }))
      if (!state.handshake.finished()) throw new Error('IK handshake did not finish')
      const peerPublicKey = state.handshake.peerPublicKey()
      const authorization = security.authorizeCapabilities(peerPublicKey, this.options.admissionCapabilities)
      if (authorization.decision !== 'allowed') {
        this.#writeError(
          state,
          'SECURE_ERROR_CODE_UNAUTHORIZED_DEVICE',
          'authenticated device is not authorized',
        )
        state.phase = 'closed'
        state.call.end()
        return
      }
      const deviceId = Buffer.from(authorization.deviceId)
      const authorityEpoch = authorization.authorityEpoch
      const transport = state.handshake.finishTransport()
      const authorized = (): boolean => {
        const current = security.authorizeCapabilities(peerPublicKey, this.options.admissionCapabilities)
        return current.decision === 'allowed'
          && current.authorityEpoch === authorityEpoch
          && current.deviceId.length === deviceId.length
          && timingSafeEqual(current.deviceId, deviceId)
      }
      delete state.handshake
      state.phase = 'authenticated'
      const secureCall = new SecureCallImpl<TClient, TServer>(
        state.call,
        transport,
        this.options.deserializeClient,
        this.options.serializeServer,
        authorized,
      )
      state.remoteCall = secureCall as SecureCallImpl<unknown, unknown>
      this.options.onAuthenticated({
        call: secureCall,
        devicePublicKey: peerPublicKey,
        deviceId,
        grantedCapabilities: authorization.grantedCapabilities,
        authorityEpoch,
      })
      return
    }

    if (message.ciphertext !== undefined) {
      if (state.phase !== 'authenticated' || state.remoteCall === undefined) {
        this.#writeError(state, 'SECURE_ERROR_CODE_INVALID_REQUEST', 'Noise IK handshake required')
        return
      }
      state.remoteCall.receive(Buffer.from(message.ciphertext))
      return
    }

    this.#writeError(state, 'SECURE_ERROR_CODE_INVALID_REQUEST', 'unknown secure frame')
  }

  #writeError(state: SecureConnectionState, code: string, detail: string): void {
    if (state.phase === 'closed') return
    state.call.write(envelope({ error: { code, detail } }))
  }
}
