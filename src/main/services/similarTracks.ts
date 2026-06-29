import { app } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import {
  ISimilarTrackItem,
  ISimilarTrackSource,
  ISimilarTracksProviderStatus,
  ISimilarTracksRequest,
  ISimilarTracksResult,
  ISimilarTracksSeed,
  ISimilarTracksBatchRequest,
  ISimilarTracksBatchResult,
  ISimilarTracksBatchSeedResult
} from '../../types/globals'
import { getSystemProxy } from '../utils'
import { matchTrackWithAcoustId } from './acoustId'
import { searchMusicBrainz } from './musicBrainz'
import mainWindow from '../window/mainWindow'
import { createRateLimitedQueue } from './rateLimitedQueue'

const LISTENBRAINZ_URL = 'https://labs.api.listenbrainz.org/similar-recordings/json'
const LISTENBRAINZ_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30_top_n_listeners_1000'
const LASTFM_URL = 'https://ws.audioscrobbler.com/2.0/'
const DEFAULT_LASTFM_API_KEY = String(process.env.FRKB_LASTFM_API_KEY || '').trim()
const REQUEST_TIMEOUT = 12_000
const DEFAULT_LIMIT = 50

// 限流间隔（毫秒）。依据见 rateLimitedQueue.ts 顶部注释：
// ListenBrainz labs 官方无数字、无限流头 → 取保守值；Last.fm 官方无数字 → 取保守值。
const LISTENBRAINZ_MIN_INTERVAL = 400
const LASTFM_MIN_INTERVAL = 250

// 每个外部源独立一条串行队列：不同主机/不同政策，避免快的被慢的拖累。
const listenBrainzQueue = createRateLimitedQueue({ minInterval: LISTENBRAINZ_MIN_INTERVAL })
const lastFmQueue = createRateLimitedQueue({ minInterval: LASTFM_MIN_INTERVAL })

// 结果缓存（持久化到 userData/similarTracksCache.json，TTL 7 天）。
// 批量场景里重复的种子 / 重复的推荐目标可直接命中，大幅减少外部请求。
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const CACHE_FILE_NAME = 'similarTracksCache.json'

type JsonObject = Record<string, unknown>
type RequestInitWithDispatcher = UndiciRequestInit
type ErrorLike = {
  message?: unknown
  code?: unknown
  name?: unknown
}

let proxyDispatcher: ProxyAgent | undefined
let proxyInitialized = false
const activeControllers = new Set<AbortController>()

// 批量取消标志：progressId -> 是否已请求取消
const canceledBatches = new Set<string>()

// ---- 结果缓存（按 provider + seed 关键字）----
type SimilarCacheEntry = {
  tracks: ISimilarTrackItem[]
  status: ISimilarTracksProviderStatus
  createdAt: number
}
type SimilarCacheStore = Record<string, SimilarCacheEntry>

const appReady = app.isReady() ? Promise.resolve() : app.whenReady()
let cacheLoaded = false
let cacheStore: SimilarCacheStore = {}
let cachePersistTimer: NodeJS.Timeout | null = null

async function getCacheFilePath(): Promise<string> {
  await appReady
  return path.join(app.getPath('userData'), CACHE_FILE_NAME)
}

async function loadSimilarCache(): Promise<void> {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const file = await getCacheFilePath()
    if (await fs.pathExists(file)) {
      cacheStore = (await fs.readJson(file)) as SimilarCacheStore
    }
  } catch {
    cacheStore = {}
  }
}

function scheduleCachePersist(): void {
  if (cachePersistTimer) return
  cachePersistTimer = setTimeout(() => {
    cachePersistTimer = null
    void (async () => {
      try {
        const file = await getCacheFilePath()
        await fs.outputJson(file, cacheStore)
      } catch {
        // 忽略持久化失败
      }
    })()
  }, 2000)
}

async function readSimilarCache(key: string): Promise<SimilarCacheEntry | null> {
  await loadSimilarCache()
  const entry = cacheStore[key]
  if (!entry) return null
  if (Date.now() - entry.createdAt > CACHE_TTL) {
    delete cacheStore[key]
    scheduleCachePersist()
    return null
  }
  return entry
}

async function writeSimilarCache(key: string, entry: SimilarCacheEntry): Promise<void> {
  await loadSimilarCache()
  cacheStore[key] = entry
  scheduleCachePersist()
}

const isJsonObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const getJsonObject = (value: unknown): JsonObject | undefined =>
  isJsonObject(value) ? value : undefined

const getJsonObjectArray = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.filter(isJsonObject) : []

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const getNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const getStringLike = (value: unknown): string | undefined => {
  const text = getString(value)
  if (text) return text
  const number = getNumber(value)
  return number === undefined ? undefined : String(number)
}

async function ensureProxyInitialized(): Promise<void> {
  if (proxyInitialized) return
  proxyInitialized = true
  const proxyUrl = await getSystemProxy()
  if (proxyUrl) {
    proxyDispatcher = new ProxyAgent(proxyUrl)
  }
}

function getUserAgent() {
  return `FRKB/${app.getVersion()} (https://coderDJing.github.io/FRKB_Rapid-Audio-Organization-Tool/)`
}

async function requestJson<T>(url: string): Promise<T> {
  await ensureProxyInitialized()
  const controller = new AbortController()
  activeControllers.add(controller)
  let abortedByTimeout = false
  const timer = setTimeout(() => {
    abortedByTimeout = true
    controller.abort()
  }, REQUEST_TIMEOUT)
  try {
    const init: RequestInitWithDispatcher = {
      headers: {
        Accept: 'application/json',
        'User-Agent': getUserAgent()
      },
      signal: controller.signal
    }
    if (proxyDispatcher) init.dispatcher = proxyDispatcher
    const res = await undiciFetch(url, init)
    if (res.status === 429) throw new Error('SIMILAR_TRACKS_RATE_LIMITED')
    if (res.status === 503) throw new Error('SIMILAR_TRACKS_UNAVAILABLE')
    if (!res.ok) throw new Error(`SIMILAR_TRACKS_HTTP_${res.status}`)
    return (await res.json()) as T
  } catch (err: unknown) {
    const error = getJsonObject(err) as ErrorLike | undefined
    const name = getString(error?.name)
    const code = getString(error?.code)
    const message = getString(error?.message)
    if (name === 'AbortError') {
      throw new Error(abortedByTimeout ? 'SIMILAR_TRACKS_TIMEOUT' : 'SIMILAR_TRACKS_ABORTED')
    }
    if (code === 'ECONNRESET' || message?.includes('fetch failed')) {
      throw new Error('SIMILAR_TRACKS_NETWORK')
    }
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    clearTimeout(timer)
    activeControllers.delete(controller)
  }
}

function clampScore(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const normalized = value <= 1 ? value * 100 : value
  return Math.max(0, Math.min(100, Math.round(normalized)))
}

function normalizeText(value?: string | null): string {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizeKey(value?: string | null): string {
  return normalizeText(value).toLocaleLowerCase()
}

function firstString(row: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = getString(row[key])
    if (value) return value
  }
  return undefined
}

function firstStringLike(row: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = getStringLike(row[key])
    if (value) return value
  }
  return undefined
}

function firstNumber(row: JsonObject, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = getNumber(row[key])
    if (value !== undefined) return value
    const stringValue = getString(row[key])
    if (stringValue) {
      const parsed = Number(stringValue)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

function firstStringFromArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const item of value) {
    const text = getString(item)
    if (text) return text
  }
  return undefined
}

function normalizeLimit(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(100, Math.round(value)))
}

function buildCoverUrl(row: JsonObject, releaseMbid?: string): string | undefined {
  const direct = firstString(row, ['cover_url', 'coverUrl', 'image_url', 'imageUrl'])
  if (direct) return direct
  const caaReleaseMbid =
    firstString(row, ['caa_release_mbid', 'caaReleaseMbid']) || releaseMbid || ''
  const caaId = firstStringLike(row, ['caa_id', 'caaId', 'cover_art_id', 'coverArtId'])
  if (!caaReleaseMbid || !caaId) return undefined
  return `https://coverartarchive.org/release/${encodeURIComponent(caaReleaseMbid)}/${encodeURIComponent(caaId)}-250.jpg`
}

function isListenBrainzTrackRow(row: JsonObject): boolean {
  return !!(
    firstString(row, [
      'recording_name',
      'recordingName',
      'track_name',
      'trackName',
      'title',
      'name'
    ]) &&
    firstString(row, [
      'artist_credit_name',
      'artistCreditName',
      'artist_name',
      'artistName',
      'artist'
    ])
  )
}

