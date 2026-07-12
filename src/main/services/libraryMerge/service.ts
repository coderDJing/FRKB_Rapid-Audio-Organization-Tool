import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { MANIFEST_FILE_NAME, readManifestFile } from '../../databaseManifest'
import {
  buildLibraryMergePlan,
  normalizeLibraryMergeCacheFilePath,
  normalizeLibraryMergeCacheRoot
} from './plan'
import {
  LibraryMergeError,
  type LibraryMergeOptions,
  type LibraryMergePhase,
  type LibraryMergePlanSummary,
  type LibraryMergeProgress,
  type LibraryMergeResult
} from './types'

type SqliteDatabase = InstanceType<typeof import('better-sqlite3')>

type Journal = {
  version: 1
  jobId: string
  mode: 'copy' | 'delete-source'
  sourceRoot: string
  targetRoot: string
  sourceManifestUuid: string
  targetManifestUuid: string
  phase: LibraryMergePhase
  promotionIntents: string[]
  promotedRoots: string[]
  directoryIntents: string[]
  createdDirectories: string[]
  fileHashes: Record<string, string>
}

type TargetFileStat = {
  targetAbs: string
  size: number
  mtimeMs: number
}

const CACHE_TABLES = [
  'song_cache',
  'cover_index',
  'waveform_cache',
  'compact_visual_waveform_cache',
  'unified_display_waveform_cache',
  'waveform_surface_cache',
  'pioneer_preview_waveform_cache'
]

const DB_FILE_NAME = 'FRKB.database.sqlite'
const MERGE_WORK_DIR_NAME = '.frkb-merge'
const MERGE_LOCK_FILE_NAME = '.frkb-merge.lock'

let activeMerge = false

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message
  return String(error || 'unknown error')
}

const quoteIdentifier = (value: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new LibraryMergeError('DATABASE_SCHEMA_INVALID', `非法数据库标识符：${value}`)
  }
  return `"${value}"`
}

const getDatabaseCtor = (): typeof import('better-sqlite3') =>
  require('better-sqlite3') as typeof import('better-sqlite3')

const readJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

const writeJsonDurably = async (filePath: string, value: unknown): Promise<void> => {
  const tempPath = `${filePath}.next`
  const body = `${JSON.stringify(value, null, 2)}\n`
  await fs.writeFile(tempPath, body, 'utf8')
  const file = await fs.open(tempPath, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  await fs.rename(tempPath, filePath)
  try {
    const parent = await fs.open(path.dirname(filePath), 'r')
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
  } catch {
    // 部分平台不允许同步目录；文件本身已完成 fsync。
  }
}

const writeJournal = async (filePath: string, journal: Journal): Promise<void> => {
  await writeJsonDurably(filePath, journal)
}

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

const getAvailableBytes = async (targetRoot: string): Promise<number> => {
  try {
    const stats = await fs.statfs(targetRoot)
    const available = Number(stats.bavail) * Number(stats.bsize)
    if (Number.isFinite(available) && available >= 0) return available
  } catch {}
  throw new LibraryMergeError('CAPACITY_UNAVAILABLE', '无法读取目标磁盘可用空间')
}

const assertRemainingTargetCapacity = async (params: {
  targetRoot: string
  requiredBytes: number
  alreadyReservedBytes: number
}): Promise<void> => {
  const availableBytes = await getAvailableBytes(params.targetRoot)
  const requiredRemainingBytes = Math.max(0, params.requiredBytes - params.alreadyReservedBytes)
  if (availableBytes >= requiredRemainingBytes) return
  throw new LibraryMergeError(
    'INSUFFICIENT_SPACE',
    `目标磁盘可用空间不足，还需要 ${requiredRemainingBytes - availableBytes} 字节`
  )
}

const assertSourceRootIdentity = async (
  sourceRoot: string,
  manifestUuid: string
): Promise<void> => {
  const rootStat = await fs.lstat(sourceRoot).catch(() => null)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new LibraryMergeError('SOURCE_CHANGED', `来源库根目录已变化：${sourceRoot}`)
  }
  let manifest: Awaited<ReturnType<typeof readManifestFile>>
  try {
    manifest = await readManifestFile(path.join(sourceRoot, MANIFEST_FILE_NAME))
  } catch {
    throw new LibraryMergeError('SOURCE_CHANGED', `来源库清单已变化：${sourceRoot}`)
  }
  if (manifest.uuid !== manifestUuid) {
    throw new LibraryMergeError('SOURCE_CHANGED', '来源库已被替换，已停止来源清理')
  }
}

const isExpectedSourceRoot = async (sourceRoot: string, manifestUuid: string): Promise<boolean> => {
  try {
    await assertSourceRootIdentity(sourceRoot, manifestUuid)
    return true
  } catch {
    return false
  }
}

