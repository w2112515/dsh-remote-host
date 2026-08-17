/**
 * Blob transfer assembler (S-blob, ADR-005): bounded, resumable, verify-then-commit
 * chunk assembly for the remote carrier's blob logical channel. Chunks arrive
 * offset-addressed over the authenticated carrier; this module stages them under
 * a private directory, resumes by cursor after reconnect or Host restart, and
 * commits only after the declared size and SHA-256 both verify. Every failure is
 * transfer-scoped — nothing here may tear down the carrier connection.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Largest chunk payload the carrier accepts in one frame: the Noise plaintext
 * ceiling (65,519) minus envelope headroom. Protocol constant, not a tunable.
 */
export const BLOB_CHUNK_BYTES = 49_152

/** Wire-safe transfer id: lowercase hex the client mints per transfer. */
export const BLOB_TRANSFER_ID_PATTERN = /^[0-9a-f]{16,64}$/

/** Lowercase hex SHA-256 digest of the full blob content. */
export const BLOB_SHA256_PATTERN = /^[0-9a-f]{64}$/

/** Transfer-scoped failure codes; the wire layer maps them onto the proto enum. */
export type BlobTransferFailureCode =
  | 'invalid-declaration'
  | 'declaration-conflict'
  | 'unknown-transfer'
  | 'too-many-transfers'
  | 'chunk-too-large'
  | 'offset-mismatch'
  | 'size-mismatch'
  | 'digest-mismatch'
  | 'commit-rejected'

/**
 * A transfer-scoped failure. Carrying `code` lets the carrier answer honestly
 * without inspecting messages; `resumeOffset` tells the sender where to continue
 * after `offset-mismatch`.
 */
export class BlobTransferError extends Error {
  /**
   * @param code Stable machine-readable failure code.
   * @param message Operator-facing detail; never blob content.
   * @param resumeOffset Current contiguous cursor when the sender must resume.
   */
  constructor(
    readonly code: BlobTransferFailureCode,
    message: string,
    readonly resumeOffset?: number,
  ) {
    super(message)
    this.name = 'BlobTransferError'
  }
}

/** Content facts the sender declares at begin; verified before commit. */
export interface BlobTransferDeclaration {
  /** Client-minted transfer id matching {@link BLOB_TRANSFER_ID_PATTERN}. */
  transferId: string
  /** Declared SHA-256 of the full content matching {@link BLOB_SHA256_PATTERN}. */
  sha256Hex: string
  /** Declared total content bytes; `1..maxBlobBytes`. */
  totalBytes: number
  /** Declared media type, passed through to commit for validation. */
  mediaType?: string
}

/** Staged, size-and-digest-verified blob handed to the commit callback. */
export interface BlobStagedFile {
  /** Private staging path; valid only inside the commit call. */
  path: string
  /** The verified declaration the content matched. */
  declaration: BlobTransferDeclaration
}

/** Fully-resolved assembler behavior; built by {@link resolveBlobTransferSpec}. */
export interface BlobTransferSpec {
  /** Private staging directory; created `0700` when missing. */
  stagingDir: string
  /** Largest acceptable declared blob in bytes. */
  maxBlobBytes: number
  /** Incomplete transfers older than this are swept. */
  transferTtlMs: number
  /** Simultaneously incomplete transfers across all devices. */
  maxActiveTransfers: number
  /** Clock, injectable for deterministic tests. */
  now: () => number
  /**
   * Owner-side commit (for images: `ctx.attachments.saveImage`, which
   * re-validates raster content and dedups to the canonical id). Receiving a
   * call means size and digest already verified. A throw rejects the transfer.
   * @param staged Verified staged file and its declaration.
   * @returns The owner-side blob reference (for images: `attachmentId`).
   */
  commit: (staged: BlobStagedFile) => Promise<string>
}

