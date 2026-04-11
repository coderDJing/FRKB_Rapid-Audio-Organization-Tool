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

type JsonObject = Record<string, unknown>
type RequestInitWithDispatcher = RequestInit & { dispatcher?: ProxyAgent }
type ErrorLike = {
  message?: unknown
  code?: unknown
  name?: unknown
}
type TrackContext = {
  medium: JsonObject
  track: JsonObject
}

const isJsonObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const getNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const getJsonObject = (value: unknown): JsonObject | undefined =>
  isJsonObject(value) ? value : undefined

const getJsonObjectArray = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.filter(isJsonObject) : []

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
const memoryCache = new Map<string, { expiresAt: number; data: unknown }>()

interface QueueItem<T> {
  fn: () => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

const requestQueue: QueueItem<unknown>[] = []
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

function getErrorCode(err: unknown) {
  const error = getJsonObject(err) as ErrorLike | undefined
  const message = getString(error?.message)
  if (message) return message
  const code = getString(error?.code)
  if (code) return code
  return ''
}

function isRetriableError(err: unknown) {
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

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      lastError = err
      const willRetry = attempt < MAX_RETRIES && isRetriableError(err)
      if (!willRetry) throw err
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(getErrorCode(lastError) || 'MUSICBRAINZ_UNKNOWN')
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
        const init: RequestInitWithDispatcher = {
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
      } catch (err: unknown) {
        const error = getJsonObject(err) as ErrorLike | undefined
        const errorName = getString(error?.name)
        const errorCode = getString(error?.code)
        const errorMessage = getString(error?.message)
        if (errorName === 'AbortError') {
          if (abortedByTimeout) throw new Error('MUSICBRAINZ_TIMEOUT')
          throw new Error('MUSICBRAINZ_ABORTED')
        }
        if (errorCode === 'ECONNRESET' || errorMessage?.includes('fetch failed')) {
          throw new Error('MUSICBRAINZ_NETWORK')
        }
        throw err instanceof Error ? err : new Error(String(err))
      } finally {
        clearTimeout(timer)
        if (currentAbortController === controller) {
          currentAbortController = null
        }
      }
    })
  return withRetry(attempt)
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
        const init: RequestInitWithDispatcher = {
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
      } catch (err: unknown) {
        const error = getJsonObject(err) as ErrorLike | undefined
        const errorName = getString(error?.name)
        const errorCode = getString(error?.code)
        const errorMessage = getString(error?.message)
        if (errorName === 'AbortError') {
          if (abortedByTimeout) throw new Error('MUSICBRAINZ_TIMEOUT')
          throw new Error('MUSICBRAINZ_ABORTED')
        }
        if (errorCode === 'ECONNRESET' || errorMessage?.includes('fetch failed')) {
          throw new Error('MUSICBRAINZ_NETWORK')
        }
        throw err instanceof Error ? err : new Error(String(err))
      } finally {
        clearTimeout(timer)
        if (currentAbortController === controller) {
          currentAbortController = null
        }
      }
    })
  return withRetry(attempt)
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

function formatArtistCredit(credit: unknown): string {
  if (!Array.isArray(credit)) return ''
  return credit
    .map((entry) => {
      const item = getJsonObject(entry)
      const artist = getJsonObject(item?.artist)
      const name = getString(item?.name) || getString(artist?.name)
      const joinphrase = getString(item?.joinphrase) || ''
      return `${name || ''}${joinphrase}`
    })
    .join('')
    .trim()
}

function computeMatchedFields(
  recording: JsonObject,
  payload: ReturnType<typeof normalizeSearchPayload>,
  release?: JsonObject
) {
  const matched: string[] = []
  const recTitle = normalizeText(getString(recording.title))?.toLowerCase()
  const artistCredit = formatArtistCredit(recording['artist-credit']).toLowerCase()
  const releaseTitle = normalizeText(getString(release?.title))?.toLowerCase()
  if (payload.title && recTitle && payload.title.toLowerCase() === recTitle) matched.push('title')
  if (payload.artist && artistCredit && payload.artist.toLowerCase() === artistCredit) {
    matched.push('artist')
  }
  if (payload.album && releaseTitle && payload.album.toLowerCase() === releaseTitle) {
    matched.push('album')
  }
  const recordingLength = getNumber(recording.length)
  if (payload.durationSeconds && recordingLength !== undefined) {
    const diff = Math.abs(Math.round(recordingLength / 1000) - payload.durationSeconds)
    if (diff <= 2) matched.push('duration')
  }
  return matched
}

function pickRelease(releases: unknown[]): JsonObject | undefined {
  const normalizedReleases = getJsonObjectArray(releases)
  if (normalizedReleases.length === 0) return undefined
  const scored = normalizedReleases
    .map((release) => ({
      release,
      score:
        (getString(release.status) === 'Official' ? 20 : 0) +
        (getJsonObjectArray(release.media).length ? 10 : 0) +
        (getString(release.country) ? 5 : 0)
    }))
    .sort((a, b) => b.score - a.score)
  return scored[0]?.release ?? normalizedReleases[0]
}