function extractListenBrainzRows(payload: unknown): JsonObject[] {
  if (Array.isArray(payload)) return getJsonObjectArray(payload)
  const root = getJsonObject(payload)
  if (!root) return []
  for (const key of [
    'payload',
    'recordings',
    'similar_recordings',
    'similarRecordings',
    'results'
  ]) {
    const value = root[key]
    if (Array.isArray(value)) return getJsonObjectArray(value)
    const nested = getJsonObject(value)
    if (nested) {
      const rows = extractListenBrainzRows(nested)
      if (rows.length) return rows
    }
  }
  return isListenBrainzTrackRow(root) ? [root] : []
}

function transformListenBrainzTrack(row: JsonObject): ISimilarTrackItem | null {
  const title = firstString(row, [
    'recording_name',
    'recordingName',
    'track_name',
    'trackName',
    'title',
    'name'
  ])
  const artist = firstString(row, [
    'artist_credit_name',
    'artistCreditName',
    'artist_name',
    'artistName',
    'artist'
  ])
  if (!title || !artist) return null
  const recordingMbid = firstString(row, [
    'recording_mbid',
    'recordingMbid',
    'recording_id',
    'recordingId',
    'mbid'
  ])
  const releaseMbid = firstString(row, [
    'release_mbid',
    'releaseMbid',
    'caa_release_mbid',
    'caaReleaseMbid'
  ])
  const artistMbid =
    firstString(row, ['artist_mbid', 'artistMbid']) ||
    firstStringFromArray(row.artist_mbids) ||
    firstStringFromArray(row.artistMbids)
  const score = clampScore(firstNumber(row, ['score', 'similarity', 'percent', 'match']))
  const sourceUrl = recordingMbid
    ? `https://musicbrainz.org/recording/${encodeURIComponent(recordingMbid)}`
    : undefined
  return {
    id: recordingMbid || `listenbrainz:${normalizeKey(artist)}:${normalizeKey(title)}`,
    title,
    artist,
    album: firstString(row, ['release_name', 'releaseName', 'album']),
    recordingMbid,
    artistMbid,
    releaseMbid,
    coverUrl: buildCoverUrl(row, releaseMbid),
    score,
    sources: ['listenbrainz'],
    sourceScores: { listenbrainz: score },
    sourceUrls: sourceUrl ? { listenbrainz: sourceUrl } : undefined
  }
}

async function fetchListenBrainzSimilar(seed: ISimilarTracksSeed, limit: number) {
  if (!seed.recordingMbid) {
    return {
      tracks: [] as ISimilarTrackItem[],
      status: {
        source: 'listenbrainz',
        status: 'no-seed',
        count: 0
      } satisfies ISimilarTracksProviderStatus
    }
  }
  const cacheKey = `lb:${normalizeKey(seed.recordingMbid)}:${limit}`
  const cached = await readSimilarCache(cacheKey)
  if (cached) return { tracks: cached.tracks, status: cached.status }
  const params = new URLSearchParams({
    algorithm: LISTENBRAINZ_ALGORITHM,
    recording_mbids: seed.recordingMbid,
    limit: String(limit)
  })
  // 经 ListenBrainz 专属串行限流队列，避免批量撞 429/503
  const json = await listenBrainzQueue.schedule(() =>
    requestJson<unknown>(`${LISTENBRAINZ_URL}?${params.toString()}`)
  )
  const tracks = extractListenBrainzRows(json)
    .map(transformListenBrainzTrack)
    .filter((item): item is ISimilarTrackItem => !!item)
  const status = {
    source: 'listenbrainz',
    status: 'ok',
    count: tracks.length
  } satisfies ISimilarTracksProviderStatus
  await writeSimilarCache(cacheKey, { tracks, status, createdAt: Date.now() })
  return { tracks, status }
}

function extractLastFmRows(payload: unknown): JsonObject[] {
  const root = getJsonObject(payload)
  const similarTracks = getJsonObject(root?.similartracks)
  const rows = similarTracks?.track
  if (Array.isArray(rows)) return getJsonObjectArray(rows)
  const single = getJsonObject(rows)
  return single ? [single] : []
}

function throwIfLastFmError(payload: unknown) {
  const root = getJsonObject(payload)
  if (!root || root.error === undefined) return
  const code = getString(root.error) || String(root.error || '')
  const message = getString(root.message) || code || 'LASTFM_ERROR'
  if (code === '10' || code === '26' || code === '29') {
    throw new Error(`LASTFM_${code}:${message}`)
  }
}