/** Assembler construction request; `stagingDir` and `commit` are required. */
export interface BlobTransferSpecRequest {
  /** Private staging directory; created `0700` when missing. */
  stagingDir: string
  /** Largest acceptable declared blob in bytes. @default 104857600 (100 MiB) */
  maxBlobBytes?: number
  /** Incomplete transfers older than this are swept. @default 86400000 (24 h) */
  transferTtlMs?: number
  /** Simultaneously incomplete transfers across all devices. @default 2 */
  maxActiveTransfers?: number
  /** Clock, injectable for deterministic tests. @default Date.now */
  now?: () => number
  /** Owner-side commit; see {@link BlobTransferSpec.commit}. */
  commit: (staged: BlobStagedFile) => Promise<string>
}

/**
 * Resolve assembler behavior explicitly (no hidden defaults inside the
 * assembler itself).
 * @param request Construction request with optional bounds.
 * @returns The fully-resolved assembler spec.
 */
export function resolveBlobTransferSpec(request: BlobTransferSpecRequest): BlobTransferSpec {
  return {
    stagingDir: request.stagingDir,
    maxBlobBytes: request.maxBlobBytes ?? 104_857_600,
    transferTtlMs: request.transferTtlMs ?? 86_400_000,
    maxActiveTransfers: request.maxActiveTransfers ?? 2,
    now: request.now ?? Date.now,
    commit: request.commit,
  }
}

/** Resume cursor returned by begin/chunk and expected by the sender. */
export interface BlobTransferCursor {
  /** Contiguous bytes durably staged so far; the next chunk must start here. */
  receivedBytes: number
}

interface ActiveTransfer {
  declaration: BlobTransferDeclaration
  receivedBytes: number
  lastActivityMs: number
}

interface DeclarationSidecar {
  sha256Hex: string
  totalBytes: number
  mediaType?: string
}

/**
 * Bounded chunk assembler. One instance per Host; devices share the active
 * budget. All public methods reject transfer-scoped mistakes with
 * {@link BlobTransferError} and never throw connection-level failures.
 */
export interface BlobTransferAssembler {
  /**
   * Open or resume a transfer. Re-beginning with the identical declaration
   * returns the durable cursor (across reconnects and Host restarts); a
   * differing declaration under the same id conflicts.
   * @param declaration Sender-declared content facts.
   * @returns The cursor the next chunk must continue from.
   */
  begin(declaration: BlobTransferDeclaration): Promise<BlobTransferCursor>
  /**
   * Append one contiguous chunk. `offset` must equal the current cursor;
   * a mismatch rejects with the cursor so the sender can resume.
   * @param transferId Transfer the chunk belongs to.
   * @param offset Sender-claimed cursor for this chunk.
   * @param data Chunk payload, `1..BLOB_CHUNK_BYTES`.
   * @returns The cursor after this chunk.
   */
  chunk(transferId: string, offset: number, data: Uint8Array): Promise<BlobTransferCursor>
  /**
   * Verify coverage and digest, commit to the owner, and drop the staging
   * files. Any failure deletes the transfer — M1 restarts failed transfers
   * whole (ADR-005), and the content-addressed commit dedups the re-upload.
   * @param transferId Transfer to finalize.
   * @returns The owner-side blob reference from the commit callback.
   */
  complete(transferId: string): Promise<{ blobId: string }>
  /**
   * Discard an incomplete transfer and its staging files. Unknown ids are a
   * no-op so abort is safe to repeat.
   * @param transferId Transfer to discard.
   */
  abort(transferId: string): Promise<void>
  /**
   * Resume query after reconnect: the durable cursor, or `undefined` when the
   * transfer is unknown (expired, aborted, or never begun).
   * @param transferId Transfer to inspect.
   * @returns The cursor when the transfer is still resumable.
   */
  status(transferId: string): Promise<BlobTransferCursor | undefined>
  /** Sweep incomplete transfers older than the configured TTL. */
  sweep(): Promise<void>
  /** Abort every incomplete transfer; called during plugin disposal. */
  dispose(): Promise<void>
}

/**
 * Create the assembler and sweep whatever an earlier process left behind.
 * @param spec Fully-resolved assembler behavior.
 * @returns The ready assembler.
 */