const isPathInside = (parentPath: string, targetPath: string): boolean => {
  const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath))
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

const fsyncFile = async (filePath: string): Promise<void> => {
  const handle = await fs.open(filePath, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const copyWithHash = async (sourcePath: string, targetPartPath: string): Promise<string> => {
  const hash = createHash('sha256')
  const source = createReadStream(sourcePath)
  source.on('data', (chunk: Buffer) => hash.update(chunk))
  await pipeline(source, createWriteStream(targetPartPath, { flags: 'wx' }))
  await fsyncFile(targetPartPath)
  return hash.digest('hex')
}

const hashFile = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

const getTableColumns = (db: SqliteDatabase, tableName: string): string[] => {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<
    Record<string, unknown>
  >
  return rows
    .map((row) => (typeof row.name === 'string' ? row.name : ''))
    .filter((column): column is string => !!column)
}

const getPathKey = (value: string): string => {
  const resolved = path.resolve(value)
  return resolved.toLocaleLowerCase()
}

const hasTable = (db: SqliteDatabase, tableName: string): boolean => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as Record<string, unknown> | undefined
  return typeof row?.name === 'string'
}

const remapSourcePath = (params: {
  value: unknown
  sourceRoot: string
  sourceFilePathToTarget: Map<string, string>
  sourceNodePaths: Array<{ sourceAbs: string; targetAbs: string }>
}): string | null => {
  const raw = typeof params.value === 'string' ? params.value.trim() : ''
  if (!raw) return null
  const sourceAbs = path.resolve(raw)
  const exactTarget = params.sourceFilePathToTarget.get(getPathKey(sourceAbs))
  if (exactTarget) return exactTarget
  if (!path.isAbsolute(raw) || !isPathInside(params.sourceRoot, sourceAbs)) return raw
  const candidateNodes = [...params.sourceNodePaths].sort(
    (left, right) => right.sourceAbs.length - left.sourceAbs.length
  )
  for (const node of candidateNodes) {
    if (!isPathInside(node.sourceAbs, sourceAbs)) continue
    return path.join(node.targetAbs, path.relative(node.sourceAbs, sourceAbs))
  }
  throw new LibraryMergeError('SOURCE_DATA_INVALID', `来源路径无法重写：${raw}`)
}

const rebaseOptionalJson = (params: {
  raw: unknown
  sourceRoot: string
  sourceFilePathToTarget: Map<string, string>
  sourceNodePaths: Array<{ sourceAbs: string; targetAbs: string }>
  resetStemState?: boolean
  description: string
}): string | null => {
  if (params.raw === null || params.raw === undefined || params.raw === '') return null
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(String(params.raw)) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid json')
    parsed = { ...(value as Record<string, unknown>) }
  } catch {
    throw new LibraryMergeError('SOURCE_DATA_INVALID', `来源库的 ${params.description} 无法解析`)
  }
  if (typeof parsed.filePath === 'string') {
    parsed.filePath = remapSourcePath({
      value: parsed.filePath,
      sourceRoot: params.sourceRoot,
      sourceFilePathToTarget: params.sourceFilePathToTarget,
      sourceNodePaths: params.sourceNodePaths
    })
  }
  if (params.resetStemState) {
    for (const key of [
      'stemError',
      'stemReadyAt',
      'stemModel',
      'stemVersion',
      'stemVocalPath',
      'stemInstPath',
      'stemBassPath',
      'stemDrumsPath'
    ]) {
      delete parsed[key]
    }
    parsed.stemStatus = 'pending'
  }
  return JSON.stringify(parsed)
}

