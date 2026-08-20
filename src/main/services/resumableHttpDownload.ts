import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

export type ResumableDownloadProgress = {
  percent: number
  bytesPerSecond: number
  transferredBytes: number
  totalBytes: number
}

export type ResumableDownloadFetchInit = {
  headers?: Record<string, string>
  signal?: AbortSignal
}

export type ResumableDownloadResponse = {
  ok: boolean
  status: number
  headers: {
    get: (name: string) => string | null
  }
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | Readable | null
}

export type ResumableDownloadFetch = (
  url: string,
  init?: ResumableDownloadFetchInit
) => Promise<ResumableDownloadResponse>

export type ResumableDownloadParams = {
  url: string
  destinationPath: string
  expectedSize?: number
  sha512?: string | null
  sha256?: string | null
  headers?: Record<string, string>
  signal?: AbortSignal
  idleTimeoutMs?: number
  maxAttempts?: number
  retryDelayMs?: number
  onProgress?: (payload: ResumableDownloadProgress) => void
}

const DEFAULT_IDLE_TIMEOUT_MS = 120 * 1000
const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_RETRY_DELAY_MS = 1000

export class ResumableDownloadAbortError extends Error {
  constructor(message = '下载已取消') {
    super(message)
    this.name = 'AbortError'
  }
}

export class ResumableDownloadChecksumError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResumableDownloadChecksumError'
  }
}

export class ResumableDownloadHttpError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'ResumableDownloadHttpError'
    this.statusCode = statusCode
  }
}

export const createResumableDownloadCacheKey = (input: {
  url: string
  sha512?: string | null
  sha256?: string | null
}): string => {
  const identity = String(input.sha512 || input.sha256 || input.url || '').trim()
  return createHash('sha256')
    .update(identity || 'unknown')
    .digest('hex')
}

export const resolveSha512Encoding = (sha512: string): 'hex' | 'base64' =>
  sha512.length === 128 && !sha512.includes('+') && !sha512.includes('Z') && !sha512.includes('=')
    ? 'hex'
    : 'base64'

export const shouldRetryResumableDownload = (error: unknown): boolean => {
  if (error instanceof ResumableDownloadAbortError) return false
  if (error instanceof ResumableDownloadChecksumError) return false
  if (error instanceof ResumableDownloadHttpError) {
    if ([401, 404, 410, 451].includes(error.statusCode)) return false
    if (error.statusCode >= 400 && error.statusCode < 500) {
      return error.statusCode === 403 || error.statusCode === 408 || error.statusCode === 429
    }
  }
  return true
}

const createRangeHeader = (start: number) => `bytes=${start}-`

const isGoneHttpStatus = (status: number) => status === 404 || status === 410

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms))
    timer.unref?.()
  })

const getFileSize = async (targetPath: string) => {
  try {
    const stat = await fs.stat(targetPath)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

const cancelResponseBody = async (response: ResumableDownloadResponse) => {
  const body = response.body as { cancel?: () => Promise<void> } | null
  try {
    await body?.cancel?.()
  } catch {}
}

const parseContentRangeTotal = (contentRange: string): number => {
  const match = contentRange.trim().match(/^bytes\s+\d+-\d+\/(\d+|\*)/i)
  if (!match || match[1] === '*') return 0
  const total = Number(match[1])
  return Number.isFinite(total) && total > 0 ? total : 0
}

const parseContentRangeStart = (contentRange: string): number | null => {
  const match = contentRange.trim().match(/^bytes\s+(\d+)-/i)
  if (!match) return null
  const start = Number(match[1])
  return Number.isFinite(start) && start >= 0 ? start : null
}

const toNodeReadable = (body: NonNullable<ResumableDownloadResponse['body']>): Readable => {
  if (body instanceof Readable) return body
  return Readable.fromWeb(body as unknown as NodeReadableStream)
}

const resolveHashEncoding = (params: Pick<ResumableDownloadParams, 'sha512' | 'sha256'>) => {
  const sha512 = String(params.sha512 || '').trim()
  if (sha512) {
    return {
      algorithm: 'sha512' as const,
      encoding: resolveSha512Encoding(sha512),
      expected: sha512
    }
  }
  const sha256 = String(params.sha256 || '').trim()
  if (sha256) {
    return {
      algorithm: 'sha256' as const,
      encoding: 'hex' as const,
      expected: sha256.toLowerCase()
    }
  }
  return null
}

const hashFile = async (
  filePath: string,
  algorithm: 'sha512' | 'sha256',
  encoding: 'hex' | 'base64'
) => {
  const hash = createHash(algorithm)
  const reader = createReadStream(filePath)
  for await (const chunk of reader) {
    hash.update(chunk)
  }
  const digest = hash.digest(encoding)
  return encoding === 'hex' ? digest.toLowerCase() : digest
}

const matchesChecksum = async (
  filePath: string,
  params: Pick<ResumableDownloadParams, 'sha512' | 'sha256'>
) => {
  const spec = resolveHashEncoding(params)
  if (!spec) return true
  const actual = await hashFile(filePath, spec.algorithm, spec.encoding)
  if (spec.encoding === 'hex') {
    return actual === spec.expected.toLowerCase()
  }
  return actual === spec.expected
}

const emitProgress = (
  onProgress: ResumableDownloadParams['onProgress'],
  transferredBytes: number,
  totalBytes: number,
  startedAt: number,
  sessionBytes: number
) => {
  const percent =
    totalBytes > 0 ? Math.max(0, Math.min(100, (transferredBytes / totalBytes) * 100)) : 0
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000)
  onProgress?.({
    percent,
    bytesPerSecond: sessionBytes / elapsedSeconds,
    transferredBytes,
    totalBytes
  })
}

const closeWriter = async (writer: ReturnType<typeof createWriteStream> | null) => {
  if (!writer || writer.destroyed) return
  await new Promise<void>((resolve) => {
    const finish = () => resolve()
    writer.once('finish', finish)
    writer.once('close', finish)
    writer.once('error', finish)
    writer.end()
  })
}

const createIdleController = (idleTimeoutMs: number, externalSignal?: AbortSignal) => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason)
    }
  }

  const refresh = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      abort(new ResumableDownloadHttpError(408, '下载空闲超时'))
    }, idleTimeoutMs)
    timer.unref?.()
  }

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  if (externalSignal) {
    if (externalSignal.aborted) {
      abort(new ResumableDownloadAbortError())
    } else {
      externalSignal.addEventListener(
        'abort',
        () => {
          abort(new ResumableDownloadAbortError())
        },
        { once: true }
      )
    }
  }

  refresh()
  return {
    signal: controller.signal,
    refresh,
    clear,
    abort
  }
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (!signal?.aborted) return
  throw new ResumableDownloadAbortError()
}