export async function createBlobTransferAssembler(spec: BlobTransferSpec): Promise<BlobTransferAssembler> {
  await mkdir(spec.stagingDir, { recursive: true, mode: 0o700 })
  const active = new Map<string, ActiveTransfer>()
  const partPath = (transferId: string) => join(spec.stagingDir, `${transferId}.part`)
  const sidecarPath = (transferId: string) => join(spec.stagingDir, `${transferId}.json`)

  async function removeStaging(transferId: string): Promise<void> {
    await rm(partPath(transferId), { force: true })
    await rm(sidecarPath(transferId), { force: true })
  }

  function validateDeclaration(declaration: BlobTransferDeclaration): void {
    if (!BLOB_TRANSFER_ID_PATTERN.test(declaration.transferId)) {
      throw new BlobTransferError('invalid-declaration', 'transfer id must be 16..64 lowercase hex characters')
    }
    if (!BLOB_SHA256_PATTERN.test(declaration.sha256Hex)) {
      throw new BlobTransferError('invalid-declaration', 'sha256 must be 64 lowercase hex characters')
    }
    if (!Number.isSafeInteger(declaration.totalBytes) || declaration.totalBytes < 1) {
      throw new BlobTransferError('invalid-declaration', 'total bytes must be a positive safe integer')
    }
    if (declaration.totalBytes > spec.maxBlobBytes) {
      throw new BlobTransferError(
        'invalid-declaration',
        `declared ${declaration.totalBytes} bytes exceeds the ${spec.maxBlobBytes} byte bound`,
      )
    }
  }

  function declarationsMatch(a: BlobTransferDeclaration, b: DeclarationSidecar): boolean {
    return a.sha256Hex === b.sha256Hex && a.totalBytes === b.totalBytes && a.mediaType === b.mediaType
  }

  async function load(transferId: string): Promise<ActiveTransfer | undefined> {
    const remembered = active.get(transferId)
    if (remembered !== undefined) return remembered
    let sidecar: DeclarationSidecar
    try {
      sidecar = JSON.parse(await readFile(sidecarPath(transferId), 'utf8')) as DeclarationSidecar
    } catch {
      return undefined // no sidecar: unknown, expired, or never begun
    }
    const staged = await stat(partPath(transferId)).catch(() => undefined)
    if (staged === undefined) {
      await removeStaging(transferId)
      return undefined // sidecar without content: an interrupted begin; no cursor to resume
    }
    const adopted: ActiveTransfer = {
      declaration: {
        transferId,
        sha256Hex: sidecar.sha256Hex,
        totalBytes: sidecar.totalBytes,
        ...(sidecar.mediaType === undefined ? {} : { mediaType: sidecar.mediaType }),
      },
      receivedBytes: staged.size,
      lastActivityMs: staged.mtimeMs,
    }
    active.set(transferId, adopted)
    return adopted
  }

  async function countActive(): Promise<number> {
    const entries = await readdir(spec.stagingDir)
    return entries.filter(entry => entry.endsWith('.json')).length
  }

  async function sweep(): Promise<void> {
    const cutoff = spec.now() - spec.transferTtlMs
    const entries = await readdir(spec.stagingDir)
    for (const entry of entries) {
      if (!entry.endsWith('.part') && !entry.endsWith('.json')) continue
      const path = join(spec.stagingDir, entry)
      /* v8 ignore next 3 -- readdir/stat race: the file vanishing between the
         two calls cannot be staged deterministically. */
      const staged = await stat(path).catch(() => undefined)
      if (staged === undefined) continue
      if (staged.mtimeMs <= cutoff) {
        const transferId = entry.slice(0, entry.lastIndexOf('.'))
        active.delete(transferId)
        await removeStaging(transferId)
      }
    }
  }

  await sweep()

  return {
    async begin(declaration) {
      validateDeclaration(declaration)
      const existing = await load(declaration.transferId)
      if (existing !== undefined) {
        if (!declarationsMatch(declaration, existing.declaration)) {
          throw new BlobTransferError(
            'declaration-conflict',
            'transfer id already stages different content; abort it or mint a new id',
            existing.receivedBytes,
          )
        }
        existing.lastActivityMs = spec.now()
        return { receivedBytes: existing.receivedBytes }
      }
      if (await countActive() >= spec.maxActiveTransfers) {
        throw new BlobTransferError('too-many-transfers', 'the active transfer budget is exhausted; finish or abort first')
      }
      await mkdir(spec.stagingDir, { recursive: true })
      const sidecar: DeclarationSidecar = {
        sha256Hex: declaration.sha256Hex,
        totalBytes: declaration.totalBytes,
        ...(declaration.mediaType === undefined ? {} : { mediaType: declaration.mediaType }),
      }
      try {
        await writeFile(sidecarPath(declaration.transferId), JSON.stringify(sidecar), { flag: 'wx', mode: 0o600 })
        await writeFile(partPath(declaration.transferId), new Uint8Array(0), { flag: 'wx', mode: 0o600 })
      } catch (error) {
        await removeStaging(declaration.transferId)
        throw new BlobTransferError(
          'declaration-conflict',
          /* v8 ignore next -- node:fs rejections are always Error; the String arm is defensive. */
          `transfer id could not be staged exclusively: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const started: ActiveTransfer = { declaration, receivedBytes: 0, lastActivityMs: spec.now() }
      active.set(declaration.transferId, started)
      return { receivedBytes: 0 }
    },

    async chunk(transferId, offset, data) {
      const state = await load(transferId)
      if (state === undefined) {
        throw new BlobTransferError('unknown-transfer', 'transfer is unknown, expired, or already finalized')
      }
      if (offset !== state.receivedBytes) {
        throw new BlobTransferError('offset-mismatch', 'chunk does not continue the staged cursor', state.receivedBytes)
      }
      if (data.length < 1) {
        throw new BlobTransferError('size-mismatch', 'chunk payload must not be empty', state.receivedBytes)
      }
      if (data.length > BLOB_CHUNK_BYTES) {
        throw new BlobTransferError('chunk-too-large', `chunk payload exceeds the ${BLOB_CHUNK_BYTES} byte frame bound`, state.receivedBytes)
      }
      if (state.receivedBytes + data.length > state.declaration.totalBytes) {
        throw new BlobTransferError('size-mismatch', 'chunk overruns the declared total', state.receivedBytes)
      }
      const handle = await open(partPath(transferId), 'a')
      try {
        await handle.write(data)
      } finally {
        await handle.close()
      }
      state.receivedBytes += data.length
      state.lastActivityMs = spec.now()
      return { receivedBytes: state.receivedBytes }
    },

    async complete(transferId) {
      const state = await load(transferId)
      if (state === undefined) {
        throw new BlobTransferError('unknown-transfer', 'transfer is unknown, expired, or already finalized')
      }
      if (state.receivedBytes !== state.declaration.totalBytes) {
        throw new BlobTransferError('size-mismatch', 'declared content is not fully staged', state.receivedBytes)
      }
      const path = partPath(transferId)
      const flush = await open(path, 'r+')
      try {
        await flush.sync()
      } finally {
        await flush.close()
      }
      const hash = createHash('sha256')
      for await (const block of createReadStream(path)) {
        hash.update(block as Uint8Array)
      }
      const digest = hash.digest('hex')
      if (digest !== state.declaration.sha256Hex) {
        await removeStaging(transferId)
        active.delete(transferId)
        throw new BlobTransferError('digest-mismatch', 'staged content does not match the declared sha256')
      }
      let blobId: string
      try {
        blobId = await spec.commit({ path, declaration: state.declaration })
      } catch (error) {
        await removeStaging(transferId)
        active.delete(transferId)
        throw new BlobTransferError(
          'commit-rejected',
          `the blob owner refused the verified content: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      await removeStaging(transferId)
      active.delete(transferId)
      return { blobId }
    },

    async abort(transferId) {
      active.delete(transferId)
      await removeStaging(transferId)
    },

    async status(transferId) {
      const state = await load(transferId)
      return state === undefined ? undefined : { receivedBytes: state.receivedBytes }
    },

    sweep,

    async dispose() {
      const entries = await readdir(spec.stagingDir).catch(() => [] as string[])
      for (const entry of entries) {
        if (!entry.endsWith('.part') && !entry.endsWith('.json')) continue
        const transferId = entry.slice(0, entry.lastIndexOf('.'))
        active.delete(transferId)
        await removeStaging(transferId)
      }
    },
  }
}