const copySpecialRows = (params: {
  sourceDb: SqliteDatabase
  targetDb: SqliteDatabase
  sourceRoot: string
  sourceFilePathToTarget: Map<string, string>
  sourceNodePaths: Array<{ sourceAbs: string; targetAbs: string }>
  nodeUuidMap: Map<string, string>
}): number => {
  const copyItems = (tableName: 'set_items' | 'mixtape_items'): number => {
    if (!hasTable(params.sourceDb, tableName) || !hasTable(params.targetDb, tableName)) return 0
    const columns = getTableColumns(params.sourceDb, tableName)
    const targetColumns = new Set(getTableColumns(params.targetDb, tableName))
    if (columns.some((column) => !targetColumns.has(column))) {
      throw new LibraryMergeError('SOURCE_SCHEMA_UNSUPPORTED', `无法迁移 ${tableName} 的字段结构`)
    }
    const selectColumns = columns.map(quoteIdentifier).join(', ')
    const placeholders = columns.map(() => '?').join(', ')
    const insert = params.targetDb.prepare(
      `INSERT INTO ${quoteIdentifier(tableName)} (${selectColumns}) VALUES (${placeholders})`
    )
    const rows = params.sourceDb
      .prepare(`SELECT ${selectColumns} FROM ${quoteIdentifier(tableName)}`)
      .all() as Array<Record<string, unknown>>
    let copied = 0
    for (const row of rows) {
      const playlistUuid = typeof row.playlist_uuid === 'string' ? row.playlist_uuid.trim() : ''
      const targetPlaylistUuid = params.nodeUuidMap.get(playlistUuid)
      if (!targetPlaylistUuid) {
        throw new LibraryMergeError('SOURCE_DATA_INVALID', `${tableName} 的歌单映射丢失`)
      }
      const nextRow: Record<string, unknown> = {
        ...row,
        id: randomUUID(),
        playlist_uuid: targetPlaylistUuid
      }
      nextRow.file_path = remapSourcePath({
        value: row.file_path,
        sourceRoot: params.sourceRoot,
        sourceFilePathToTarget: params.sourceFilePathToTarget,
        sourceNodePaths: params.sourceNodePaths
      })
      if (columns.includes('origin_playlist_uuid')) {
        const originUuid =
          typeof row.origin_playlist_uuid === 'string' ? row.origin_playlist_uuid.trim() : ''
        nextRow.origin_playlist_uuid = originUuid
          ? params.nodeUuidMap.get(originUuid) || null
          : null
      }
      if (columns.includes('origin_path_snapshot')) {
        nextRow.origin_path_snapshot = remapSourcePath({
          value: row.origin_path_snapshot,
          sourceRoot: params.sourceRoot,
          sourceFilePathToTarget: params.sourceFilePathToTarget,
          sourceNodePaths: params.sourceNodePaths
        })
      }
      if (tableName === 'set_items' && columns.includes('analysis_json')) {
        nextRow.analysis_json = rebaseOptionalJson({
          raw: row.analysis_json,
          sourceRoot: params.sourceRoot,
          sourceFilePathToTarget: params.sourceFilePathToTarget,
          sourceNodePaths: params.sourceNodePaths,
          description: 'set_items.analysis_json'
        })
      }
      if (tableName === 'mixtape_items' && columns.includes('info_json')) {
        nextRow.info_json = rebaseOptionalJson({
          raw: row.info_json,
          sourceRoot: params.sourceRoot,
          sourceFilePathToTarget: params.sourceFilePathToTarget,
          sourceNodePaths: params.sourceNodePaths,
          resetStemState: true,
          description: 'mixtape_items.info_json'
        })
      }
      insert.run(...columns.map((column) => nextRow[column] ?? null))
      copied += 1
    }
    return copied
  }

  const copyProjects = (): number => {
    const tableName = 'mixtape_projects'
    if (!hasTable(params.sourceDb, tableName) || !hasTable(params.targetDb, tableName)) return 0
    const columns = getTableColumns(params.sourceDb, tableName)
    const targetColumns = new Set(getTableColumns(params.targetDb, tableName))
    if (columns.some((column) => !targetColumns.has(column))) {
      throw new LibraryMergeError(
        'SOURCE_SCHEMA_UNSUPPORTED',
        '无法迁移 mixtape_projects 的字段结构'
      )
    }
    const selectColumns = columns.map(quoteIdentifier).join(', ')
    const placeholders = columns.map(() => '?').join(', ')
    const insert = params.targetDb.prepare(
      `INSERT INTO ${quoteIdentifier(tableName)} (${selectColumns}) VALUES (${placeholders})`
    )
    const rows = params.sourceDb
      .prepare(`SELECT ${selectColumns} FROM ${quoteIdentifier(tableName)}`)
      .all() as Array<Record<string, unknown>>
    let copied = 0
    for (const row of rows) {
      const sourcePlaylistUuid =
        typeof row.playlist_uuid === 'string' ? row.playlist_uuid.trim() : ''
      const targetPlaylistUuid = params.nodeUuidMap.get(sourcePlaylistUuid)
      if (!targetPlaylistUuid) {
        throw new LibraryMergeError('SOURCE_DATA_INVALID', 'mixtape_projects 的歌单映射丢失')
      }
      const nextRow: Record<string, unknown> = { ...row, playlist_uuid: targetPlaylistUuid }
      if (columns.includes('info_json')) {
        nextRow.info_json = rebaseOptionalJson({
          raw: row.info_json,
          sourceRoot: params.sourceRoot,
          sourceFilePathToTarget: params.sourceFilePathToTarget,
          sourceNodePaths: params.sourceNodePaths,
          description: 'mixtape_projects.info_json'
        })
      }
      insert.run(...columns.map((column) => nextRow[column] ?? null))
      copied += 1
    }
    return copied
  }

  return copyItems('set_items') + copyItems('mixtape_items') + copyProjects()
}