function transformRecording(
  recording: JsonObject,
  payload: ReturnType<typeof normalizeSearchPayload>
): IMusicBrainzMatch {
  const release = pickRelease(getJsonObjectArray(recording.releases))
  const recordingLength = getNumber(recording.length)
  const durationSeconds =
    recordingLength !== undefined ? Math.round(recordingLength / 1000) : undefined
  const durationDiffSeconds =
    payload.durationSeconds && durationSeconds
      ? Math.abs(durationSeconds - payload.durationSeconds)
      : undefined
  const baseScore = getNumber(recording.score) ?? 0
  let score = baseScore
  const matchedFields = computeMatchedFields(recording, payload, release)
  score += matchedFields.length * 5
  if (typeof durationDiffSeconds === 'number') {
    if (durationDiffSeconds <= 2) score += 10
    else if (durationDiffSeconds > 8) score -= 10
  }
  if (getString(release?.status) === 'Official') score += 5
  if (getString(release?.country)) score += 2
  if (getJsonObjectArray(release?.['release-events']).length) score += 1
  score = Math.max(0, Math.min(100, score))
  return {
    recordingId: getString(recording.id) || '',
    title: getString(recording.title) || '',
    artist: formatArtistCredit(recording['artist-credit']),
    releaseId: getString(release?.id),
    releaseTitle: getString(release?.title),
    releaseDate: getString(release?.date),
    country: getString(release?.country),
    disambiguation: getString(recording.disambiguation),
    score,
    matchedFields,
    durationSeconds,
    durationDiffSeconds,
    isrc: Array.isArray(recording.isrcs) ? getString(recording.isrcs[0]) : undefined,
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
  const response = await requestJson<{ recordings?: unknown[] }>(url)
  const recordings = getJsonObjectArray(response?.recordings)
  const matches = recordings
    .map((rec) => transformRecording(rec, normalized))
    .filter((m) => m.title)
  matches.sort((a, b) => b.score - a.score)
  await writeCache('search', cacheKey, SEARCH_CACHE_TTL, matches)
  return matches
}

async function fetchRecordingDetail(recordingId: string): Promise<JsonObject> {
  const url = `${MUSICBRAINZ_BASE}/recording/${recordingId}?fmt=json&inc=releases+artists+isrcs`
  return await requestJson<JsonObject>(url)
}

async function fetchReleaseDetail(releaseId: string): Promise<JsonObject> {
  const url = `${MUSICBRAINZ_BASE}/release/${releaseId}?fmt=json&inc=recordings+artists+labels+genres+media`
  return await requestJson<JsonObject>(url, undefined, RELEASE_DETAIL_TIMEOUT)
}

function findTrackContext(release: JsonObject, recordingId: string): TrackContext | null {
  for (const medium of getJsonObjectArray(release.media)) {
    const trackList = getJsonObjectArray(medium.tracks ?? medium.track)
    for (const track of trackList) {
      const recording = getJsonObject(track.recording)
      if (getString(recording?.id) === recordingId) {
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
  } catch (err: unknown) {
    // Only re-throw if user cancelled the request
    if (getErrorCode(err) === 'MUSICBRAINZ_ABORTED') {
      throw err
    }
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
  const recordingReleases = getJsonObjectArray(recording.releases)
  if (params.releaseId) {
    addCandidate(params.releaseId)
  }
  if (!params.releaseId || allowFallback) {
    addCandidate(getString(pickRelease(recordingReleases)?.id))
    addCandidate(getString(recordingReleases[0]?.id))
  }
  for (const rel of recordingReleases) {
    addCandidate(getString(rel.id))
  }
  if (!releaseCandidates.length) throw new Error('MUSICBRAINZ_RELEASE_NOT_FOUND')

  const buildResultFromRelease = async (
    releaseDetail: JsonObject,
    releaseId: string,
    trackCtx?: TrackContext | null
  ) => {
    ensureNotCancelled()
    const hasTrack = !!trackCtx
    const trackPosition = getNumber(trackCtx?.track.position)
    const trackNumberText = getString(trackCtx?.track.number)
    const mediumTrackCount = Number(trackCtx?.medium['track-count'])
    const mediumPosition = getNumber(trackCtx?.medium.position)
    const genres = getJsonObjectArray(releaseDetail.genres)
    const firstGenre = getString(genres[0]?.name)
    const labelInfo = getJsonObjectArray(releaseDetail['label-info'])
    const firstLabel = getJsonObject(labelInfo[0]?.label)
    const coverArchive = getJsonObject(releaseDetail['cover-art-archive'])
    const trackNumber =
      hasTrack && trackPosition !== undefined
        ? Number(trackPosition)
        : hasTrack && trackNumberText
          ? parseInt(trackNumberText, 10) || undefined
          : undefined
    const suggestion = {
      title: getString(recording.title),
      artist: formatArtistCredit(recording['artist-credit']),
      album: getString(releaseDetail.title),
      albumArtist: formatArtistCredit(releaseDetail['artist-credit']),
      year: normalizeText(getString(releaseDetail.date))?.slice(0, 4),
      genre: firstGenre,
      label: getString(firstLabel?.name),
      isrc: Array.isArray(recording.isrcs) ? getString(recording.isrcs[0]) : undefined,
      trackNo: trackNumber,
      trackTotal:
        hasTrack && Number.isFinite(mediumTrackCount)
          ? mediumTrackCount
          : hasTrack
            ? getNumber(trackCtx?.medium.trackCount)
            : undefined,
      discNo: hasTrack ? mediumPosition : undefined,
      discTotal: getJsonObjectArray(releaseDetail.media).length || undefined,
      coverDataUrl: coverArchive?.front === true ? await fetchCoverDataUrl(releaseId) : null
    } as IMusicBrainzSuggestionResult['suggestion']
    return {
      suggestion,
      source: {
        recordingId: params.recordingId,
        releaseId
      },
      releaseTitle: getString(releaseDetail.title),
      releaseDate: getString(releaseDetail.date),
      country: getString(releaseDetail.country),
      label: suggestion.label,
      artistCredit: suggestion.albumArtist
    } satisfies IMusicBrainzSuggestionResult
  }
  let fallbackReleaseDetail: { releaseId: string; detail: JsonObject } | null = null
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
    } catch (error: unknown) {
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
