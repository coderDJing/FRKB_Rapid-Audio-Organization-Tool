import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { isMainThread } from 'node:worker_threads'
import { getLibraryDb } from '../libraryDb'
import { loadLibraryNodes, type LibraryNodeRow } from '../libraryTreeDb'
import { resolveCacheListRootAbs } from '../libraryCacheDb'
import store from '../store'
import { getCoreFsDirName } from '../utils'
import type { ISongInfo } from '../../types/globals'
import { log } from '../log'
import { isPackagedRcMainProcess } from './rcDiagnosticEnvironment'
import { beginMainThreadActivity, endMainThreadActivity } from './mainProcessActivityTraceState'
import { verifyPlaylistCacheOffMainThread } from './songListScanWorker'
import { waitForForegroundSongCacheRead } from './foregroundSongCacheRead'
import {
  readSongSearchPageResilient,
  releaseSongSearchRebuildConnection
} from './songSearchRebuildWorker'
import { collectSongSearchTerms } from './songSearchProjection'

type CoreLibraryName = 'FilterLibrary' | 'CuratedLibrary' | 'MixtapeLibrary' | 'RecycleBin'

type SearchDoc = {
  id: string
  filePath: string
  fileName: string
  title: string
  artist: string
  album: string
  genre: string
  label: string
  duration: string
  keyText: string
  bpm?: number
  container: string
  songListUUID: string
  songListName: string
  songListPath: string
  libraryName: CoreLibraryName
  searchText: string
  searchCompact: string
  titleNorm: string
  artistNorm: string
  albumNorm: string
  genreNorm: string
  labelNorm: string
  keyNorm: string
  containerNorm: string
  fileNameNorm: string
  songListNameNorm: string
  pathNorm: string
}

type PlaylistMeta = {
  uuid: string
  dirName: string
  relPath: string
  absPath: string
  normalizedAbsPath: string
  libraryName: CoreLibraryName
}

type GlobalSongSearchResultItem = {
  id: string
  filePath: string
  fileName: string
  title: string
  artist: string
  album: string
  genre: string
  label: string
  duration: string
  keyText: string
  bpm?: number
  container: string
  songListUUID: string
  songListName: string
  songListPath: string
  libraryName: CoreLibraryName
  score: number
}

type GlobalSongSearchQueryResult = {
  items: GlobalSongSearchResultItem[]
  tookMs: number
  indexedCount: number
  snapshotAt: number
}

type PlaylistFastLoadResult = {
  hit: boolean
  items: ISongInfo[]
  missingWaveformFilePaths: string[]
  tookMs: number
  snapshotAt: number
  /** 命中时带上扫描根与文件身份摘要，调用方据此把视图快照补上（见 songSearchHandlers）。 */
  listRoot: string
  identityDigest: string
}

export type MarkGlobalSongSearchDirtyOptions = {
  songListUUID?: string
  songListUUIDs?: string[]
}

const SEARCH_MAX_LIMIT = 200
const DEFAULT_LIMIT = 80
const AUTO_REBUILD_AGE_MS = 20000
const SEARCH_REBUILD_YIELD_EVERY_ROWS = 40
const SEARCH_REBUILD_DB_PAGE_ROWS = 160
const PLAYLIST_SCAN_PAUSE_MS = 15_000

type EnsureReadyOptions = {
  allowDirtyStale?: boolean
  allowAgedStale?: boolean
}

const CORE_LIBRARY_NAME_SET = new Set<CoreLibraryName>([
  'FilterLibrary',
  'CuratedLibrary',
  'MixtapeLibrary',
  'RecycleBin'
])

const normalizePathForCompare = (input: string) => {
  if (!input) return ''
  let resolved = path.resolve(input).replace(/\\/g, '/')
  resolved = resolved.replace(/\/+$/g, '')
  if (process.platform === 'win32') {
    resolved = resolved.toLowerCase()
  }
  return resolved
}

const normalizeText = (input: unknown) => {
  const text = String(input || '').trim()
  if (!text) return ''
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')
}

const compactText = (input: string) => input.replace(/\s+/g, '')

const splitQueryTokens = (input: string) =>
  input
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

const buildNgramSet = (input: string, n: number) => {
  const result = new Set<string>()
  if (!input || n <= 0) return result
  if (input.length <= n) {
    result.add(input)
    return result
  }
  for (let i = 0; i <= input.length - n; i += 1) {
    result.add(input.slice(i, i + n))
  }
  return result
}