const parseInfoJsonForTarget = (raw: unknown, targetPath: string): string => {
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(String(raw || '')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not object')
    }
    parsed = value as Record<string, unknown>
  } catch {
    throw new LibraryMergeError('SOURCE_ANALYSIS_INVALID', '来源曲目分析数据无法解析')
  }
  parsed.filePath = targetPath
  delete parsed.beatThisEstimatedDrift128Ms
  delete parsed.beatThisWindowCount
  return JSON.stringify(parsed)
}

const getSourceCacheRootTarget = (
  sourceRoot: string,
  listRootValue: unknown,
  sourceListRootToTarget: Map<string, { targetRel: string; targetAbs: string }>
): { sourceListRoot: string; targetListRoot: string; targetListAbs: string } | null => {
  const sourceListRoot = normalizeLibraryMergeCacheRoot(sourceRoot, String(listRootValue || ''))
  const target = sourceListRootToTarget.get(sourceListRoot)
  if (!target) return null
  return {
    sourceListRoot,
    targetListRoot: target.targetRel,
    targetListAbs: target.targetAbs
  }
}

const copyCacheRows = (
  sourceDb: SqliteDatabase,
  targetDb: SqliteDatabase,
  sourceRoot: string,
  sourceListRootToTarget: Map<string, { targetRel: string; targetAbs: string }>,
  targetStats: Map<string, TargetFileStat>
): number => {
  let copied = 0
  for (const tableName of CACHE_TABLES) {
    if (!hasTable(sourceDb, tableName) || !hasTable(targetDb, tableName)) continue
    const columns = getTableColumns(sourceDb, tableName)
    if (!columns.includes('list_root') || !columns.includes('file_path')) continue
    const selectColumns = columns.map(quoteIdentifier).join(', ')
    const insertColumns = selectColumns
    const placeholders = columns.map(() => '?').join(', ')
    const rows = sourceDb
      .prepare(`SELECT ${selectColumns} FROM ${quoteIdentifier(tableName)}`)
      .all() as Array<Record<string, unknown>>
    const insert = targetDb.prepare(
      `INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${insertColumns}) VALUES (${placeholders})`
    )
    for (const sourceRow of rows) {
      const root = getSourceCacheRootTarget(sourceRoot, sourceRow.list_root, sourceListRootToTarget)
      if (!root) continue
      const sourceFilePath = normalizeLibraryMergeCacheFilePath(
        sourceRoot,
        root.sourceListRoot,
        String(sourceRow.file_path || '')
      )
      if (!sourceFilePath || path.dirname(sourceFilePath) !== '.') continue
      const targetKey = `${root.targetListRoot}\u0000${sourceFilePath}`
      const targetStat = targetStats.get(targetKey)
      if (!targetStat) continue
      const nextRow: Record<string, unknown> = { ...sourceRow }
      nextRow.list_root = root.targetListRoot
      nextRow.file_path = sourceFilePath
      if (columns.includes('size')) nextRow.size = targetStat.size
      if (columns.includes('mtime_ms')) nextRow.mtime_ms = targetStat.mtimeMs
      if (tableName === 'song_cache' && columns.includes('info_json')) {
        nextRow.info_json = parseInfoJsonForTarget(nextRow.info_json, targetStat.targetAbs)
      }
      insert.run(...columns.map((column) => nextRow[column] ?? null))
      copied += 1
    }
  }
  return copied
}

const mergeFingerprints = (sourceDb: SqliteDatabase, targetDb: SqliteDatabase): number => {
  if (!hasTable(sourceDb, 'fingerprints') || !hasTable(targetDb, 'fingerprints')) return 0
  const rows = sourceDb.prepare('SELECT mode, hash FROM fingerprints').all() as Array<
    Record<string, unknown>
  >
  const insert = targetDb.prepare('INSERT OR IGNORE INTO fingerprints (mode, hash) VALUES (?, ?)')
  let merged = 0
  for (const row of rows) {
    const mode = typeof row.mode === 'string' ? row.mode : ''
    const hash = typeof row.hash === 'string' ? row.hash : ''
    if (!mode || !hash) continue
    const result = insert.run(mode, hash)
    merged += Number(result.changes || 0)
  }
  return merged
}

const verifyTargetRows = (
  targetDb: SqliteDatabase,
  targetUuids: string[],
  commitKey: string
): void => {
  const nodeQuery = targetDb.prepare('SELECT uuid FROM library_nodes WHERE uuid = ? LIMIT 1')
  for (const uuid of targetUuids) {
    if (!nodeQuery.get(uuid)) {
      throw new LibraryMergeError('TARGET_VERIFY_FAILED', `目标库缺少已提交节点：${uuid}`)
    }
  }
  const marker = targetDb.prepare('SELECT value FROM meta WHERE key = ?').get(commitKey) as
    | Record<string, unknown>
    | undefined
  if (String(marker?.value || '') !== '1') {
    throw new LibraryMergeError('TARGET_VERIFY_FAILED', '目标库缺少合并提交标记')
  }
  const foreignRows = targetDb.pragma('foreign_key_check') as Array<Record<string, unknown>>
  if (foreignRows.length > 0) {
    throw new LibraryMergeError('TARGET_VERIFY_FAILED', '目标库外键校验失败')
  }
}