function pickLastFmImage(row: JsonObject): string | undefined {
  const images = getJsonObjectArray(row.image)
  const candidates = images
    .map((item) => getString(item['#text']))
    .filter((item): item is string => !!item)
  return candidates[candidates.length - 1]
}

function transformLastFmTrack(row: JsonObject): ISimilarTrackItem | null {
  const title = firstString(row, ['name', 'title'])
  const artistObj = getJsonObject(row.artist)
  const artist = firstString(row, ['artistName', 'artist']) || getString(artistObj?.name)
  if (!title || !artist) return null
  const recordingMbid = firstString(row, ['mbid', 'recordingMbid'])
  const artistMbid = getString(artistObj?.mbid)
  const score = clampScore(firstNumber(row, ['match', 'score']))
  const sourceUrl = firstString(row, ['url'])
  return {
    id: recordingMbid || `lastfm:${normalizeKey(artist)}:${normalizeKey(title)}`,
    title,
    artist,
    recordingMbid,
    artistMbid,
    coverUrl: pickLastFmImage(row),
    score,
    sources: ['lastfm'],
    sourceScores: { lastfm: score },
    sourceUrls: sourceUrl ? { lastfm: sourceUrl } : undefined
  }
}

async function requestLastFm(
  seed: ISimilarTracksSeed,
  apiKey: string,
  limit: number,
  useMbid: boolean
) {
  const params = new URLSearchParams({
    method: 'track.getsimilar',
    api_key: apiKey,
    format: 'json',
    autocorrect: '1',
    limit: String(limit)
  })
  if (useMbid && seed.recordingMbid) {
    params.set('mbid', seed.recordingMbid)
  } else {
    params.set('artist', seed.artist)
    params.set('track', seed.title)
  }
  // 经 Last.fm 专属串行限流队列
  return await lastFmQueue.schedule(() =>
    requestJson<unknown>(`${LASTFM_URL}?${params.toString()}`)
  )
}

function resolveLastFmApiKey(): string {
  return DEFAULT_LASTFM_API_KEY
}

async function fetchLastFmSimilar(seed: ISimilarTracksSeed, limit: number) {
  const apiKey = resolveLastFmApiKey()
  if (!apiKey) {
    return {
      tracks: [] as ISimilarTrackItem[],
      status: {
        source: 'lastfm',
        status: 'missing-key',
        count: 0
      } satisfies ISimilarTracksProviderStatus
    }
  }
  if (!seed.title || !seed.artist) {
    return {
      tracks: [] as ISimilarTrackItem[],
      status: {
        source: 'lastfm',
        status: 'no-seed',
        count: 0
      } satisfies ISimilarTracksProviderStatus
    }
  }
  const cacheKey = `lf:${seed.recordingMbid ? `mbid:${normalizeKey(seed.recordingMbid)}` : `text:${normalizeKey(seed.artist)}:${normalizeKey(seed.title)}`}:${limit}`
  const cached = await readSimilarCache(cacheKey)
  if (cached) return { tracks: cached.tracks, status: cached.status }
  let rows: JsonObject[] = []
  if (seed.recordingMbid) {
    const byMbid = await requestLastFm(seed, apiKey, limit, true)
    throwIfLastFmError(byMbid)
    rows = extractLastFmRows(byMbid)
  }
  if (!rows.length) {
    const byText = await requestLastFm(seed, apiKey, limit, false)
    throwIfLastFmError(byText)
    rows = extractLastFmRows(byText)
  }
  const tracks = rows.map(transformLastFmTrack).filter((item): item is ISimilarTrackItem => !!item)
  const status = {
    source: 'lastfm',
    status: 'ok',
    count: tracks.length
  } satisfies ISimilarTracksProviderStatus
  await writeSimilarCache(cacheKey, { tracks, status, createdAt: Date.now() })
  return { tracks, status }
}