const addToInvertedIndex = (
  index: Map<string, Set<number>>,
  terms: Iterable<string>,
  docIndex: number
) => {
  for (const term of terms) {
    if (!term) continue
    const bucket = index.get(term)
    if (bucket) {
      bucket.add(docIndex)
    } else {
      index.set(term, new Set<number>([docIndex]))
    }
  }
}

const intersectSets = (a: Set<number>, b: Set<number>) => {
  if (a.size === 0 || b.size === 0) return new Set<number>()
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  const result = new Set<number>()
  for (const item of small) {
    if (large.has(item)) result.add(item)
  }
  return result
}

const resolveCoreLibraryName = (value: string): CoreLibraryName => {
  if (CORE_LIBRARY_NAME_SET.has(value as CoreLibraryName)) {
    return value as CoreLibraryName
  }
  return 'FilterLibrary'
}

const buildNodePathMap = (rows: readonly LibraryNodeRow[]) => {
  const byUuid = new Map<string, LibraryNodeRow>()
  const childrenByParent = new Map<string, LibraryNodeRow[]>()
  for (const row of rows) {
    byUuid.set(row.uuid, row)
    if (!row.parentUuid) continue
    const list = childrenByParent.get(row.parentUuid)
    if (list) {
      list.push(row)
    } else {
      childrenByParent.set(row.parentUuid, [row])
    }
  }
  const root = rows.find((row) => row.parentUuid === null && row.nodeType === 'root')
  if (!root) return new Map<string, string>()
  const pathByUuid = new Map<string, string>()
  pathByUuid.set(root.uuid, root.dirName)
  const queue: LibraryNodeRow[] = [root]
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i]
    const basePath = pathByUuid.get(current.uuid)
    if (!basePath) continue
    const children = childrenByParent.get(current.uuid) || []
    for (const child of children) {
      const childPath = path.join(basePath, child.dirName)
      if (!pathByUuid.has(child.uuid)) {
        pathByUuid.set(child.uuid, childPath)
      }
      queue.push(child)
    }
  }
  return pathByUuid
}

const resolveLibraryNameByRelativePath = (relativePath: string): CoreLibraryName => {
  const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (segments.length < 2) return 'FilterLibrary'
  const fsName = segments[1]
  const coreMap = new Map<string, CoreLibraryName>([
    [getCoreFsDirName('FilterLibrary'), 'FilterLibrary'],
    [getCoreFsDirName('CuratedLibrary'), 'CuratedLibrary'],
    [getCoreFsDirName('MixtapeLibrary'), 'MixtapeLibrary'],
    [getCoreFsDirName('RecycleBin'), 'RecycleBin']
  ])
  return coreMap.get(fsName) || resolveCoreLibraryName(fsName)
}

const resolveListRootAbsolute = (listRootRaw: string) => {
  const resolvedFromCache = resolveCacheListRootAbs(listRootRaw)
  if (resolvedFromCache) return resolvedFromCache
  if (path.isAbsolute(listRootRaw)) return listRootRaw
  if (store.databaseDir) return path.join(store.databaseDir, listRootRaw)
  return listRootRaw
}

const yieldToNodeMainLoop = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve)
  })

class GlobalSongSearchEngine {
  private docs: SearchDoc[] = []
  private allDocIndices: number[] = []
  private trigramIndex = new Map<string, Set<number>>()
  private bigramIndex = new Map<string, Set<number>>()
  private charIndex = new Map<string, Set<number>>()
  private indexedPlaylistIds = new Set<string>()
  private knownPlaylists = new Set<string>()

  private dirty = true
  private dirtyPlaylists = new Set<string>()
  private ready = false
  private lastBuiltAt = 0
  private buildingPromise: Promise<void> | null = null

  markDirty(_reason?: string, options?: MarkGlobalSongSearchDirtyOptions) {
    const uuids = [
      ...(typeof options?.songListUUID === 'string' ? [options.songListUUID] : []),
      ...(Array.isArray(options?.songListUUIDs) ? options.songListUUIDs : [])
    ]
      .map((uuid) => String(uuid || '').trim())
      .filter(Boolean)

    this.dirty = true
    if (uuids.length === 0) {
      for (const uuid of this.knownPlaylists) this.dirtyPlaylists.add(uuid)
      return
    }
    for (const uuid of uuids) this.dirtyPlaylists.add(uuid)
  }