const removeDirectoryIfEmpty = async (dirPath: string): Promise<void> => {
  try {
    await fs.rmdir(dirPath)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error
  }
}

const createDirectoryWithJournal = async (params: {
  targetRoot: string
  directoryPath: string
  journal: Journal
  journalPath: string
}): Promise<void> => {
  const libraryRoot = path.join(params.targetRoot, 'library')
  if (!isPathInside(libraryRoot, params.directoryPath)) {
    throw new LibraryMergeError(
      'TARGET_VERIFY_FAILED',
      `目标目录超出库范围：${params.directoryPath}`
    )
  }
  const missingPaths: string[] = []
  let currentPath = path.resolve(params.directoryPath)
  while (currentPath !== path.resolve(libraryRoot)) {
    const stat = await fs.lstat(currentPath).catch(() => null)
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new LibraryMergeError('TARGET_VERIFY_FAILED', `目标路径不能创建目录：${currentPath}`)
      }
      break
    }
    missingPaths.push(currentPath)
    const parentPath = path.dirname(currentPath)
    if (parentPath === currentPath || !isPathInside(libraryRoot, parentPath)) {
      throw new LibraryMergeError(
        'TARGET_VERIFY_FAILED',
        `目标目录父级无效：${params.directoryPath}`
      )
    }
    currentPath = parentPath
  }
  for (const missingPath of missingPaths.reverse()) {
    params.journal.directoryIntents.push(missingPath)
    await writeJournal(params.journalPath, params.journal)
    await fs.mkdir(missingPath, { recursive: false })
    params.journal.createdDirectories.push(missingPath)
    await writeJournal(params.journalPath, params.journal)
  }
}

const rollbackUncommittedJournal = async (journal: Journal, journalDir: string): Promise<void> => {
  const roots = Array.from(new Set([...journal.promotedRoots, ...journal.promotionIntents])).sort(
    (left, right) => right.length - left.length
  )
  for (const root of roots) {
    if (!isPathInside(path.join(journal.targetRoot, 'library'), root)) continue
    await fs.rm(root, { recursive: true, force: true })
  }
  const dirs = Array.from(
    new Set([...journal.createdDirectories, ...journal.directoryIntents])
  ).sort((left, right) => right.length - left.length)
  for (const dirPath of dirs) {
    if (!isPathInside(path.join(journal.targetRoot, 'library'), dirPath)) continue
    await removeDirectoryIfEmpty(dirPath)
  }
  await fs.rm(journalDir, { recursive: true, force: true })
}

const getCommitKey = (jobId: string) => `library_merge.${jobId}.committed`

const hasCommitMarker = (db: SqliteDatabase, jobId: string): boolean => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(getCommitKey(jobId)) as
    | Record<string, unknown>
    | undefined
  return String(row?.value || '') === '1'
}

const acquireMergeLock = async (targetRoot: string, jobId: string): Promise<string> => {
  const lockPath = path.join(targetRoot, MERGE_LOCK_FILE_NAME)
  try {
    await fs.writeFile(lockPath, `${jobId}\n`, { encoding: 'utf8', flag: 'wx' })
    return lockPath
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'EEXIST') {
      throw new LibraryMergeError('MERGE_ALREADY_ACTIVE', '当前库已有合并或恢复任务')
    }
    throw error
  }
}

const emitProgress = (
  callback: LibraryMergeOptions['onProgress'],
  phase: LibraryMergePhase,
  copiedBytes: number,
  totalBytes: number,
  copiedFiles: number,
  totalFiles: number,
  currentPath?: string
): void => {
  callback?.({ phase, copiedBytes, totalBytes, copiedFiles, totalFiles, currentPath })
}

export const isLibraryMergeActive = (): boolean => activeMerge

