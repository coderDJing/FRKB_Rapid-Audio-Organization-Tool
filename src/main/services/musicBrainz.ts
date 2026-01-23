import path = require('path')
import fs = require('fs-extra')
import { app } from 'electron'
import {
  IMusicBrainzMatch,
  IMusicBrainzSearchPayload,
  IMusicBrainzSuggestionParams,
  IMusicBrainzSuggestionResult
} from '../../types/globals'
import { ProxyAgent } from 'undici'
import { log } from '../log'
import { getSystemProxy } from '../utils'

const MUSICBRAINZ_BASE = 'https://musicbrainz.org/ws/2'
const COVER_ART_BASE = 'https://coverartarchive.org'
const REQUEST_TIMEOUT = 8000
const RELEASE_DETAIL_TIMEOUT = 15000
const MIN_INTERVAL_MS = 1100
const MAX_RETRIES = 3
const SEARCH_CACHE_TTL = 24 * 60 * 60 * 1000
const DETAIL_CACHE_TTL = 7 * 24 * 60 * 60 * 1000

// Proxy dispatcher will be initialized lazily after detecting system proxy
let proxyDispatcher: ProxyAgent | undefined
let proxyInitialized = false

async function ensureProxyInitialized(): Promise<void> {
  if (proxyInitialized) return
  proxyInitialized = true

  const proxyUrl = await getSystemProxy()
  if (proxyUrl) {
    proxyDispatcher = new ProxyAgent(proxyUrl)
  }
}

const appReady = app.isReady() ? Promise.resolve() : app.whenReady()
const cacheDirMap = new Map<'search' | 'detail', string>()
const memoryCache = new Map<string, { expiresAt: number; data: any }>()

interface QueueItem<T> {
  fn: () => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

const requestQueue: QueueItem<any>[] = []
let queueProcessing = false
let currentAbortController: AbortController | null = null

function scheduleRequest<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject })
    processQueue()
  })
}

function processQueue() {
  if (queueProcessing) return
  const item = requestQueue.shift()
  if (!item) return
  queueProcessing = true
  item
    .fn()
    .then((res) => item.resolve(res))
    .catch((err) => item.reject(err))
    .finally(() => {
      setTimeout(() => {
        queueProcessing = false
        processQueue()
      }, MIN_INTERVAL_MS)
    })
}

function getErrorCode(err: any) {
  if (!err) return ''
  if (typeof err.message === 'string' && err.message.trim()) return err.message.trim()
  if (typeof err.code === 'string' && err.code.trim()) return err.code.trim()
  return ''
}

function isRetriableError(err: any) {
  const code = getErrorCode(err)
  if (!code) return false
  if (code === 'MUSICBRAINZ_RATE_LIMITED' || code === 'MUSICBRAINZ_ABORTED') return false
  if (
    code === 'MUSICBRAINZ_EMPTY_QUERY' ||
    code === 'MUSICBRAINZ_INVALID_PARAMS' ||
    code === 'MUSICBRAINZ_RELEASE_NOT_FOUND' ||
    code === 'MUSICBRAINZ_RECORDING_NOT_IN_RELEASE'
  ) {
    return false
  }
  if (code.startsWith('MUSICBRAINZ_HTTP_') && !code.startsWith('MUSICBRAINZ_HTTP_5')) return false
  return (
    code === 'MUSICBRAINZ_NETWORK' ||
    code === 'MUSICBRAINZ_TIMEOUT' ||
    code === 'MUSICBRAINZ_UNAVAILABLE' ||
    code.startsWith('MUSICBRAINZ_HTTP_5')
  )
}

async function withRetry<T>(fn: () => Promise<T>, meta: { url: string; type: 'json' | 'buffer' }) {
  let lastError: any
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      log.info('[musicbrainz] retrying request', { url: meta.url, type: meta.type, attempt })
    }
    try {
      return await fn()
    } catch (err: any) {
      lastError = err
      const code = getErrorCode(err)
      const willRetry = attempt < MAX_RETRIES && isRetriableError(err)
      log.warn('[musicbrainz] request failed', {
        url: meta.url,
        type: meta.type,
        attempt,
        code,
        message: err?.message,
        willRetry
      })
      if (!willRetry) throw err
    }
  }
  throw lastError
}