  getStats() {
    return {
      ready: this.ready,
      dirty: this.dirty,
      dirtyPlaylistCount: this.dirtyPlaylists.size,
      indexedCount: this.docs.length,
      playlistCount: this.indexedPlaylistIds.size,
      snapshotAt: this.lastBuiltAt
    }
  }

  async warmup(force = false) {
    await this.ensureReady(force)
    return this.getStats()
  }

  async query(keyword: string, limit = DEFAULT_LIMIT): Promise<GlobalSongSearchQueryResult> {
    const started = Date.now()
    await this.ensureReady(false, { allowDirtyStale: true, allowAgedStale: true })

    const normalizedKeyword = normalizeText(keyword)
    const tokens = splitQueryTokens(normalizedKeyword)
    if (!tokens.length) {
      return {
        items: [],
        tookMs: Date.now() - started,
        indexedCount: this.docs.length,
        snapshotAt: this.lastBuiltAt
      }
    }

    const safeLimit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Number(limit) || DEFAULT_LIMIT))
    let candidateSet: Set<number> | null = null
    for (const token of tokens) {
      const indexedCandidates = this.getIndexedCandidatesByToken(token)
      if (indexedCandidates) {
        candidateSet = candidateSet
          ? intersectSets(candidateSet, indexedCandidates)
          : indexedCandidates
      }
      if (candidateSet && candidateSet.size === 0) {
        return {
          items: [],
          tookMs: Date.now() - started,
          indexedCount: this.docs.length,
          snapshotAt: this.lastBuiltAt
        }
      }
    }

    const candidateIndices = candidateSet ? Array.from(candidateSet) : this.allDocIndices
    const scored: GlobalSongSearchResultItem[] = []
    for (const docIndex of candidateIndices) {
      const doc = this.docs[docIndex]
      if (!doc) continue
      const matched = tokens.every(
        (token) => doc.searchText.includes(token) || doc.searchCompact.includes(token)
      )
      if (!matched) continue
      const score = this.calculateScore(doc, tokens)
      scored.push({
        id: doc.id,
        filePath: doc.filePath,
        fileName: doc.fileName,
        title: doc.title,
        artist: doc.artist,
        album: doc.album,
        genre: doc.genre,
        label: doc.label,
        duration: doc.duration,
        keyText: doc.keyText,
        bpm: doc.bpm,
        container: doc.container,
        songListUUID: doc.songListUUID,
        songListName: doc.songListName,
        songListPath: doc.songListPath,
        libraryName: doc.libraryName,
        score
      })
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const titleCmp = a.title.localeCompare(b.title, 'zh-CN', { sensitivity: 'base' })
      if (titleCmp !== 0) return titleCmp
      const artistCmp = a.artist.localeCompare(b.artist, 'zh-CN', { sensitivity: 'base' })
      if (artistCmp !== 0) return artistCmp
      return a.filePath.localeCompare(b.filePath, 'zh-CN', { sensitivity: 'base' })
    })

    return {
      items: scored.slice(0, safeLimit),
      tookMs: Date.now() - started,
      indexedCount: this.docs.length,
      snapshotAt: this.lastBuiltAt
    }
  }

  async getPlaylistFastLoad(songListUUID: string): Promise<PlaylistFastLoadResult> {
    const started = Date.now()
    const normalizedUuid = String(songListUUID || '').trim()
    const miss = (): PlaylistFastLoadResult => ({
      hit: false,
      items: [],
      missingWaveformFilePaths: [],
      tookMs: Date.now() - started,
      snapshotAt: this.lastBuiltAt,
      listRoot: '',
      identityDigest: ''
    })
    if (!normalizedUuid) return miss()

    // 打开歌单不能等全库索引重建；核对走 worker，搜歌索引在后台补。
    if (!this.ready) this.startBackgroundRebuild('playlist-fast-load-cold')
    else if (this.dirty) this.startBackgroundRebuild('playlist-fast-load-dirty')

    const playlistMeta = this.findPlaylistMetaByUuid(normalizedUuid)
    if (!playlistMeta?.absPath) return miss()

    try {
      const verified = await verifyPlaylistCacheOffMainThread({
        scanPath: playlistMeta.absPath,
        audioExt: store.settingConfig.audioExt || [],
        songListUUID: normalizedUuid,
        databaseDir: store.databaseDir
      })
      if (!verified?.cacheIdentityVerified) return miss()
      this.dirtyPlaylists.delete(normalizedUuid)
      this.indexedPlaylistIds.add(normalizedUuid)
      return {
        hit: true,
        items: verified.scanData,
        missingWaveformFilePaths: Array.isArray(verified.missingWaveformFilePaths)
          ? verified.missingWaveformFilePaths
          : [],
        tookMs: Date.now() - started,
        snapshotAt: this.lastBuiltAt,
        listRoot: playlistMeta.absPath,
        identityDigest: String(verified.identityDigest || '')
      }
    } catch {
      return miss()
    }
  }

  private getOrCreateRebuildTask() {
    if (!this.buildingPromise) {
      // 不能从 IPC 调用栈直接进入 rebuild：async 函数会在首个 await 前同步执行，
      // 曾经这里的 SQLite 全量 .all() 会让“打开歌单”连 loading 都来不及画出。
      this.buildingPromise = new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          void this.rebuild().then(resolve, reject)
        })
      }).finally(() => {
        this.buildingPromise = null
      })
    }
    return this.buildingPromise
  }

  private startBackgroundRebuild(reason: string) {
    void this.getOrCreateRebuildTask().catch((error) => {
      log.error(`[song-search] rebuild failed (${reason})`, error)
    })
  }

  private async ensureReady(force = false, options?: EnsureReadyOptions) {
    const stale = Date.now() - this.lastBuiltAt > AUTO_REBUILD_AGE_MS
    const allowDirtyStale = options?.allowDirtyStale === true
    const allowAgedStale = options?.allowAgedStale === true
    const canUseCurrentSnapshot = this.ready && this.docs.length > 0

    if (force || !this.ready) {
      await this.getOrCreateRebuildTask()
      return
    }

    if (this.dirty) {
      if (allowDirtyStale && canUseCurrentSnapshot) {
        this.startBackgroundRebuild('dirty')
        return
      }
      await this.getOrCreateRebuildTask()
      return
    }

    if (stale) {
      if (allowAgedStale && canUseCurrentSnapshot) {
        this.startBackgroundRebuild('stale')
        return
      }
      await this.getOrCreateRebuildTask()
    }
  }

  private async rebuild() {
    const db = getLibraryDb()
    if (!db) {
      this.docs = []
      this.allDocIndices = []
      this.trigramIndex = new Map()
      this.bigramIndex = new Map()
      this.charIndex = new Map()
      this.indexedPlaylistIds = new Set()
      this.knownPlaylists = new Set()
      this.lastBuiltAt = Date.now()
      this.ready = true
      this.dirty = false
      this.dirtyPlaylists = new Set()
      return
    }

    const playlistInfo = this.buildPlaylistMeta()
    const docs: SearchDoc[] = []
    const trigramIndex = new Map<string, Set<number>>()
    const bigramIndex = new Map<string, Set<number>>()
    const charIndex = new Map<string, Set<number>>()
    const indexedPlaylistIds = new Set<string>()
    const knownPlaylists = new Set<string>(playlistInfo.knownUuids)

    let processedRows = 0
    let lastRowId = 0
    const readMode = {
      useInProcess: !isMainThread || db.inTransaction || db.memory,
      loggedFailure: false
    }
    const rcDiagnostics = isPackagedRcMainProcess()
    const rebuildStartedAt = performance.now()
    let lastRebuildProgressLogAt = rebuildStartedAt
    let pageActivityId: number | null = null
    const endPageActivity = () => {
      if (pageActivityId === null) return
      endMainThreadActivity(pageActivityId)
      pageActivityId = null
    }
    // 15 秒是这一次重建的总等待预算。只避开正在读缓存的 worker，扫完后的修复不再占着它。
    const foregroundReadPauseDeadline = Date.now() + PLAYLIST_SCAN_PAUSE_MS
    try {
      while (getLibraryDb() === db) {
        await waitForForegroundSongCacheRead(foregroundReadPauseDeadline)
        if (getLibraryDb() !== db) return
        const queryStartedAt = performance.now()
        const page = await readSongSearchPageResilient(
          db,
          lastRowId,
          SEARCH_REBUILD_DB_PAGE_ROWS,
          readMode
        )
        const queryMs = performance.now() - queryStartedAt
        if (page.length === 0 || getLibraryDb() !== db) break

        pageActivityId = beginMainThreadActivity({
          kind: 'sync',
          name: 'song-search:rebuild-page'
        })
        try {
          for (const row of page) {
            processedRows += 1
            if (Number.isFinite(row.rowId) && row.rowId > lastRowId) lastRowId = row.rowId
            if (!row.listRoot) continue

            const listRootAbs = resolveListRootAbsolute(row.listRoot)
            const normalizedListRoot = normalizePathForCompare(listRootAbs)
            let playlist = playlistInfo.byAbsPath.get(normalizedListRoot)
            if (!playlist) {
              playlist = this.findPlaylistByPrefix(playlistInfo.byAbsPath, normalizedListRoot)
            }

            const filePathRaw = row.filePathColumn.trim()
            const fallbackAbsPath = !filePathRaw
              ? ''
              : path.isAbsolute(filePathRaw)
                ? filePathRaw
                : listRootAbs
                  ? path.join(listRootAbs, filePathRaw)
                  : filePathRaw
            const filePath = String(row.parsedFilePath || fallbackAbsPath).trim()
            if (!filePath) continue

            const songListUUID = playlist?.uuid || ''
            const songListName = playlist?.dirName || ''
            const songListPath = playlist?.relPath ? playlist.relPath.replace(/\\/g, '/') : ''
            const libraryName = playlist?.libraryName || 'FilterLibrary'
            const fileName = row.fileName || path.basename(filePath)
            const searchText = normalizeText(
              collectSongSearchTerms({
                title: row.title || fileName,
                artist: row.artist,
                album: row.album,
                genre: row.genre,
                label: row.label,
                fileName,
                fileFormat: row.fileFormat,
                container: row.container,
                duration: row.duration,
                bitrate: row.bitrate,
                keyText: row.keyText,
                bpm: row.bpm,
                libraryName,
                songListUUID,
                songListName,
                songListPath,
                filePath,
                extendedText: row.extendedText
              })
                .filter(
                  (item) => item !== undefined && item !== null && String(item).trim().length > 0
                )
                .join(' ')
            )
            if (!searchText) continue

            const searchCompact = compactText(searchText)
            const docIndex = docs.length
            docs.push({
              id: `${songListUUID || 'unknown'}|${filePath}|${docIndex}`,
              filePath,
              fileName,
              title: row.title || fileName,
              artist: row.artist,
              album: row.album,
              genre: row.genre,
              label: row.label,
              duration: row.duration,
              keyText: row.keyText,
              bpm: row.bpm ?? undefined,
              container: row.container,
              songListUUID,
              songListName,
              songListPath,
              libraryName,
              searchText,
              searchCompact,
              titleNorm: normalizeText(row.title || fileName),
              artistNorm: normalizeText(row.artist),
              albumNorm: normalizeText(row.album),
              genreNorm: normalizeText(row.genre),
              labelNorm: normalizeText(row.label),
              keyNorm: normalizeText(row.keyText),
              containerNorm: normalizeText(row.container),
              fileNameNorm: normalizeText(fileName),
              songListNameNorm: normalizeText(songListName),
              pathNorm: normalizeText(filePath)
            })
            addToInvertedIndex(charIndex, searchCompact.split('').filter(Boolean), docIndex)
            addToInvertedIndex(bigramIndex, buildNgramSet(searchCompact, 2), docIndex)
            addToInvertedIndex(trigramIndex, buildNgramSet(searchCompact, 3), docIndex)
            if (songListUUID) indexedPlaylistIds.add(songListUUID)

            if (processedRows % SEARCH_REBUILD_YIELD_EVERY_ROWS === 0) {
              endPageActivity()
              await yieldToNodeMainLoop()
              if (getLibraryDb() !== db) return
              pageActivityId = beginMainThreadActivity({
                kind: 'sync',
                name: 'song-search:rebuild-page'
              })
            }
          }
        } finally {
          endPageActivity()
        }

        if (rcDiagnostics && queryMs >= 1000) {
          log.warn('[song-search] slow rebuild page', {
            queryMs: Math.round(queryMs),
            offMainThread: !readMode.useInProcess,
            rowCount: page.length,
            lastRowId,
            processedRows
          })
        }
        const rebuildElapsedMs = performance.now() - rebuildStartedAt
        if (
          rcDiagnostics &&
          rebuildElapsedMs >= 5000 &&
          performance.now() - lastRebuildProgressLogAt >= 5000
        ) {
          lastRebuildProgressLogAt = performance.now()
          log.warn('[song-search] rebuild still running', {
            elapsedMs: Math.round(rebuildElapsedMs),
            processedRows,
            lastQueryMs: Math.round(queryMs),
            lastRowId
          })
        }
        await yieldToNodeMainLoop()
      }
    } finally {
      endPageActivity()
      await releaseSongSearchRebuildConnection().catch(() => undefined)
    }

    if (getLibraryDb() !== db) return

    this.docs = docs
    this.allDocIndices = docs.map((_, index) => index)
    this.trigramIndex = trigramIndex
    this.bigramIndex = bigramIndex
    this.charIndex = charIndex
    this.indexedPlaylistIds = indexedPlaylistIds
    this.knownPlaylists = knownPlaylists
    this.lastBuiltAt = Date.now()
    this.ready = true
    this.dirty = false
    this.dirtyPlaylists = new Set()
  }

  private getIndexedCandidatesByToken(token: string) {
    const normalized = compactText(normalizeText(token))
    if (!normalized) return null
    if (normalized.length === 1) {
      return this.charIndex.get(normalized) || new Set<number>()
    }
    if (normalized.length === 2) {
      return this.bigramIndex.get(normalized) || new Set<number>()
    }
    const trigrams = Array.from(buildNgramSet(normalized, 3))
    if (!trigrams.length) return null
    let merged: Set<number> | null = null
    for (const gram of trigrams) {
      const bucket = this.trigramIndex.get(gram)
      if (!bucket) return new Set<number>()
      merged = merged ? intersectSets(merged, bucket) : new Set<number>(bucket)
      if (merged.size === 0) return merged
    }
    return merged
  }

  private calculateScore(doc: SearchDoc, tokens: string[]) {
    let score = 0
    for (const rawToken of tokens) {
      const token = compactText(rawToken)
      if (!token) continue
      if (doc.titleNorm.startsWith(token)) {
        score += 60
      } else if (doc.titleNorm.includes(token)) {
        score += 40
      }
      if (doc.artistNorm.includes(token)) score += 25
      if (doc.albumNorm.includes(token)) score += 22
      if (doc.genreNorm.includes(token)) score += 20
      if (doc.labelNorm.includes(token)) score += 18
      if (doc.fileNameNorm.includes(token)) score += 20
      if (doc.keyNorm.includes(token)) score += 16
      if (doc.containerNorm.includes(token)) score += 14
      if (doc.songListNameNorm.includes(token)) score += 14
      if (doc.pathNorm.includes(token)) score += 10
    }
    return score
  }

  private buildPlaylistMeta(): {
    byAbsPath: Map<string, PlaylistMeta>
    knownUuids: Set<string>
  } {
    const rows = loadLibraryNodes(store.databaseDir) || []
    const byAbsPath = new Map<string, PlaylistMeta>()
    const knownUuids = new Set<string>()
    if (!rows.length || !store.databaseDir) return { byAbsPath, knownUuids }

    const pathByUuid = buildNodePathMap(rows)
    for (const row of rows) {
      if (row.nodeType !== 'songList' && row.nodeType !== 'mixtapeList') continue
      const relPath = pathByUuid.get(row.uuid)
      if (!relPath) continue
      const absPath = path.join(store.databaseDir, relPath)
      const normalizedAbsPath = normalizePathForCompare(absPath)
      const libraryName = resolveLibraryNameByRelativePath(relPath)
      knownUuids.add(row.uuid)
      byAbsPath.set(normalizedAbsPath, {
        uuid: row.uuid,
        dirName: row.dirName,
        relPath,
        absPath,
        normalizedAbsPath,
        libraryName
      })
    }
    return { byAbsPath, knownUuids }
  }

  private findPlaylistByPrefix(
    map: Map<string, PlaylistMeta>,
    normalizedListRoot: string
  ): PlaylistMeta | undefined {
    if (!normalizedListRoot) return undefined
    let matched: PlaylistMeta | undefined
    for (const meta of map.values()) {
      if (!meta.normalizedAbsPath) continue
      if (
        normalizedListRoot === meta.normalizedAbsPath ||
        normalizedListRoot.startsWith(`${meta.normalizedAbsPath}/`)
      ) {
        if (!matched || meta.normalizedAbsPath.length > matched.normalizedAbsPath.length) {
          matched = meta
        }
      }
    }
    return matched
  }

  private findPlaylistMetaByUuid(uuid: string): PlaylistMeta | undefined {
    const playlistInfo = this.buildPlaylistMeta()
    for (const meta of playlistInfo.byAbsPath.values()) {
      if (meta.uuid === uuid) return meta
    }
    return undefined
  }
}

const globalSongSearchEngine = new GlobalSongSearchEngine()

export const markGlobalSongSearchDirty = (
  reason?: string,
  options?: MarkGlobalSongSearchDirtyOptions
) => {
  globalSongSearchEngine.markDirty(reason, options)
}

export default globalSongSearchEngine