export async function recoverIncompleteLibraryMerges(targetRootInput: string): Promise<void> {
  const targetRoot = path.resolve(targetRootInput)
  const workRoot = path.join(targetRoot, MERGE_WORK_DIR_NAME)
  const entries = await fs.readdir(workRoot, { withFileTypes: true }).catch(() => [])
  if (entries.length === 0) {
    await removeDirectoryIfEmpty(workRoot)
    await fs.rm(path.join(targetRoot, MERGE_LOCK_FILE_NAME), { force: true })
    return
  }
  const Database = getDatabaseCtor()
  const targetDb = new Database(path.join(targetRoot, DB_FILE_NAME), { fileMustExist: true })
  targetDb.pragma('foreign_keys = ON')
  try {
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const journalDir = path.join(workRoot, entry.name)
      const journal = await readJson<Journal>(path.join(journalDir, 'journal.json'))
      if (
        !journal ||
        journal.version !== 1 ||
        journal.targetRoot !== targetRoot ||
        (journal.mode !== 'copy' && journal.mode !== 'delete-source') ||
        !journal.fileHashes ||
        typeof journal.fileHashes !== 'object'
      ) {
        throw new LibraryMergeError('RECOVERY_JOURNAL_INVALID', '发现无法识别的库合并恢复日志')
      }
      if (hasCommitMarker(targetDb, journal.jobId)) {
        if (journal.mode === 'delete-source') {
          try {
            if (await fileExists(journal.sourceRoot)) {
              if (!(await isExpectedSourceRoot(journal.sourceRoot, journal.sourceManifestUuid))) {
                continue
              }
              await fs.rm(journal.sourceRoot, {
                recursive: true,
                force: false,
                maxRetries: 2,
                retryDelay: 250
              })
            }
          } catch {
            continue
          }
        }
        await fs.rm(journalDir, { recursive: true, force: true })
      } else {
        await rollbackUncommittedJournal(journal, journalDir)
      }
    }
  } finally {
    targetDb.close()
  }
  await removeDirectoryIfEmpty(workRoot)
  await fs.rm(path.join(targetRoot, MERGE_LOCK_FILE_NAME), { force: true })
}