async function ensureCacheDir(scope: 'search' | 'detail'): Promise<string> {
  const existing = cacheDirMap.get(scope)
  if (existing) return existing
  await appReady
  const dir = path.join(app.getPath('userData'), 'cache', 'musicbrainz', scope)
  await fs.ensureDir(dir)
  cacheDirMap.set(scope, dir)
  return dir
}

interface CacheEntry<T> {
  expiresAt: number
  data: T
}

function makeCacheKey(scope: 'search' | 'detail', key: string) {
  return `${scope}:${key}`
}

function encodeKey(key: string) {
  return Buffer.from(key)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

async function readCache<T>(scope: 'search' | 'detail', key: string): Promise<T | null> {
  const now = Date.now()
  const memoryKey = makeCacheKey(scope, key)
  const memEntry = memoryCache.get(memoryKey)
  if (memEntry && memEntry.expiresAt > now) {
    return memEntry.data as T
  }
  const dir = await ensureCacheDir(scope)
  const file = path.join(dir, `${encodeKey(key)}.json`)
  if (!(await fs.pathExists(file))) return null
  try {
    const entry = (await fs.readJson(file)) as CacheEntry<T>
    if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) {
      await fs.remove(file).catch(() => {})
      return null
    }
    memoryCache.set(memoryKey, entry)
    return entry.data
  } catch {
    await fs.remove(file).catch(() => {})
    return null
  }
}

async function writeCache<T>(
  scope: 'search' | 'detail',
  key: string,
  ttlMs: number,
  data: T
): Promise<void> {
  const expiresAt = Date.now() + ttlMs
  const dir = await ensureCacheDir(scope)
  const entry: CacheEntry<T> = { expiresAt, data }
  const file = path.join(dir, `${encodeKey(key)}.json`)
  memoryCache.set(makeCacheKey(scope, key), entry)
  await fs.writeJson(file, entry).catch(() => {})
}

function getUserAgent() {
  const version = app.getVersion()
  return `FRKB/${version} (https://coderDJing.github.io/FRKB_Rapid-Audio-Organization-Tool/)`
}

function mergeHeaders(extra?: HeadersInit): HeadersInit {
  const base: Record<string, string> = {
    'User-Agent': getUserAgent()
  }
  if (extra) {
    if (Array.isArray(extra)) {
      for (const [k, v] of extra) base[k] = v as string
    } else if (extra instanceof Headers) {
      extra.forEach((value, key) => {
        base[key] = value
      })
    } else {
      Object.assign(base, extra)
    }
  }
  return base
}

async function requestJson<T>(url: string, headers?: HeadersInit, timeoutMs?: number): Promise<T> {
  await ensureProxyInitialized()
  const attempt = () =>
    scheduleRequest(async () => {
      const controller = new AbortController()
      currentAbortController = controller
      let abortedByTimeout = false
      const timer = setTimeout(() => {
        abortedByTimeout = true
        controller.abort()
      }, timeoutMs ?? REQUEST_TIMEOUT)
      try {
        const init: RequestInit & { dispatcher?: any } = {
          headers: mergeHeaders({
            Accept: 'application/json',
            ...headers
          }),
          signal: controller.signal
        }
        if (proxyDispatcher) init.dispatcher = proxyDispatcher
        const res = await fetch(url, init)
        if (res.status === 429) throw new Error('MUSICBRAINZ_RATE_LIMITED')
        if (res.status === 503) throw new Error('MUSICBRAINZ_UNAVAILABLE')
        if (!res.ok) throw new Error(`MUSICBRAINZ_HTTP_${res.status}`)
        return (await res.json()) as T
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          if (abortedByTimeout) throw new Error('MUSICBRAINZ_TIMEOUT')
          throw new Error('MUSICBRAINZ_ABORTED')
        }
        if (err?.code === 'ECONNRESET' || err?.message?.includes('fetch failed')) {
          log.warn('[musicbrainz] request JSON network error', {
            url,
            code: err?.code,
            message: err?.message
          })
          throw new Error('MUSICBRAINZ_NETWORK')
        }
        throw err
      } finally {
        clearTimeout(timer)
        if (currentAbortController === controller) {
          currentAbortController = null
        }
      }
    })
  return withRetry(attempt, { url, type: 'json' })
}

