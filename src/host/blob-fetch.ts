/**
 * Blob fetch server (S-blob, ADR-005): the Host half of the download direction.
 * Each fetch session proves its ACL once at open (attachment: the session-log
 * reference proof, artifact: registry membership — both injected), then serves
 * offset-addressed contiguous chunks the carrier maps onto blob_fetch frames.
 * Attachment payloads are deployment-bounded images held whole in memory;
 * artifact payloads are pread from an open handle so a 100 MiB artifact never
 * loads fully. Every failure is fetch-scoped — nothing here may tear down the
 * carrier connection.
 */

import { open, stat } from 'node:fs/promises'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { BLOB_CHUNK_BYTES, BLOB_TRANSFER_ID_PATTERN } from './blob-transfer.ts'

/** Fetch-scoped failure codes; the wire layer maps them onto the proto vocabulary. */
export type BlobFetchFailureCode =
  | 'invalid-request'
  | 'fetch-conflict'
  | 'too-many-fetches'
  | 'unknown-fetch'
  | 'unauthorized'
  | 'content-too-large'
  | 'offset-out-of-range'
  | 'source-changed'

/** A fetch-scoped failure carrying a stable machine-readable code. */
export class BlobFetchError extends Error {
  /**
   * @param code Stable machine-readable failure code.
   * @param message Operator-facing detail; never blob content.
   */
  constructor(
    readonly code: BlobFetchFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'BlobFetchError'
  }
}

/** Download source: a timeline image or a truncated artifact's full content. */
export type BlobFetchSource =
  | {
    /** Timeline image; `sessionId` is the session-log-reference proof domain. */
    kind: 'attachment'
    attachmentId: string
    sessionId: string
  }
  | {
    /** Truncated artifact full content; the registry resolves id→path internally. */
    kind: 'artifact'
    artifactId: string
    sessionId: string
  }

/** Open request: the client-minted fetch id plus the source to prove and serve. */
export interface BlobFetchOpenRequest {
  /** Client-minted fetch id matching the transfer-id pattern. */
  fetchId: string
  /** Source to resolve and authorize. */
  source: BlobFetchSource
}

/** Content facts established at open; the client cross-checks its projection declarations. */
export interface BlobFetchOpened {
  /** Total content bytes as observed at open. */
  totalBytes: number
  /** Content digest when the source is content-addressed (attachments: the id itself). */
  sha256Hex?: string
  /** Verified media type for attachments. */
  mediaType?: string
}

/** One served chunk; `complete` marks the final offset. */
export interface BlobFetchChunk {
  /** The offset this chunk starts at (echo of the request). */
  offset: number
  /** Chunk payload; empty only when offset equals the total. */
  data: Uint8Array
  /** True when the chunk reaches the end of the declared content. */
  complete: boolean
}

/** Artifact resolution result: the Host-internal path; the client never supplies it. */
export interface ResolvedArtifactSource {
  /** Registry-resolved filesystem path. */
  path: string
}

/** Fully-resolved fetch-server behavior; built by {@link resolveBlobFetchSpec}. */
export interface BlobFetchSpec {
  /** Simultaneously open fetch sessions across all devices. */
  maxFetches: number
  /** Idle fetch sessions older than this are swept (their handles closed). */
  fetchTtlMs: number
  /** Largest servable blob in bytes. */
  maxBlobBytes: number
  /** Clock, injectable for deterministic tests. */
  now: () => number
  /**
   * Attachment ACL: return the durable ref when the given session's log
   * references this attachment id; `undefined` otherwise.
   * @param attachmentId Content-addressed attachment id (`sha256:<hex>`).
   * @param sessionId Session the fetch claims as its reference proof.
   * @returns The referenced ref, or `undefined` when unauthorized or unknown.
   */
  resolveAttachment: (attachmentId: string, sessionId: string) => Promise<ImageAttachmentRef | undefined>
  /**
   * Read the verified bytes for an authorized ref (`ctx.attachments.readImage`).
   * @param ref The ref {@link BlobFetchSpec.resolveAttachment} returned.
   * @returns The verified encoded bytes.
   */
  readAttachment: (ref: ImageAttachmentRef) => Promise<Uint8Array>
  /**
   * Artifact ACL: return the registry-resolved path when the artifact belongs
   * to the given session; `undefined` otherwise.
   * @param artifactId Registry artifact id.
   * @param sessionId Session the fetch claims as its reference proof.
   * @returns The resolved path, or `undefined` when unauthorized or unknown.
   */
  resolveArtifact: (artifactId: string, sessionId: string) => Promise<ResolvedArtifactSource | undefined>
}