function mergeTrackIntoMap(map: Map<string, ISimilarTrackItem>, track: ISimilarTrackItem) {
  const key = track.recordingMbid
    ? `mbid:${normalizeKey(track.recordingMbid)}`
    : `text:${normalizeKey(track.artist)}:${normalizeKey(track.title)}`
  const existing = map.get(key)
  if (!existing) {
    map.set(key, { ...track, sources: [...track.sources] })
    return
  }
  existing.album = existing.album || track.album
  existing.recordingMbid = existing.recordingMbid || track.recordingMbid
  existing.artistMbid = existing.artistMbid || track.artistMbid
  existing.releaseMbid = existing.releaseMbid || track.releaseMbid
  existing.coverUrl = existing.coverUrl || track.coverUrl
  existing.sourceScores = {
    ...(existing.sourceScores || {}),
    ...(track.sourceScores || {})
  }
  existing.sourceUrls = {
    ...(existing.sourceUrls || {}),
    ...(track.sourceUrls || {})
  }
  for (const source of track.sources) {
    if (!existing.sources.includes(source)) existing.sources.push(source)
  }
}

function computeFinalScore(track: ISimilarTrackItem): number {
  const listenbrainzScore = track.sourceScores?.listenbrainz
  const lastfmScore = track.sourceScores?.lastfm
  if (typeof listenbrainzScore === 'number' && typeof lastfmScore === 'number') {
    return Math.min(100, Math.round(listenbrainzScore * 0.55 + lastfmScore * 0.35 + 10))
  }
  if (typeof listenbrainzScore === 'number') return clampScore(listenbrainzScore)
  if (typeof lastfmScore === 'number') return clampScore(lastfmScore)
  return clampScore(track.score)
}

function getSourceSortRank(track: ISimilarTrackItem): number {
  return track.sources.includes('listenbrainz') ? 0 : 1
}

function mergeTracks(tracks: ISimilarTrackItem[], limit: number): ISimilarTrackItem[] {
  const map = new Map<string, ISimilarTrackItem>()
  for (const track of tracks) {
    mergeTrackIntoMap(map, track)
  }
  return Array.from(map.values())
    .map((track) => ({
      ...track,
      id: track.recordingMbid || `${normalizeKey(track.artist)}:${normalizeKey(track.title)}`,
      score: computeFinalScore(track)
    }))
    .sort((a, b) => {
      const sourceRankDiff = getSourceSortRank(a) - getSourceSortRank(b)
      if (sourceRankDiff !== 0) return sourceRankDiff
      if (b.score !== a.score) return b.score - a.score
      return a.title.localeCompare(b.title)
    })
    .slice(0, limit)
}

function resolveTagSeed(payload: ISimilarTracksRequest): ISimilarTracksSeed | null {
  const title = normalizeText(payload.title)
  const artist = normalizeText(payload.artist)
  if (!title || !artist) return null
  return {
    title,
    artist,
    album: normalizeText(payload.album) || undefined,
    source: 'tags'
  }
}

async function resolveMusicBrainzSeedFromTags(
  payload: ISimilarTracksRequest
): Promise<ISimilarTracksSeed | null> {
  const tagSeed = resolveTagSeed(payload)
  if (!tagSeed) return null
  try {
    const matches = await searchMusicBrainz({
      filePath: payload.filePath,
      title: tagSeed.title,
      artist: tagSeed.artist,
      album: tagSeed.album,
      durationSeconds: payload.durationSeconds
    })
    const match = matches.find((item) => item.recordingId && item.title && item.artist)
    if (!match) return tagSeed
    return {
      title: match.title,
      artist: match.artist,
      album: match.releaseTitle || tagSeed.album,
      recordingMbid: match.recordingId,
      releaseMbid: match.releaseId,
      score: match.score,
      source: 'tags'
    }
  } catch {
    return tagSeed
  }
}

async function resolveSeed(payload: ISimilarTracksRequest): Promise<ISimilarTracksSeed | null> {
  try {
    const matches = await matchTrackWithAcoustId({
      filePath: payload.filePath,
      durationSeconds: payload.durationSeconds
    })
    const match = matches.find((item) => item.recordingId && item.title && item.artist)
    if (match) {
      return {
        title: match.title,
        artist: match.artist,
        album: match.releaseTitle,
        recordingMbid: match.recordingId,
        releaseMbid: match.releaseId,
        score: match.score,
        source: 'acoustid'
      }
    }
  } catch {
    return await resolveMusicBrainzSeedFromTags(payload)
  }
  return await resolveMusicBrainzSeedFromTags(payload)
}

function failedStatus(source: ISimilarTrackSource, error: unknown): ISimilarTracksProviderStatus {
  const message = error instanceof Error ? error.message : String(error || 'SIMILAR_TRACKS_UNKNOWN')
  return {
    source,
    status: 'error',
    count: 0,
    message
  }
}