const normalizeHeaders = (headers?: Record<string, string>): Record<string, string> => {
  if (!headers) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!key || value == null) continue
    if (key.toLowerCase() === 'range') continue
    result[key] = value
  }
  return result
}

type DownloadSession = {
  fetch: ResumableDownloadFetch
  url: string
  destinationPath: string
  sha512?: string | null
  sha256?: string | null
  headers: Record<string, string>
  signal?: AbortSignal
  idleTimeoutMs: number
  onProgress?: (payload: ResumableDownloadProgress) => void
  knownTotal: number
}

const verifyCompletedFile = async (session: DownloadSession, totalBytes: number) => {
  const size = await getFileSize(session.destinationPath)
  if (totalBytes > 0 && size !== totalBytes) {
    throw new Error(`download size mismatch: expected=${totalBytes} actual=${size}`)
  }
  const spec = resolveHashEncoding(session)
  if (!spec) return
  const actual = await hashFile(session.destinationPath, spec.algorithm, spec.encoding)
  const expected = spec.encoding === 'hex' ? spec.expected.toLowerCase() : spec.expected
  if (actual !== expected) {
    await fs.rm(session.destinationPath, { force: true }).catch(() => {})
    throw new ResumableDownloadChecksumError(
      `download ${spec.algorithm} mismatch: expected=${spec.expected} actual=${actual}`
    )
  }
}

export const downloadedFileMatchesChecksum = async (
  filePath: string,
  checksum: Pick<ResumableDownloadParams, 'sha512' | 'sha256'>
) => matchesChecksum(filePath, checksum)

const isReusableCompleteFile = (session: DownloadSession, existingBytes: number) =>
  existingBytes > 0 && session.knownTotal > 0 && existingBytes === session.knownTotal