/** Fetch-server construction request; the three resolver callbacks are required. */
export interface BlobFetchSpecRequest {
  /** Simultaneously open fetch sessions across all devices. @default 4 */
  maxFetches?: number
  /** Idle fetch sessions older than this are swept. @default 3600000 (1 h) */
  fetchTtlMs?: number
  /** Largest servable blob in bytes. @default 104857600 (100 MiB) */
  maxBlobBytes?: number
  /** Clock, injectable for deterministic tests. @default Date.now */
  now?: () => number
  /** Attachment ACL; see {@link BlobFetchSpec.resolveAttachment}. */
  resolveAttachment: (attachmentId: string, sessionId: string) => Promise<ImageAttachmentRef | undefined>
  /** Attachment byte reader; see {@link BlobFetchSpec.readAttachment}. */
  readAttachment: (ref: ImageAttachmentRef) => Promise<Uint8Array>
  /** Artifact ACL; see {@link BlobFetchSpec.resolveArtifact}. */
  resolveArtifact: (artifactId: string, sessionId: string) => Promise<ResolvedArtifactSource | undefined>
}

/**
 * Resolve fetch-server behavior explicitly (no hidden defaults inside the server).
 * @param request Construction request with optional bounds.
 * @returns The fully-resolved fetch-server spec.
 */
export function resolveBlobFetchSpec(request: BlobFetchSpecRequest): BlobFetchSpec {
  return {
    maxFetches: request.maxFetches ?? 4,
    fetchTtlMs: request.fetchTtlMs ?? 3_600_000,
    maxBlobBytes: request.maxBlobBytes ?? 104_857_600,
    now: request.now ?? Date.now,
    resolveAttachment: request.resolveAttachment,
    readAttachment: request.readAttachment,
    resolveArtifact: request.resolveArtifact,
  }
}

/** Offset-addressed fetch server; one instance per Host, devices share the budget. */
export interface BlobFetchServer {
  /**
   * Prove the source ACL and pin the content facts for a fetch session.
   * Re-opening with the identical source returns the same facts; a differing
   * source under the same fetch id conflicts.
   * @param request Fetch id plus source to prove.
   * @returns The content facts the client cross-checks against its projection.
   */
  open(request: BlobFetchOpenRequest): Promise<BlobFetchOpened>
  /**
   * Serve one contiguous chunk. `offset` may continue anywhere inside the
   * declared content (the client resumes by its durable cursor); `maxBytes`
   * is bounded by the frame budget.
   * @param fetchId Fetch session to serve from.
   * @param offset Byte offset to start at.
   * @param maxBytes Largest payload the caller accepts.
   * @returns The chunk and whether it completes the content.
   */
  chunk(fetchId: string, offset: number, maxBytes: number): Promise<BlobFetchChunk>
  /**
   * Close a fetch session and release its handle. Unknown ids are a no-op.
   * @param fetchId Fetch session to close.
   */
  close(fetchId: string): Promise<void>
  /** Sweep fetch sessions idle beyond the configured TTL. */
  sweep(): Promise<void>
  /** Close every fetch session; called during plugin disposal. */
  dispose(): Promise<void>
}

const ATTACHMENT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/
const MAX_SOURCE_ID_BYTES = 512

interface FetchSession {
  /** Canonical source description; a re-open must match it exactly. */
  sourceKey: string
  totalBytes: number
  sha256Hex?: string
  mediaType?: string
  /** Read `length` bytes starting at `offset`; attachment sessions slice memory, artifact sessions pread. */
  readSlice: (offset: number, length: number) => Promise<Uint8Array>
  /** Release the payload resource (artifact sessions close their handle). */
  release?: () => Promise<void>
  lastActivityMs: number
}

/**
 * Create the fetch server. Resolution callbacks are invoked once per open, so
 * a multi-hundred-chunk artifact download proves its ACL exactly once.
 * @param spec Fully-resolved fetch-server behavior.
 * @returns The ready fetch server.
 */
