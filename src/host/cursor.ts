/** Bounded same-process retention for one Remote projection generation. */

/** Identity and projection facts that authorize one retained generation. */
export interface ProjectionCursorDomain {
  sessionId: string
  devicePublicKey: string
  authorityEpoch: string
  projectionVersion: number
}

/** Resume cursor supplied by an authenticated Remote client. */
export interface ProjectionResumeCursor {
  streamId: string
  projectionVersion: number
  highestContiguousSequence: bigint
}

/** Single writable owner of one generation's serialized delivery. */
export interface ProjectionDelivery {
  active(): boolean
  write(frame: Record<string, unknown>): boolean
  backpressure(): void
}

/** Stable reason why a retained generation cannot serve a resume request. */
export type ProjectionResumeRejection =
  | 'generation-unavailable'
  | 'domain-changed'
  | 'cursor-ahead'
  | 'cursor-too-old'

/** Result of atomically attaching and replaying one retained generation. */
export type ProjectionResumeResult =
  | { accepted: true; generation: RetainedProjectionGeneration }
  | { accepted: false; reason: ProjectionResumeRejection }

interface RetainedFrame {
  sequence: bigint
  frame: Record<string, unknown>
  jsonBytes: number
}

/** Memory and offline-lifetime bounds for retained generations. */
export interface CursorStoreOptions {
  maxEvents: number
  maxJsonBytes: number
  detachedTtlMs: number
  maxGenerations: number
}

/** New retention cannot evict any attached generation within the global bound. */
export class ProjectionGenerationCapacityError extends Error {
  constructor() {
    super('retained projection generation capacity is exhausted')
    this.name = 'ProjectionGenerationCapacityError'
  }
}

function domainsEqual(left: ProjectionCursorDomain, right: ProjectionCursorDomain): boolean {
  return left.sessionId === right.sessionId
    && left.devicePublicKey === right.devicePublicKey
    && left.authorityEpoch === right.authorityEpoch
    && left.projectionVersion === right.projectionVersion
}

/** One retained stream generation with a serialized append/attach owner. */
export class RetainedProjectionGeneration {
  readonly #frames: RetainedFrame[] = []
  #retainedJsonBytes = 0
  #latestSequence = 0n
  #delivery: ProjectionDelivery | undefined
  #expiry: ReturnType<typeof setTimeout> | undefined
  #serial = Promise.resolve()
  #disposed = false

  constructor(
    readonly streamId: string,
    readonly domain: ProjectionCursorDomain,
    private readonly abort: AbortController,
    private readonly options: CursorStoreOptions,
    private readonly remove: (generation: RetainedProjectionGeneration) => void,
    delivery: ProjectionDelivery,
  ) {
    this.#delivery = delivery
  }

  /** Highest sequence assigned in this generation, including evicted events. */
  get latestSequence(): bigint {
    return this.#latestSequence
  }

  /** Whether this generation currently owns a live delivery. */
  get attached(): boolean {
    return this.#delivery !== undefined
  }