export async function mergeFrkbLibraries(
  options: LibraryMergeOptions
): Promise<LibraryMergeResult> {
  if (activeMerge) {
    throw new LibraryMergeError('MERGE_ALREADY_ACTIVE', '当前已有合并任务正在运行')
  }
  activeMerge = true
  emitProgress(options.onProgress, 'preflight', 0, 0, 0, 0)
  const sourceRoot = path.resolve(options.sourceRoot)
  const targetRoot = path.resolve(options.targetRoot)
  const jobId = randomUUID()
  let lockPath = ''
  let journalDir = ''
  let journalPath = ''
  let journal: Journal | null = null
  let sourceDb: SqliteDatabase | null = null
  let targetDb: SqliteDatabase | null = null
  let targetTransactionOpen = false
  let committed = false
  try {
    await recoverIncompleteLibraryMerges(targetRoot)
    lockPath = await acquireMergeLock(targetRoot, jobId)
    const Database = getDatabaseCtor()
    sourceDb = new Database(path.join(sourceRoot, DB_FILE_NAME), {
      readonly: true,
      fileMustExist: true
    })
    sourceDb.exec('BEGIN')
    targetDb = new Database(path.join(targetRoot, DB_FILE_NAME), { fileMustExist: true })
    targetDb.pragma('foreign_keys = ON')
    targetDb.pragma('busy_timeout = 1000')
    targetDb.pragma('wal_checkpoint(TRUNCATE)')
    targetDb.pragma('synchronous = FULL')
    targetDb.exec('BEGIN IMMEDIATE')
    targetTransactionOpen = true
    const plan = await buildLibraryMergePlan({
      sourceRoot,
      targetRoot,
      sourceDb,
      targetDb,
      appVersion: options.appVersion
    })
    emitProgress(
      options.onProgress,
      'preflight',
      0,
      plan.summary.copiedBytes,
      0,
      plan.summary.copiedFileCount
    )

    journalDir = path.join(targetRoot, MERGE_WORK_DIR_NAME, jobId)
    const payloadDir = path.join(journalDir, 'payload')
    await fs.mkdir(payloadDir, { recursive: true })
    journalPath = path.join(journalDir, 'journal.json')
    journal = {
      version: 1,
      jobId,
      mode: options.mode,
      sourceRoot,
      targetRoot,
      sourceManifestUuid: plan.sourceManifestUuid,
      targetManifestUuid: plan.targetManifestUuid,
      phase: 'staging',
      promotionIntents: [],
      promotedRoots: [],
      directoryIntents: [],
      createdDirectories: [],
      fileHashes: {}
    }
    await writeJournal(journalPath, journal)

    for (const node of plan.nodes) {
      if (node.nodeType !== 'songList') continue
      await fs.mkdir(path.join(payloadDir, node.targetUuid), { recursive: true })
    }

    let copiedBytes = 0
    let copiedFiles = 0
    for (const file of plan.files) {
      await assertRemainingTargetCapacity({
        targetRoot,
        requiredBytes: plan.capacity.requiredBytes,
        alreadyReservedBytes: copiedBytes + plan.capacity.journalBytes
      })
      const sourceStat = await fs.lstat(file.sourceAbs)
      if (
        !sourceStat.isFile() ||
        sourceStat.isSymbolicLink() ||
        sourceStat.size !== file.size ||
        Math.abs(sourceStat.mtimeMs - file.mtimeMs) >= 1
      ) {
        throw new LibraryMergeError(
          'SOURCE_CHANGED',
          `来源文件在合并过程中发生变化：${file.sourceAbs}`
        )
      }
      const stageFile = path.join(payloadDir, file.stageRel)
      const stagePart = `${stageFile}.part`
      await fs.mkdir(path.dirname(stagePart), { recursive: true })
      await writeJournal(journalPath, journal)
      const sourceHash = await copyWithHash(file.sourceAbs, stagePart)
      const sourceStatAfterCopy = await fs.lstat(file.sourceAbs)
      if (
        !sourceStatAfterCopy.isFile() ||
        sourceStatAfterCopy.isSymbolicLink() ||
        sourceStatAfterCopy.size !== file.size ||
        Math.abs(sourceStatAfterCopy.mtimeMs - file.mtimeMs) >= 1
      ) {
        throw new LibraryMergeError(
          'SOURCE_CHANGED',
          `来源文件在复制过程中发生变化：${file.sourceAbs}`
        )
      }
      await fs.utimes(stagePart, sourceStat.atime, sourceStat.mtime)
      await fs.rename(stagePart, stageFile)
      await fsyncFile(stageFile)
      journal.fileHashes[file.targetAbs] = sourceHash
      await writeJournal(journalPath, journal)
      copiedBytes += file.size
      copiedFiles += 1
      emitProgress(
        options.onProgress,
        'staging',
        copiedBytes,
        plan.summary.copiedBytes,
        copiedFiles,
        plan.summary.copiedFileCount,
        file.sourceAbs
      )
    }

    journal.phase = 'promoting'
    await writeJournal(journalPath, journal)
    const plannedDirectories = plan.nodes
      .filter(
        (node) =>
          node.nodeType === 'dir' || node.nodeType === 'mixtapeList' || node.nodeType === 'setList'
      )
      .sort((left, right) => left.targetRel.length - right.targetRel.length)
    for (const node of plannedDirectories) {
      await createDirectoryWithJournal({
        targetRoot,
        directoryPath: node.targetAbs,
        journal,
        journalPath
      })
    }
    const targetStats = new Map<string, TargetFileStat>()
    const plannedSongLists = plan.nodes.filter((node) => node.nodeType === 'songList')
    for (const node of plannedSongLists) {
      const stageRoot = path.join(payloadDir, node.targetUuid)
      journal.promotionIntents.push(node.targetAbs)
      await writeJournal(journalPath, journal)
      await fs.rename(stageRoot, node.targetAbs)
      journal.promotedRoots.push(node.targetAbs)
      await writeJournal(journalPath, journal)
    }
    const plannedAssets = plan.files.filter((file) => file.kind === 'asset')
    for (const asset of plannedAssets) {
      await createDirectoryWithJournal({
        targetRoot,
        directoryPath: path.dirname(asset.targetAbs),
        journal,
        journalPath
      })
      const stagedAsset = path.join(payloadDir, asset.stageRel)
      journal.promotionIntents.push(asset.targetAbs)
      await writeJournal(journalPath, journal)
      await fs.rename(stagedAsset, asset.targetAbs)
      journal.promotedRoots.push(asset.targetAbs)
      await writeJournal(journalPath, journal)
    }
    for (const file of plan.files) {
      const stat = await fs.stat(file.targetAbs)
      if (!stat.isFile() || stat.size !== file.size) {
        throw new LibraryMergeError(
          'TARGET_VERIFY_FAILED',
          `暂存后的目标文件校验失败：${file.targetAbs}`
        )
      }
      const expectedHash = journal.fileHashes[file.targetAbs]
      if (!expectedHash || (await hashFile(file.targetAbs)) !== expectedHash) {
        throw new LibraryMergeError(
          'TARGET_VERIFY_FAILED',
          `目标文件校验和不匹配：${file.targetAbs}`
        )
      }
      if (file.kind === 'song-list') {
        targetStats.set(`${file.targetListRoot}\u0000${file.targetFilePath}`, {
          targetAbs: file.targetAbs,
          size: stat.size,
          mtimeMs: stat.mtimeMs
        })
      }
    }
    emitProgress(
      options.onProgress,
      'promoting',
      copiedBytes,
      plan.summary.copiedBytes,
      copiedFiles,
      plan.summary.copiedFileCount
    )

    journal.phase = 'committing'
    await writeJournal(journalPath, journal)
    try {
      const insertNode = targetDb.prepare(
        'INSERT INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
      )
      const sortedNodes = [...plan.nodes].sort(
        (left, right) => left.targetRel.length - right.targetRel.length
      )
      for (const node of sortedNodes) {
        insertNode.run(
          node.targetUuid,
          node.parentTargetUuid,
          path.basename(node.targetRel),
          node.nodeType,
          node.order
        )
      }
      const mergedFingerprintCount = mergeFingerprints(sourceDb, targetDb)
      const copiedCacheRows = copyCacheRows(
        sourceDb,
        targetDb,
        sourceRoot,
        plan.sourceListRootToTarget,
        targetStats
      )
      copySpecialRows({
        sourceDb,
        targetDb,
        sourceRoot,
        sourceFilePathToTarget: plan.sourceFilePathToTarget,
        sourceNodePaths: plan.nodePathMappings,
        nodeUuidMap: plan.nodeUuidMap
      })
      const commitKey = getCommitKey(jobId)
      targetDb
        .prepare(
          'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        )
        .run(commitKey, '1')
      const foreignRows = targetDb.pragma('foreign_key_check') as Array<Record<string, unknown>>
      if (foreignRows.length > 0) {
        throw new LibraryMergeError('TARGET_VERIFY_FAILED', '写入后的目标库外键检查失败')
      }
      targetDb.exec('COMMIT')
      targetTransactionOpen = false
      committed = true
      journal.phase = 'completed'
      await writeJournal(journalPath, journal)
      verifyTargetRows(
        targetDb,
        plan.nodes.map((node) => node.targetUuid),
        commitKey
      )
      emitProgress(
        options.onProgress,
        'committing',
        copiedBytes,
        plan.summary.copiedBytes,
        copiedFiles,
        plan.summary.copiedFileCount
      )
      let sourceDeleted = false
      let sourceDeleteError: string | undefined
      if (options.mode === 'delete-source') {
        emitProgress(
          options.onProgress,
          'deleting-source',
          copiedBytes,
          plan.summary.copiedBytes,
          copiedFiles,
          plan.summary.copiedFileCount
        )
        try {
          await assertSourceRootIdentity(sourceRoot, plan.sourceManifestUuid)
          await fs.rm(sourceRoot, { recursive: true, force: false, maxRetries: 2, retryDelay: 250 })
          sourceDeleted = true
        } catch (error) {
          sourceDeleteError = toErrorMessage(error)
          journal.phase = 'deleting-source'
          await writeJournal(journalPath, journal)
        }
      }
      if (!sourceDeleteError) {
        await fs.rm(journalDir, { recursive: true, force: true })
        await removeDirectoryIfEmpty(path.join(targetRoot, MERGE_WORK_DIR_NAME))
      }
      emitProgress(
        options.onProgress,
        'completed',
        copiedBytes,
        plan.summary.copiedBytes,
        copiedFiles,
        plan.summary.copiedFileCount
      )
      return {
        ...plan.summary,
        mode: options.mode,
        sourceDeleted,
        ...(sourceDeleteError ? { sourceDeleteError } : {}),
        copiedCacheRows,
        mergedFingerprintCount
      }
    } catch (error) {
      if (targetTransactionOpen) {
        try {
          targetDb.exec('ROLLBACK')
        } catch {}
        targetTransactionOpen = false
      }
      throw error
    }
  } catch (error) {
    if (targetTransactionOpen) {
      try {
        targetDb?.exec('ROLLBACK')
      } catch {}
      targetTransactionOpen = false
    }
    if (!committed && journal && journalDir) {
      try {
        await rollbackUncommittedJournal(journal, journalDir)
        await removeDirectoryIfEmpty(path.join(targetRoot, MERGE_WORK_DIR_NAME))
      } catch {}
    }
    emitProgress(options.onProgress, 'failed', 0, 0, 0, 0, toErrorMessage(error))
    throw error
  } finally {
    try {
      sourceDb?.close()
    } catch {}
    try {
      targetDb?.close()
    } catch {}
    if (lockPath) {
      await fs.rm(lockPath, { force: true }).catch(() => {})
    }
    activeMerge = false
  }
}

export async function inspectLibraryMergeSource(params: {
  sourceRoot: string
  targetRoot: string
  appVersion?: string
}): Promise<LibraryMergePlanSummary> {
  const Database = getDatabaseCtor()
  const sourceRoot = path.resolve(params.sourceRoot)
  const targetRoot = path.resolve(params.targetRoot)
  const sourceDb = new Database(path.join(sourceRoot, DB_FILE_NAME), {
    readonly: true,
    fileMustExist: true
  })
  const targetDb = new Database(path.join(targetRoot, DB_FILE_NAME), { fileMustExist: true })
  targetDb.pragma('foreign_keys = ON')
  try {
    const plan = await buildLibraryMergePlan({
      sourceRoot,
      targetRoot,
      sourceDb,
      targetDb,
      appVersion: params.appVersion
    })
    return plan.summary
  } finally {
    sourceDb.close()
    targetDb.close()
  }
}