export function createBlobFetchServer(spec: BlobFetchSpec): BlobFetchServer {
  const sessions = new Map<string, FetchSession>()

  function sourceKey(source: BlobFetchSource): string {
    return source.kind === 'attachment'
      ? `attachment:${source.attachmentId}:${source.sessionId}`
      : `artifact:${source.artifactId}:${source.sessionId}`
  }

  function validateOpen(request: BlobFetchOpenRequest): void {
    if (!BLOB_TRANSFER_ID_PATTERN.test(request.fetchId)) {
      throw new BlobFetchError('invalid-request', 'fetch id must be 16..64 lowercase hex characters')
    }
    const source = request.source
    if (source.sessionId.length === 0 || new TextEncoder().encode(source.sessionId).length > MAX_SOURCE_ID_BYTES) {
      throw new BlobFetchError('invalid-request', 'session id must be non-empty and bounded')
    }
    if (source.kind === 'attachment') {
      if (!ATTACHMENT_ID_PATTERN.test(source.attachmentId)) {
        throw new BlobFetchError('invalid-request', 'attachment id must be a content-addressed sha256 reference')
      }
    } else if (
      source.artifactId.length === 0 ||
      new TextEncoder().encode(source.artifactId).length > MAX_SOURCE_ID_BYTES
    ) {
      throw new BlobFetchError('invalid-request', 'artifact id must be non-empty and bounded')
    }
  }

  async function release(session: FetchSession): Promise<void> {
    const releasePayload = session.release
    delete session.release
    await releasePayload?.()
  }

  async function openAttachment(
    source: Extract<BlobFetchSource, { kind: 'attachment' }>,
  ): Promise<FetchSession> {
    const ref = await spec.resolveAttachment(source.attachmentId, source.sessionId)
    if (ref === undefined) {
      throw new BlobFetchError('unauthorized', 'the session does not reference this attachment')
    }
    const data = await spec.readAttachment(ref)
    if (data.length < 1) {
      throw new BlobFetchError('invalid-request', 'referenced attachment is empty')
    }
    if (data.length > spec.maxBlobBytes) {
      throw new BlobFetchError('content-too-large', 'referenced attachment exceeds the fetch ceiling')
    }
    return {
      sourceKey: sourceKey(source),
      totalBytes: data.length,
      sha256Hex: source.attachmentId.slice('sha256:'.length),
      mediaType: ref.mediaType,
      readSlice: (offset, length) => Promise.resolve(data.subarray(offset, offset + length)),
      lastActivityMs: spec.now(),
    }
  }

  async function openArtifact(
    source: Extract<BlobFetchSource, { kind: 'artifact' }>,
  ): Promise<FetchSession> {
    const resolved = await spec.resolveArtifact(source.artifactId, source.sessionId)
    if (resolved === undefined) {
      throw new BlobFetchError('unauthorized', 'the session does not reference this artifact')
    }
    const observed = await stat(resolved.path)
    if (observed.size < 1) {
      throw new BlobFetchError('invalid-request', 'referenced artifact is empty')
    }
    if (observed.size > spec.maxBlobBytes) {
      throw new BlobFetchError('content-too-large', 'referenced artifact exceeds the fetch ceiling')
    }
    const handle = await open(resolved.path, 'r')
    return {
      sourceKey: sourceKey(source),
      totalBytes: observed.size,
      readSlice: async (offset, length) => {
        const buffer = new Uint8Array(length)
        let read = 0
        while (read < length) {
          const { bytesRead } = await handle.read(buffer, read, length - read, offset + read)
          if (bytesRead === 0) {
            throw new BlobFetchError('source-changed', 'artifact shrank after the fetch was opened; re-open to re-declare')
          }
          read += bytesRead
        }
        return buffer
      },
      release: async () => {
        await handle.close()
      },
      lastActivityMs: spec.now(),
    }
  }

  function factsOf(session: FetchSession): BlobFetchOpened {
    const opened: BlobFetchOpened = { totalBytes: session.totalBytes }
    if (session.sha256Hex !== undefined) opened.sha256Hex = session.sha256Hex
    if (session.mediaType !== undefined) opened.mediaType = session.mediaType
    return opened
  }

  return {
    async open(request) {
      validateOpen(request)
      const key = sourceKey(request.source)
      const existing = sessions.get(request.fetchId)
      if (existing !== undefined) {
        if (existing.sourceKey !== key) {
          throw new BlobFetchError('fetch-conflict', 'fetch id already serves a different source')
        }
        existing.lastActivityMs = spec.now()
        return factsOf(existing)
      }
      if (sessions.size >= spec.maxFetches) {
        throw new BlobFetchError('too-many-fetches', 'the fetch session budget is exhausted; close or let sessions expire')
      }
      const session = request.source.kind === 'attachment'
        ? await openAttachment(request.source)
        : await openArtifact(request.source)
      sessions.set(request.fetchId, session)
      return factsOf(session)
    },

    async chunk(fetchId, offset, maxBytes) {
      const session = sessions.get(fetchId)
      if (session === undefined) {
        throw new BlobFetchError('unknown-fetch', 'fetch session is unknown, expired, or closed')
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes)) {
        throw new BlobFetchError('invalid-request', 'offset and maxBytes must be safe integers')
      }
      if (maxBytes < 1 || maxBytes > BLOB_CHUNK_BYTES) {
        throw new BlobFetchError('invalid-request', `maxBytes must be within 1..${BLOB_CHUNK_BYTES}`)
      }
      if (offset > session.totalBytes) {
        throw new BlobFetchError('offset-out-of-range', 'offset exceeds the declared content')
      }
      session.lastActivityMs = spec.now()
      const end = Math.min(offset + maxBytes, session.totalBytes)
      const data = await session.readSlice(offset, end - offset)
      return { offset, data, complete: end === session.totalBytes }
    },

    async close(fetchId) {
      const session = sessions.get(fetchId)
      if (session === undefined) return
      sessions.delete(fetchId)
      await release(session)
    },

    async sweep() {
      const cutoff = spec.now() - spec.fetchTtlMs
      for (const [fetchId, session] of [...sessions]) {
        if (session.lastActivityMs <= cutoff) {
          sessions.delete(fetchId)
          await release(session)
        }
      }
    },

    async dispose() {
      for (const [fetchId, session] of [...sessions]) {
        sessions.delete(fetchId)
        await release(session)
      }
    },
  }
}