  /**
   * Append, retain, and deliver one projected event in generation order.
   * @param payload - Minimized projected-event fields excluding generation coordinates.
   */
  append(payload: Record<string, unknown>): Promise<void> {
    return this.#enqueue(() => {
      if (this.#disposed) return
      const sequence = ++this.#latestSequence
      const frame = {
        event: {
          stream_id: this.streamId,
          projection_version: this.domain.projectionVersion,
          sequence: String(sequence),
          session_id: this.domain.sessionId,
          ...payload,
        },
      }
      const retained = {
        sequence,
        frame,
        jsonBytes: Buffer.byteLength(JSON.stringify(frame), 'utf8'),
      }
      this.#frames.push(retained)
      this.#retainedJsonBytes += retained.jsonBytes
      while (
        this.#frames.length > this.options.maxEvents
        || this.#retainedJsonBytes > this.options.maxJsonBytes
      ) {
        const removed = this.#frames.shift()
        if (removed !== undefined) this.#retainedJsonBytes -= removed.jsonBytes
      }
      const delivery = this.#delivery
      if (delivery !== undefined) this.#deliver(delivery, frame)
    })
  }

  /**
   * Attach one delivery owner, emit acceptance, and replay a contiguous retained suffix.
   * @param delivery - Authenticated connection that becomes the sole delivery owner.
   * @param highestContiguousSequence - Last sequence already applied by the client.
   * @returns A rejection reason, or `undefined` after acceptance and replay.
   */
  resume(delivery: ProjectionDelivery, highestContiguousSequence: bigint): Promise<ProjectionResumeRejection | undefined> {
    let rejection: ProjectionResumeRejection | undefined
    return this.#enqueue(() => {
      if (this.#disposed) {
        rejection = 'generation-unavailable'
        return
      }
      if (!delivery.active()) {
        rejection = 'generation-unavailable'
        return
      }
      if (highestContiguousSequence > this.#latestSequence) {
        rejection = 'cursor-ahead'
        return
      }
      const oldest = this.#frames[0]?.sequence
      if (highestContiguousSequence < this.#latestSequence
        && (oldest === undefined || highestContiguousSequence + 1n < oldest)) {
        rejection = 'cursor-too-old'
        return
      }
      this.#delivery = delivery
      this.#clearExpiry()
      const latestSequence = this.#latestSequence
      if (!this.#deliver(delivery, {
        resume_accepted: {
          stream_id: this.streamId,
          projection_version: this.domain.projectionVersion,
          resumed_after_sequence: String(highestContiguousSequence),
          latest_sequence: String(latestSequence),
        },
      })) {
        rejection = 'generation-unavailable'
        return
      }
      for (const retained of this.#frames) {
        if (retained.sequence > highestContiguousSequence && retained.sequence <= latestSequence) {
          if (!this.#deliver(delivery, retained.frame)) {
            rejection = 'generation-unavailable'
            return
          }
        }
      }
    }).then(() => rejection)
  }

  /**
   * Detach only the named delivery owner and begin the offline retention TTL.
   * @param delivery - Connection losing ownership; stale owners cannot detach a replacement.
   */
  detach(delivery: ProjectionDelivery): Promise<void> {
    return this.#enqueue(() => {
      if (this.#disposed || this.#delivery !== delivery) return
      this.#delivery = undefined
      this.#startExpiry()
    })
  }

  /**
   * Serialize a terminal frame after prior events, then abort and clear the generation.
   * @param frame - Retryable terminal error delivered before disposal when attached.
   */
  invalidate(frame: Record<string, unknown>): Promise<void> {
    return this.#enqueue(() => {
      if (this.#disposed) return
      this.#delivery?.write(frame)
      this.dispose()
    })
  }

  /** Abort the source watcher, clear retained JSON, and remove this generation. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#clearExpiry()
    this.#delivery = undefined
    this.#frames.length = 0
    this.#retainedJsonBytes = 0
    this.abort.abort()
    this.remove(this)
  }

  #enqueue(operation: () => void): Promise<void> {
    const next = this.#serial.then(operation)
    this.#serial = next.catch(() => {})
    return next
  }

  #clearExpiry(): void {
    if (this.#expiry === undefined) return
    clearTimeout(this.#expiry)
    this.#expiry = undefined
  }

  #startExpiry(): void {
    this.#clearExpiry()
    this.#expiry = setTimeout(() => { this.dispose() }, this.options.detachedTtlMs)
    this.#expiry.unref()
  }

  #deliver(delivery: ProjectionDelivery, frame: Record<string, unknown>): boolean {
    if (!delivery.active()) {
      if (this.#delivery === delivery) {
        this.#delivery = undefined
        this.#startExpiry()
      }
      return false
    }
    if (!delivery.write(frame)) {
      if (this.#delivery === delivery) {
        this.#delivery = undefined
        this.#startExpiry()
      }
      delivery.backpressure()
      return false
    }
    return true
  }
}

/** Process-local owner for all resumable Remote projection generations. */
export class RetainedProjectionCursorStore {
  readonly #generations = new Map<string, RetainedProjectionGeneration>()

  constructor(private readonly options: CursorStoreOptions) {}

  /**
   * Create an attached generation around an already-open source watcher.
   * @param streamId - Fresh unpredictable generation identity.
   * @param domain - Session, authenticated authority, and projection binding.
   * @param abort - Controller that owns the source watcher.
   * @param delivery - Initial authenticated delivery owner.
   * @returns The new retained generation.
   */
  create(
    streamId: string,
    domain: ProjectionCursorDomain,
    abort: AbortController,
    delivery: ProjectionDelivery,
  ): RetainedProjectionGeneration {
    for (const generation of [...this.#generations.values()]) {
      if (domainsEqual(generation.domain, domain)) generation.dispose()
    }
    while (this.#generations.size >= this.options.maxGenerations) {
      const detached = [...this.#generations.values()].find(generation => !generation.attached)
      if (detached === undefined) throw new ProjectionGenerationCapacityError()
      detached.dispose()
    }
    const generation = new RetainedProjectionGeneration(
      streamId,
      domain,
      abort,
      this.options,
      (current) => {
        if (this.#generations.get(current.streamId) === current) {
          this.#generations.delete(current.streamId)
        }
      },
      delivery,
    )
    this.#generations.set(streamId, generation)
    return generation
  }

  /**
   * Validate the complete resume domain, then atomically attach and replay.
   * @param domain - Current authenticated connection and requested Session domain.
   * @param cursor - Retained generation and last contiguous client sequence.
   * @param delivery - Authenticated connection requesting ownership.
   * @returns Acceptance with the generation, or a stable snapshot-required reason.
   */
  async resume(
    domain: ProjectionCursorDomain,
    cursor: ProjectionResumeCursor,
    delivery: ProjectionDelivery,
  ): Promise<ProjectionResumeResult> {
    const generation = this.#generations.get(cursor.streamId)
    if (generation === undefined) return { accepted: false, reason: 'generation-unavailable' }
    if (cursor.projectionVersion !== domain.projectionVersion || !domainsEqual(generation.domain, domain)) {
      return { accepted: false, reason: 'domain-changed' }
    }
    const rejection = await generation.resume(delivery, cursor.highestContiguousSequence)
    return rejection === undefined
      ? { accepted: true, generation }
      : { accepted: false, reason: rejection }
  }

  /**
   * Abort and forget generations whose authenticated authority is no longer current.
   * @param isCurrent - Reauthorization predicate over each retained domain.
   */
  fenceAuthorization(isCurrent: (domain: ProjectionCursorDomain) => boolean): void {
    for (const generation of [...this.#generations.values()]) {
      if (!isCurrent(generation.domain)) generation.dispose()
    }
  }

  /** Abort every source watcher and clear all retained generations. */
  stop(): void {
    for (const generation of [...this.#generations.values()]) generation.dispose()
    this.#generations.clear()
  }
}
