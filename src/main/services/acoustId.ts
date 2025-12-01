import { app } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { ProxyAgent } from 'undici'
import { IMusicBrainzAcoustIdPayload, IMusicBrainzMatch } from '../../types/globals'
import { ensureFpcalcExecutable, resolveBundledFpcalcPath } from '../chromaprint'
import store from '../store'

const MAX_ANALYSIS_SECONDS = 120
const FPCALC_TIMEOUT = 45_000
const LOOKUP_TIMEOUT = 12_000
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const CACHE_FILE_NAME = 'fingerprintCache.json'
const LOOKUP_URL = 'https://api.acoustid.org/v2/lookup'
const VALIDATION_TRACK_ID = '889584fb-b962-4601-9d10-252e07310713'
// NOTE: meta 参数使用空格分隔，URLSearchParams 会将空格编码为 '+'，符合 AcoustID 要求
const LOOKUP_META = 'recordings releasegroups releases tracks'
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
const proxyDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
const fallbackAcoustIdClientKey = process.env.ACOUSTID_CLIENT_KEY || ''

type FingerprintCacheEntry = {
  fingerprint: string
  duration: number
  acoustIdResults?: AcoustIdLookupResponse | null
  createdAt: number
}

type FingerprintCache = Record<string, FingerprintCacheEntry>

type AcoustIdLookupResponse = {
  status?: string
  error?: {
    message?: string
    code?: number | string
  }
  results?: Array<{
    id?: string
    score?: number
    recordings?: Array<AcoustIdRecording>
  }>
}

type AcoustIdRecording = {
  id?: string
  title?: string
  duration?: number
  disambiguation?: string
  artists?: Array<{
    id?: string
    name?: string
    joinphrase?: string
  }>
  releasegroups?: Array<{
    id?: string
    title?: string
    'first-release-date'?: string
  }>
  releases?: Array<{
    id?: string
    title?: string
    date?: string
    country?: string
    status?: string
  }>
  isrcs?: string[]
}

const appReady = app.isReady() ? Promise.resolve() : app.whenReady()
let cacheLoaded = false
let cacheStore: FingerprintCache = {}
let persistTimer: NodeJS.Timeout | null = null
let persisting = false

async function getCacheFilePath(): Promise<string> {
  await appReady
  return path.join(app.getPath('userData'), CACHE_FILE_NAME)
}

async function loadCache(): Promise<void> {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const file = await getCacheFilePath()
    if (await fs.pathExists(file)) {
      cacheStore = await fs.readJson(file)
    }
  } catch {
    cacheStore = {}
  }
}

async function persistCache(): Promise<void> {
  if (persisting) return
  persisting = true
  try {
    const file = await getCacheFilePath()
    await fs.outputJson(file, cacheStore)
  } catch {
    // 忽略持久化失败
  } finally {
    persisting = false
  }
}

function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistCache()
  }, 2000)
}

async function readFingerprintCache(key: string): Promise<FingerprintCacheEntry | null> {
  await loadCache()
  const entry = cacheStore[key]
  if (!entry) return null
  if (Date.now() - entry.createdAt > CACHE_TTL) {
    delete cacheStore[key]
    schedulePersist()
    return null
  }
  return entry
}

async function writeFingerprintCache(key: string, entry: FingerprintCacheEntry): Promise<void> {
  await loadCache()
  cacheStore[key] = entry
  schedulePersist()
}

async function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', (err) => reject(err))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function buildCacheKey(filePath: string): Promise<{ key: string; size: number }> {
  const stats = await fs.stat(filePath)
  if (!stats || !stats.isFile()) {
    throw new Error('ACOUSTID_FILE_NOT_FOUND')
  }
  const hash = await hashFileSha256(filePath)
  return { key: `${hash}:${stats.size}`, size: stats.size }
}