const downloadResumableFileOnce = async (session: DownloadSession) => {
  throwIfAborted(session.signal)
  let existingBytes = await getFileSize(session.destinationPath)
  if (session.knownTotal > 0 && existingBytes > session.knownTotal) {
    await fs.rm(session.destinationPath, { force: true }).catch(() => {})
    existingBytes = 0
  }

  if (isReusableCompleteFile(session, existingBytes)) {
    await verifyCompletedFile(session, session.knownTotal || existingBytes)
    emitProgress(
      session.onProgress,
      existingBytes,
      session.knownTotal || existingBytes,
      Date.now(),
      0
    )
    return session.knownTotal || existingBytes
  }

  const idle = createIdleController(session.idleTimeoutMs, session.signal)
  let writer: ReturnType<typeof createWriteStream> | null = null
  const startedAt = Date.now()
  emitProgress(session.onProgress, existingBytes, session.knownTotal, startedAt, 0)

  try {
    let response: ResumableDownloadResponse | null = null
    for (let rangeAttempt = 0; rangeAttempt < 2; rangeAttempt += 1) {
      throwIfAborted(session.signal)
      const requestHeaders = { ...session.headers }
      if (existingBytes > 0) {
        requestHeaders.Range = createRangeHeader(existingBytes)
      }
      response = await session.fetch(session.url, {
        headers: requestHeaders,
        signal: idle.signal
      })

      if (existingBytes > 0 && response.status === 416) {
        await cancelResponseBody(response)
        if (
          resolveHashEncoding(session) &&
          !(await matchesChecksum(session.destinationPath, session))
        ) {
          await fs.rm(session.destinationPath, { force: true }).catch(() => {})
          existingBytes = 0
          continue
        }
        await verifyCompletedFile(session, existingBytes)
        emitProgress(session.onProgress, existingBytes, existingBytes, startedAt, 0)
        return existingBytes
      }

      if (existingBytes > 0 && response.status === 200) {
        await fs.rm(session.destinationPath, { force: true }).catch(() => {})
        existingBytes = 0
        break
      }

      if (existingBytes > 0 && response.status !== 206) {
        await cancelResponseBody(response)
        if (isGoneHttpStatus(response.status)) {
          await fs.rm(session.destinationPath, { force: true }).catch(() => {})
        }
        throw new ResumableDownloadHttpError(
          response.status,
          `resume range request failed: HTTP ${response.status}`
        )
      }
      break
    }

    if (!response || !response.ok || !response.body) {
      const status = response?.status || 0
      if (response) await cancelResponseBody(response)
      if (isGoneHttpStatus(status)) {
        await fs.rm(session.destinationPath, { force: true }).catch(() => {})
      }
      throw new ResumableDownloadHttpError(status, `download failed: HTTP ${status}`)
    }

    const contentRange = response.headers.get('content-range') || ''
    const rangeStart = existingBytes > 0 ? parseContentRangeStart(contentRange) : 0
    if (existingBytes > 0 && rangeStart != null && rangeStart !== existingBytes) {
      await cancelResponseBody(response)
      await fs.rm(session.destinationPath, { force: true }).catch(() => {})
      throw new Error(`resume range start mismatch: expected=${existingBytes} actual=${rangeStart}`)
    }

    const totalFromRange = parseContentRangeTotal(contentRange)
    const remainingLength = Math.max(0, Number(response.headers.get('content-length') || 0) || 0)
    const totalBytes =
      totalFromRange ||
      session.knownTotal ||
      (existingBytes > 0 && remainingLength > 0 ? existingBytes + remainingLength : remainingLength)
    session.knownTotal = totalBytes

    writer = createWriteStream(session.destinationPath, {
      flags: existingBytes > 0 ? 'a' : 'w'
    })
    let receivedBytes = 0
    const readable = toNodeReadable(response.body)
    for await (const chunk of readable) {
      throwIfAborted(session.signal)
      idle.refresh()
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      receivedBytes += buffer.byteLength
      if (!writer.write(buffer)) {
        await once(writer, 'drain')
      }
      emitProgress(
        session.onProgress,
        existingBytes + receivedBytes,
        totalBytes,
        startedAt,
        receivedBytes
      )
    }

    await closeWriter(writer)
    writer = null

    const finalSize = await getFileSize(session.destinationPath)
    if (totalBytes > 0 && finalSize !== totalBytes) {
      throw new Error(`download size mismatch: expected=${totalBytes} actual=${finalSize}`)
    }
    await verifyCompletedFile(session, totalBytes || finalSize)
    emitProgress(session.onProgress, finalSize, totalBytes || finalSize, startedAt, receivedBytes)
    return totalBytes || finalSize
  } catch (error) {
    await closeWriter(writer)
    if (session.signal?.aborted) {
      throw new ResumableDownloadAbortError()
    }
    if (idle.signal.aborted && error instanceof ResumableDownloadHttpError) {
      throw error
    }
    if (idle.signal.aborted) {
      throw new ResumableDownloadHttpError(408, '下载空闲超时')
    }
    throw error
  } finally {
    idle.clear()
  }
}

export const downloadResumableFile = async (
  params: ResumableDownloadParams,
  deps: { fetch: ResumableDownloadFetch }
): Promise<void> => {
  const maxAttempts = Math.max(1, params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const retryDelayMs = Math.max(0, params.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
  const session: DownloadSession = {
    fetch: deps.fetch,
    url: params.url,
    destinationPath: params.destinationPath,
    sha512: params.sha512,
    sha256: params.sha256,
    headers: normalizeHeaders(params.headers),
    signal: params.signal,
    idleTimeoutMs: Math.max(1, params.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS),
    onProgress: params.onProgress,
    knownTotal: Math.max(0, params.expectedSize || 0)
  }

  await fs.mkdir(path.dirname(params.destinationPath), { recursive: true })

  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      throwIfAborted(params.signal)
      await downloadResumableFileOnce(session)
      return
    } catch (error) {
      lastError = error
      if (!shouldRetryResumableDownload(error) || attempt === maxAttempts - 1) {
        throw error
      }
      if (retryDelayMs > 0) {
        await delay(retryDelayMs * (attempt + 1))
      }
    }
  }
  throw lastError
}