async function requestBuffer(
  url: string,
  headers?: HeadersInit,
  timeoutMs?: number
): Promise<{
  mime: string
  buffer: Buffer
} | null> {
  await ensureProxyInitialized()
  const attempt = () =>
    scheduleRequest(async () => {
      const controller = new AbortController()
      currentAbortController = controller
      let abortedByTimeout = false
      const timer = setTimeout(() => {
        abortedByTimeout = true
        controller.abort()
      }, timeoutMs ?? REQUEST_TIMEOUT)
      try {
        const init: RequestInit & { dispatcher?: any } = {
          headers: mergeHeaders(headers),
          signal: controller.signal
        }
        if (proxyDispatcher) init.dispatcher = proxyDispatcher
        const res = await fetch(url, init)
        if (res.status === 404) return null
        if (res.status === 429) throw new Error('MUSICBRAINZ_RATE_LIMITED')
        if (res.status === 503) throw new Error('MUSICBRAINZ_UNAVAILABLE')
        if (!res.ok) throw new Error(`MUSICBRAINZ_HTTP_${res.status}`)
        const mime = res.headers.get('content-type') || 'image/jpeg'
        const arrayBuffer = await res.arrayBuffer()
        return { mime, buffer: Buffer.from(arrayBuffer) }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          if (abortedByTimeout) throw new Error('MUSICBRAINZ_TIMEOUT')
          throw new Error('MUSICBRAINZ_ABORTED')
        }
        if (err?.code === 'ECONNRESET' || err?.message?.includes('fetch failed')) {
          log.warn('[musicbrainz] request buffer network error', {
            url,
            code: err?.code,
            message: err?.message
          })
          throw new Error('MUSICBRAINZ_NETWORK')
        }
        throw err
      } finally {
        clearTimeout(timer)
        if (currentAbortController === controller) {
          currentAbortController = null
        }
      }
    })
  return withRetry(attempt, { url, type: 'buffer' })
}