async function runFpcalc(
  filePath: string,
  maxLengthSeconds?: number
): Promise<{ fingerprint: string; duration: number }> {
  const fpcalcPath = resolveBundledFpcalcPath()
  if (!fpcalcPath || !(await fs.pathExists(fpcalcPath))) {
    throw new Error('ACOUSTID_FPCALC_NOT_FOUND')
  }
  await ensureFpcalcExecutable(fpcalcPath)
  const args = ['-json']
  const targetLength =
    maxLengthSeconds && maxLengthSeconds > 0 ? maxLengthSeconds : MAX_ANALYSIS_SECONDS
  args.push('-length', String(targetLength))
  args.push(filePath)
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(fpcalcPath, args, { windowsHide: true })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      reject(new Error('ACOUSTID_TIMEOUT'))
    }, FPCALC_TIMEOUT)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', (err: any) => {
      clearTimeout(timer)
      if (err && (err as any).code === 'ENOENT') {
        reject(new Error('ACOUSTID_FPCALC_NOT_FOUND'))
      } else {
        reject(err)
      }
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const error = stderr || `fpcalc exit ${code}`
        reject(new Error(`ACOUSTID_FPCALC_FAILED:${error}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        const fingerprint = parsed?.fingerprint
        const duration = parsed?.duration
        if (!fingerprint || typeof fingerprint !== 'string') {
          reject(new Error('ACOUSTID_NO_FINGERPRINT'))
          return
        }
        if (typeof duration !== 'number' || duration <= 0) {
          reject(new Error('ACOUSTID_INVALID_DURATION'))
          return
        }
        resolve({ fingerprint, duration })
      } catch (err) {
        reject(new Error('ACOUSTID_FPCALC_PARSE_ERROR'))
      }
    })
  })
}

interface QueueItem<T> {
  fn: () => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

const requestQueue: QueueItem<any>[] = []
let requestProcessing = false
const MIN_LOOKUP_INTERVAL = 400
let currentLookupAbort: AbortController | null = null

function resolveAcoustIdClientKey(): string {
  const fromSetting = (store as any)?.settingConfig?.acoustIdClientKey
  if (typeof fromSetting === 'string') {
    const trimmed = fromSetting.trim()
    if (trimmed) return trimmed
  }
  return fallbackAcoustIdClientKey
}

function isInvalidClientError(message?: string) {
  if (!message) return false
  const lower = String(message).toLowerCase()
  return lower.includes('invalid') && lower.includes('client')
}

function scheduleLookup<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject })
    processQueue()
  })
}

function processQueue() {
  if (requestProcessing) return
  const item = requestQueue.shift()
  if (!item) return
  requestProcessing = true
  item
    .fn()
    .then((res) => item.resolve(res))
    .catch((err) => item.reject(err))
    .finally(() => {
      setTimeout(() => {
        requestProcessing = false
        processQueue()
      }, MIN_LOOKUP_INTERVAL)
    })
}

async function lookupAcoustId(
  fingerprint: string,
  duration: number
): Promise<AcoustIdLookupResponse> {
  const clientKey = resolveAcoustIdClientKey()
  if (!clientKey) {
    throw new Error('ACOUSTID_CLIENT_MISSING')
  }
  return scheduleLookup(async () => {
    const controller = new AbortController()
    currentLookupAbort = controller
    let abortedByTimeout = false
    const timer = setTimeout(() => {
      abortedByTimeout = true
      controller.abort()
    }, LOOKUP_TIMEOUT)
    try {
      const body = new URLSearchParams({
        client: clientKey,
        duration: String(Math.round(duration)),
        fingerprint,
        meta: LOOKUP_META
      })
      const init: RequestInit & { dispatcher?: any } = {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': `FRKB/${app.getVersion()}`
        },
        signal: controller.signal
      }
      if (proxyDispatcher) init.dispatcher = proxyDispatcher
      const res = await fetch(LOOKUP_URL, init)
      if (res.status === 429) throw new Error('ACOUSTID_RATE_LIMITED')
      if (res.status === 401 || res.status === 403) throw new Error('ACOUSTID_CLIENT_INVALID')
      if (!res.ok) throw new Error(`ACOUSTID_HTTP_${res.status}`)
      return (await res.json()) as AcoustIdLookupResponse
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        if (abortedByTimeout) throw new Error('ACOUSTID_TIMEOUT')
        throw new Error('ACOUSTID_ABORTED')
      }
      if (err?.code === 'ECONNRESET' || err?.message?.includes('fetch failed')) {
        throw new Error('ACOUSTID_NETWORK')
      }
      throw err
    } finally {
      clearTimeout(timer)
      if (currentLookupAbort === controller) {
        currentLookupAbort = null
      }
    }
  })
}

function joinArtists(artists?: AcoustIdRecording['artists']): string {
  if (!Array.isArray(artists) || !artists.length) return ''
  return artists
    .map((artist) => `${artist?.name || ''}${artist?.joinphrase || ''}`)
    .join('')
    .trim()
}

function pickRecordingRelease(recording: AcoustIdRecording) {
  const releases = Array.isArray(recording?.releases) ? recording.releases : []
  if (!releases.length) return null
  const sorted = releases
    .map((release) => ({
      release,
      score:
        (release?.status === 'Official' ? 20 : 0) +
        (release?.country ? 5 : 0) +
        (release?.date ? 3 : 0)
    }))
    .sort((a, b) => b.score - a.score)
  return sorted[0]?.release || releases[0]
}

function normalizeDuration(value?: number): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined
  if (!Number.isFinite(value)) return undefined
  return Math.max(0, Math.round(value))
}

function computeDurationDiff(matchDuration?: number, localDuration?: number) {
  if (typeof matchDuration !== 'number' || typeof localDuration !== 'number') return undefined
  return Math.abs(Math.round(matchDuration) - Math.round(localDuration))
}

function transformMatches(
  response: AcoustIdLookupResponse,
  payload: IMusicBrainzAcoustIdPayload
): IMusicBrainzMatch[] {
  if (!response || !Array.isArray(response.results)) return []
  const dedup = new Map<string, IMusicBrainzMatch>()
  for (const result of response.results) {
    const baseScore = typeof result?.score === 'number' ? result.score : 0
    if (!Array.isArray(result?.recordings)) continue
    for (const recording of result.recordings) {
      if (!recording?.id) continue
      const release = pickRecordingRelease(recording)
      const releaseGroup = Array.isArray(recording?.releasegroups)
        ? recording.releasegroups[0]
        : undefined
      const durationSeconds = normalizeDuration(recording?.duration)
      const durationDiffSeconds = computeDurationDiff(durationSeconds, payload.durationSeconds)
      let score = Math.round(baseScore * 100)
      if (typeof durationDiffSeconds === 'number') {
        if (durationDiffSeconds <= 2) score += 10
        else if (durationDiffSeconds > 8) score -= 10
      }
      if (release?.status === 'Official') score += 5
      if (release?.country) score += 2
      if (release?.date) score += 1
      score = Math.max(0, Math.min(100, score))
      const matchedFields = ['fingerprint']
      if (typeof durationDiffSeconds === 'number' && durationDiffSeconds <= 2) {
        matchedFields.push('duration')
      }
      const key = release?.id ? `${recording.id}:${release.id}` : recording.id
      const match: IMusicBrainzMatch = {
        recordingId: recording.id,
        title: recording.title || '',
        artist: joinArtists(recording.artists),
        releaseId: release?.id,
        releaseTitle: release?.title || releaseGroup?.title,
        releaseDate: release?.date || releaseGroup?.['first-release-date'],
        country: release?.country,
        disambiguation: recording.disambiguation,
        score,
        matchedFields,
        durationSeconds,
        durationDiffSeconds,
        isrc: Array.isArray(recording?.isrcs) ? recording.isrcs[0] : undefined,
        source: 'acoustid',
        acoustIdScore: baseScore,
        isLowConfidence: baseScore > 0 && baseScore < 0.3
      }
      const existing = dedup.get(key)
      if (!existing || existing.score < match.score) {
        dedup.set(key, match)
      }
    }
  }
  return Array.from(dedup.values()).sort((a, b) => b.score - a.score)
}

async function ensureFingerprint(
  payload: IMusicBrainzAcoustIdPayload
): Promise<{ cacheKey: string; entry: FingerprintCacheEntry }> {
  const resolved = path.resolve(payload.filePath)
  const { key } = await buildCacheKey(resolved)
  let entry = await readFingerprintCache(key)
  if (!entry || !entry.fingerprint) {
    const result = await runFpcalc(resolved, payload.maxLengthSeconds)
    entry = {
      fingerprint: result.fingerprint,
      duration: result.duration,
      acoustIdResults: null,
      createdAt: Date.now()
    }
    await writeFingerprintCache(key, entry)
  }
  return { cacheKey: key, entry }
}

async function fetchAcoustIdWithCache(
  cacheKey: string,
  entry: FingerprintCacheEntry
): Promise<AcoustIdLookupResponse> {
  if (entry.acoustIdResults) return entry.acoustIdResults
  const response = await lookupAcoustId(entry.fingerprint, entry.duration)
  if (response?.status === 'ok') {
    entry.acoustIdResults = response
    entry.createdAt = Date.now()
    await writeFingerprintCache(cacheKey, entry)
  }
  return response
}

export async function matchTrackWithAcoustId(
  payload: IMusicBrainzAcoustIdPayload
): Promise<IMusicBrainzMatch[]> {
  if (!payload || !payload.filePath) {
    throw new Error('ACOUSTID_INVALID_PARAMS')
  }
  const { cacheKey, entry } = await ensureFingerprint(payload)
  const response = await fetchAcoustIdWithCache(cacheKey, entry)
  if (response?.status === 'error') {
    const message = response?.error?.message || ''
    if (isInvalidClientError(message)) {
      throw new Error('ACOUSTID_CLIENT_INVALID')
    }
    throw new Error(`ACOUSTID_LOOKUP_FAILED:${message}`)
  }
  const matches = transformMatches(response, payload)
  return matches.slice(0, 10)
}

export function cancelAcoustIdRequests() {
  requestQueue.length = 0
  if (currentLookupAbort) {
    try {
      currentLookupAbort.abort()
    } catch {}
    currentLookupAbort = null
  }
}

export async function validateAcoustIdClientKeyValue(clientKey: string): Promise<void> {
  const trimmed = typeof clientKey === 'string' ? clientKey.trim() : ''
  if (!trimmed) {
    throw new Error('ACOUSTID_CLIENT_MISSING')
  }
  const controller = new AbortController()
  let abortedByTimeout = false
  const timer = setTimeout(() => {
    abortedByTimeout = true
    controller.abort()
  }, LOOKUP_TIMEOUT)
  try {
    const body = new URLSearchParams({
      client: trimmed,
      trackid: VALIDATION_TRACK_ID,
      meta: 'recordings'
    })
    const init: RequestInit & { dispatcher?: any } = {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': `FRKB/${app.getVersion()}`
      },
      signal: controller.signal
    }
    if (proxyDispatcher) init.dispatcher = proxyDispatcher
    const res = await fetch(LOOKUP_URL, init)
    if (res.status === 429) throw new Error('ACOUSTID_RATE_LIMITED')
    if (res.status === 401 || res.status === 403) throw new Error('ACOUSTID_CLIENT_INVALID')
    if (!res.ok) throw new Error(`ACOUSTID_HTTP_${res.status}`)
    const json = (await res.json()) as AcoustIdLookupResponse
    if (json?.status === 'error') {
      const message = json?.error?.message || ''
      if (isInvalidClientError(message)) {
        throw new Error('ACOUSTID_CLIENT_INVALID')
      }
      throw new Error(`ACOUSTID_LOOKUP_FAILED:${message}`)
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      if (abortedByTimeout) throw new Error('ACOUSTID_TIMEOUT')
      throw new Error('ACOUSTID_ABORTED')
    }
    if (err?.code === 'ECONNRESET' || err?.message?.includes('fetch failed')) {
      throw new Error('ACOUSTID_NETWORK')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