async function findSimilarTracks(payload: ISimilarTracksRequest): Promise<ISimilarTracksResult> {
  if (!payload || !payload.filePath) {
    throw new Error('SIMILAR_TRACKS_INVALID_PARAMS')
  }
  const limit = normalizeLimit(payload.limit)
  const seed = await resolveSeed(payload)
  if (!seed) {
    throw new Error('SIMILAR_TRACKS_NO_SEED')
  }
  const [listenbrainzResult, lastFmResult] = await Promise.allSettled([
    fetchListenBrainzSimilar(seed, limit),
    fetchLastFmSimilar(seed, limit)
  ])
  const tracks: ISimilarTrackItem[] = []
  const providerStatus: ISimilarTracksProviderStatus[] = []
  if (listenbrainzResult.status === 'fulfilled') {
    tracks.push(...listenbrainzResult.value.tracks)
    providerStatus.push(listenbrainzResult.value.status)
  } else {
    providerStatus.push(failedStatus('listenbrainz', listenbrainzResult.reason))
  }
  if (lastFmResult.status === 'fulfilled') {
    tracks.push(...lastFmResult.value.tracks)
    providerStatus.push(lastFmResult.value.status)
  } else {
    providerStatus.push(failedStatus('lastfm', lastFmResult.reason))
  }
  return {
    seed,
    tracks: mergeTracks(tracks, limit),
    providerStatus
  }
}

function emitBatchProgress(
  progressId: string,
  now: number,
  total: number,
  isInitial: boolean
): void {
  if (!mainWindow.instance) return
  mainWindow.instance.webContents.send('progressSet', {
    id: progressId,
    titleKey: 'similarTracks.batchProgress',
    now,
    total,
    isInitial,
    cancelable: true,
    cancelChannel: 'similarTracks:cancelBatch',
    cancelPayload: progressId
  })
}

/**
 * 批量查找相似歌曲。
 * 逐首串行调用 findSimilarTracks（天然被各外部源的限流队列约束），
 * 每完成一首通过底部全局进度条上报进度，支持按 progressId 中途取消。
 * 不在此处做「合并去重 / 剔除已拥有」——交给前端处理（前端持有本地库元数据）。
 */
export async function findSimilarTracksBatch(
  payload: ISimilarTracksBatchRequest
): Promise<ISimilarTracksBatchResult> {
  const seeds = Array.isArray(payload?.seeds) ? payload.seeds : []
  const progressId = String(payload?.progressId || '')
  const total = seeds.length
  const perSeed: ISimilarTracksBatchSeedResult[] = []
  let processed = 0
  let emptyCount = 0
  let canceled = false

  canceledBatches.delete(progressId)
  emitBatchProgress(progressId, 0, total, true)

  for (const seed of seeds) {
    if (canceledBatches.has(progressId)) {
      canceled = true
      break
    }
    const seedKey = seed.seedKey || seed.filePath
    try {
      const result = await findSimilarTracks(seed)
      const tracks = result.tracks || []
      const seedResolved = !!result.seed
      perSeed.push({
        seedKey,
        seed: result.seed,
        seedResolved,
        tracks,
        providerStatus: result.providerStatus
      })
      if (!tracks.length) emptyCount += 1
    } catch (error) {
      const errorCode =
        error instanceof Error ? error.message : String(error || 'SIMILAR_TRACKS_UNKNOWN')
      perSeed.push({
        seedKey,
        seedResolved: false,
        tracks: [],
        providerStatus: [],
        errorCode
      })
      emptyCount += 1
    }
    processed += 1
    emitBatchProgress(progressId, processed, total, false)
  }

  // 让底部进度条收尾消失（now===total 触发自动移除）
  emitBatchProgress(progressId, total, total, false)
  canceledBatches.delete(progressId)

  return { perSeed, processed, total, emptyCount, canceled }
}

export function cancelSimilarTracksBatch(progressId: string): void {
  const id = String(progressId || '')
  if (id) canceledBatches.add(id)
  // 清空尚未发出的队列任务，让在跑的批次尽快收尾
  listenBrainzQueue.clear()
  lastFmQueue.clear()
  for (const controller of activeControllers) {
    try {
      controller.abort()
    } catch {}
  }
  activeControllers.clear()
}