function normalizeText(value?: string | null): string | undefined {
  if (!value || typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function normalizeSearchPayload(payload: IMusicBrainzSearchPayload) {
  return {
    filePath: payload.filePath,
    title: normalizeText(payload.title),
    artist: normalizeText(payload.artist),
    album: normalizeText(payload.album),
    durationSeconds:
      typeof payload.durationSeconds === 'number' && payload.durationSeconds > 0
        ? Math.round(payload.durationSeconds)
        : undefined
  }
}

function escapeQueryValue(value: string) {
  return value.replace(/"/g, '\\"')
}

function buildRecordingQuery(payload: ReturnType<typeof normalizeSearchPayload>) {
  const parts: string[] = []
  if (payload.title) {
    parts.push(`recording:"${escapeQueryValue(payload.title)}"`)
  }
  if (payload.artist) {
    parts.push(`artist:"${escapeQueryValue(payload.artist)}"`)
  }
  if (payload.album) {
    parts.push(`release:"${escapeQueryValue(payload.album)}"`)
  }
  if (payload.durationSeconds && payload.durationSeconds > 0) {
    const baseMs = payload.durationSeconds * 1000
    const delta = 2000
    parts.push(`dur:[${Math.max(baseMs - delta, 0)} TO ${baseMs + delta}]`)
  }
  return parts.join(' AND ')
}

function formatArtistCredit(credit: any): string {
  if (!Array.isArray(credit)) return ''
  return credit
    .map((entry: any) => {
      const name = entry?.name || entry?.artist?.name
      const joinphrase = entry?.joinphrase || ''
      return `${name || ''}${joinphrase}`
    })
    .join('')
    .trim()
}

function computeMatchedFields(
  recording: any,
  payload: ReturnType<typeof normalizeSearchPayload>,
  release?: any
) {
  const matched: string[] = []
  const recTitle = normalizeText(recording?.title)?.toLowerCase()
  const artistCredit = formatArtistCredit(recording?.['artist-credit']).toLowerCase()
  const releaseTitle = normalizeText(release?.title)?.toLowerCase()
  if (payload.title && recTitle && payload.title.toLowerCase() === recTitle) matched.push('title')
  if (payload.artist && artistCredit && payload.artist.toLowerCase() === artistCredit) {
    matched.push('artist')
  }
  if (payload.album && releaseTitle && payload.album.toLowerCase() === releaseTitle) {
    matched.push('album')
  }
  if (payload.durationSeconds && typeof recording?.length === 'number') {
    const diff = Math.abs(Math.round(recording.length / 1000) - payload.durationSeconds)
    if (diff <= 2) matched.push('duration')
  }
  return matched
}

function pickRelease(releases: any[]): any | undefined {
  if (!Array.isArray(releases) || releases.length === 0) return undefined
  const scored = releases
    .map((release) => ({
      release,
      score:
        (release?.status === 'Official' ? 20 : 0) +
        (Array.isArray(release?.media) && release.media.length ? 10 : 0) +
        (release?.country ? 5 : 0)
    }))
    .sort((a, b) => b.score - a.score)
  return scored[0]?.release ?? releases[0]
}

function transformRecording(
  recording: any,
  payload: ReturnType<typeof normalizeSearchPayload>
): IMusicBrainzMatch {
  const release = pickRelease(recording?.releases ?? [])
  const durationSeconds =
    typeof recording?.length === 'number' ? Math.round(recording.length / 1000) : undefined
  const durationDiffSeconds =
    payload.durationSeconds && durationSeconds
      ? Math.abs(durationSeconds - payload.durationSeconds)
      : undefined
  const baseScore = typeof recording?.score === 'number' ? recording.score : 0
  let score = baseScore
  const matchedFields = computeMatchedFields(recording, payload, release)
  score += matchedFields.length * 5
  if (typeof durationDiffSeconds === 'number') {
    if (durationDiffSeconds <= 2) score += 10
    else if (durationDiffSeconds > 8) score -= 10
  }
  if (release?.status === 'Official') score += 5
  if (release?.country) score += 2
  if (release?.['release-events']?.length) score += 1
  score = Math.max(0, Math.min(100, score))
  return {
    recordingId: recording?.id,
    title: recording?.title || '',
    artist: formatArtistCredit(recording?.['artist-credit']),
    releaseId: release?.id,
    releaseTitle: release?.title,
    releaseDate: release?.date,
    country: release?.country,
    disambiguation: recording?.disambiguation,
    score,
    matchedFields,
    durationSeconds,
    durationDiffSeconds,
    isrc: Array.isArray(recording?.isrcs) ? recording.isrcs[0] : undefined,
    source: 'search'
  }
}

export async function searchMusicBrainz(
  payload: IMusicBrainzSearchPayload
): Promise<IMusicBrainzMatch[]> {
  const normalized = normalizeSearchPayload(payload)
  if (!normalized.title && !normalized.artist && !normalized.album && !normalized.durationSeconds) {
    throw new Error('MUSICBRAINZ_EMPTY_QUERY')
  }
  const query = buildRecordingQuery(normalized)
  if (!query) throw new Error('MUSICBRAINZ_EMPTY_QUERY')
  const cacheKey = JSON.stringify({
    title: normalized.title,
    artist: normalized.artist,
    album: normalized.album,
    durationSeconds: normalized.durationSeconds
  })
  const cached = await readCache<IMusicBrainzMatch[]>('search', cacheKey)
  if (cached) return cached
  const url = `${MUSICBRAINZ_BASE}/recording?fmt=json&limit=5&inc=releases+artists+isrcs&query=${encodeURIComponent(query)}`
  const response = await requestJson<any>(url)
  const recordings: any[] = Array.isArray(response?.recordings) ? response.recordings : []
  const matches = recordings
    .map((rec) => transformRecording(rec, normalized))
    .filter((m) => m.title)
  matches.sort((a, b) => b.score - a.score)
  await writeCache('search', cacheKey, SEARCH_CACHE_TTL, matches)
  return matches
}

async function fetchRecordingDetail(recordingId: string): Promise<any> {
  const url = `${MUSICBRAINZ_BASE}/recording/${recordingId}?fmt=json&inc=releases+artists+isrcs`
  return await requestJson<any>(url)
}

async function fetchReleaseDetail(releaseId: string): Promise<any> {
  const url = `${MUSICBRAINZ_BASE}/release/${releaseId}?fmt=json&inc=recordings+artists+labels+genres+media`
  return await requestJson<any>(url, undefined, RELEASE_DETAIL_TIMEOUT)
}

function findTrackContext(release: any, recordingId: string) {
  if (!release || !Array.isArray(release.media)) return null
  for (const medium of release.media) {
    const trackList = medium?.tracks || medium?.track
    if (!Array.isArray(trackList)) continue
    for (const track of trackList) {
      if (track?.recording?.id === recordingId) {
        return { medium, track }
      }
    }
  }
  return null
}

async function fetchCoverDataUrl(releaseId: string): Promise<string | null> {
  try {
    const cover = await requestBuffer(
      `${COVER_ART_BASE}/release/${releaseId}/front-500`,
      undefined,
      RELEASE_DETAIL_TIMEOUT
    )
    if (!cover) return null
    return `data:${cover.mime};base64,${cover.buffer.toString('base64')}`
  } catch (err: any) {
    // Only re-throw if user cancelled the request
    if (err?.message === 'MUSICBRAINZ_ABORTED') {
      throw err
    }
    // For network errors, log and return null (graceful degradation)
    // This allows other metadata to be returned even if cover fetch fails
    log.warn('[musicbrainz] cover fetch failed, returning null', {
      releaseId,
      message: err?.message
    })
    return null
  }
}

export async function fetchMusicBrainzSuggestion(
  params: IMusicBrainzSuggestionParams
): Promise<IMusicBrainzSuggestionResult> {
  if (!params || !params.recordingId) {
    throw new Error('MUSICBRAINZ_INVALID_PARAMS')
  }
  const ensureNotCancelled = () => {
    if (params?.cancelToken?.cancelled) {
      throw new Error('MUSICBRAINZ_ABORTED')
    }
  }
  ensureNotCancelled()
  const allowFallback = params.allowFallback === true
  const recordingId = params.recordingId
  const autoCacheKey = `${recordingId}:auto`
  const preferredCacheKey = params.releaseId ? `${recordingId}:${params.releaseId}` : null
  const cacheKeysToCheck: string[] = []
  if (allowFallback) cacheKeysToCheck.push(autoCacheKey)
  if (preferredCacheKey) cacheKeysToCheck.push(preferredCacheKey)
  if (!cacheKeysToCheck.length) cacheKeysToCheck.push(autoCacheKey)
  for (const key of cacheKeysToCheck) {
    if (!key) continue
    const cached = await readCache<IMusicBrainzSuggestionResult>('detail', key)
    if (cached) {
      return cached
    }
  }
  const recording = await fetchRecordingDetail(params.recordingId)
  const releaseCandidates: string[] = []
  const addCandidate = (id?: string | null) => {
    if (!id) return
    if (!releaseCandidates.includes(id)) releaseCandidates.push(id)
  }
  const recordingReleases = Array.isArray(recording?.releases) ? recording?.releases : []
  if (params.releaseId) {
    addCandidate(params.releaseId)
  }
  if (!params.releaseId || allowFallback) {
    addCandidate(pickRelease(recordingReleases || [])?.id)
    addCandidate(recordingReleases?.[0]?.id)
  }
  for (const rel of recordingReleases) {
    addCandidate(rel?.id)
  }
  if (!releaseCandidates.length) throw new Error('MUSICBRAINZ_RELEASE_NOT_FOUND')

  const buildResultFromRelease = async (releaseDetail: any, releaseId: string, trackCtx?: any) => {
    ensureNotCancelled()
    const hasTrack = !!trackCtx
    const trackNumber =
      hasTrack && trackCtx.track?.position
        ? Number(trackCtx.track.position)
        : hasTrack && trackCtx.track?.number
          ? parseInt(trackCtx.track.number, 10) || undefined
          : undefined
    const suggestion = {
      title: recording?.title,
      artist: formatArtistCredit(recording?.['artist-credit']),
      album: releaseDetail?.title,
      albumArtist: formatArtistCredit(releaseDetail?.['artist-credit']),
      year: normalizeText(releaseDetail?.date)?.slice(0, 4),
      genre: Array.isArray(releaseDetail?.genres) ? releaseDetail.genres[0]?.name : undefined,
      label: releaseDetail?.['label-info']?.[0]?.label?.name,
      isrc: Array.isArray(recording?.isrcs) ? recording.isrcs[0] : undefined,
      trackNo: trackNumber,
      trackTotal:
        hasTrack && typeof trackCtx.medium?.['track-count'] === 'number'
          ? trackCtx.medium['track-count']
          : hasTrack
            ? trackCtx.medium?.trackCount
            : undefined,
      discNo:
        hasTrack && typeof trackCtx.medium?.position === 'number'
          ? trackCtx.medium.position
          : undefined,
      discTotal: Array.isArray(releaseDetail?.media) ? releaseDetail.media.length : undefined,
      coverDataUrl:
        releaseDetail?.['cover-art-archive']?.front === true
          ? await fetchCoverDataUrl(releaseId)
          : null
    } as IMusicBrainzSuggestionResult['suggestion']
    return {
      suggestion,
      source: {
        recordingId: params.recordingId,
        releaseId
      },
      releaseTitle: releaseDetail?.title,
      releaseDate: releaseDetail?.date,
      country: releaseDetail?.country,
      label: suggestion.label,
      artistCredit: suggestion.albumArtist
    } satisfies IMusicBrainzSuggestionResult
  }
  let fallbackReleaseDetail: { releaseId: string; detail: any } | null = null
  let lastError: Error | null = null
  for (const releaseId of releaseCandidates) {
    try {
      ensureNotCancelled()
      const releaseDetail = await fetchReleaseDetail(releaseId)
      const trackCtx = findTrackContext(releaseDetail, params.recordingId)
      if (!trackCtx) {
        const trackErr = new Error('MUSICBRAINZ_RECORDING_NOT_IN_RELEASE')
        lastError = trackErr
        if (allowFallback) {
          if (!fallbackReleaseDetail) {
            fallbackReleaseDetail = { releaseId, detail: releaseDetail }
          }
          log.warn('[musicbrainz] recording not found in release, fallback allowed', {
            recordingId,
            releaseId
          })
          continue
        }
        throw trackErr
      }
      ensureNotCancelled()
      const result = await buildResultFromRelease(releaseDetail, releaseId, trackCtx)
      const keysToWrite = new Set<string>()
      if (result.source.releaseId) {
        keysToWrite.add(`${recordingId}:${result.source.releaseId}`)
      }
      if (!params.releaseId || allowFallback) {
        keysToWrite.add(autoCacheKey)
      }
      if (params.releaseId && !allowFallback && result.source.releaseId === params.releaseId) {
        keysToWrite.add(`${recordingId}:${params.releaseId}`)
      }
      for (const key of keysToWrite) {
        if (key) {
          await writeCache('detail', key, DETAIL_CACHE_TTL, result)
        }
      }
      return result
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const shouldFallback =
        allowFallback && lastError?.message === 'MUSICBRAINZ_RECORDING_NOT_IN_RELEASE'
      if (shouldFallback) continue
      log.error('[musicbrainz] suggestion failed for release', {
        recordingId,
        releaseId,
        message: lastError?.message
      })
      throw lastError
    }
  }
  if (allowFallback && fallbackReleaseDetail) {
    ensureNotCancelled()
    const result = await buildResultFromRelease(
      fallbackReleaseDetail.detail,
      fallbackReleaseDetail.releaseId
    )
    const keysToWrite = new Set<string>()
    if (result.source.releaseId) {
      keysToWrite.add(`${recordingId}:${result.source.releaseId}`)
    }
    keysToWrite.add(autoCacheKey)
    for (const key of keysToWrite) {
      await writeCache('detail', key, DETAIL_CACHE_TTL, result)
    }
    return result
  }
  if (lastError) {
    log.error('[musicbrainz] suggestion failed after all candidates', {
      recordingId,
      preferredReleaseId: params.releaseId,
      message: lastError?.message
    })
    throw lastError
  }
  throw new Error('MUSICBRAINZ_RECORDING_NOT_IN_RELEASE')
}

export function cancelMusicBrainzRequests() {
  requestQueue.length = 0
  if (currentAbortController) {
    try {
      currentAbortController.abort()
    } catch {}
    currentAbortController = null
  }
}
