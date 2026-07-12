import fs from 'node:fs/promises'
import path from 'node:path'
import { v4 as uuidV4 } from 'uuid'
import { MANIFEST_FILE_NAME, isManifestCompatible, readManifestFile } from '../../databaseManifest'
import { isRegisteredLibraryMetadataKey } from '../../../shared/libraryMetadataContracts'
import {
  assertExpectedDirectoryEntries,
  assertLeafDirectoryHasNoUserContent,
  getMergeFilePathKey,
  LIBRARY_MERGE_IGNORED_CACHE_DIRECTORY_NAMES,
  planAssets
} from './planFiles'
import { LIBRARY_MERGE_KNOWN_TABLES } from './participants'
import { LibraryMergeError, type LibraryMergeCapacity, type LibraryMergePlanSummary } from './types'

type SqliteDatabase = InstanceType<typeof import('better-sqlite3')>

type LibraryNodeType = 'root' | 'library' | 'dir' | 'songList' | 'mixtapeList' | 'setList'

export type LibraryNode = {
  uuid: string
  parentUuid: string | null
  dirName: string
  nodeType: LibraryNodeType
  order: number | null
}

export type PlannedNode = {
  sourceUuid: string
  targetUuid: string
  parentTargetUuid: string | null
  sourceRel: string
  targetRel: string
  sourceAbs: string
  targetAbs: string
  nodeType: 'dir' | 'songList' | 'mixtapeList' | 'setList'
  order: number | null
  isNew: boolean
}

export type PlannedFile = {
  kind: 'song-list' | 'asset'
  sourceAbs: string
  stageRel: string
  targetAbs: string
  targetListRoot: string
  targetFilePath: string
  size: number
  mtimeMs: number
}

export type LibraryMergePlan = {
  sourceRoot: string
  targetRoot: string
  sourceLabel: string
  sourceManifestUuid: string
  targetManifestUuid: string
  nodes: PlannedNode[]
  files: PlannedFile[]
  sourceListRootToTarget: Map<string, PlannedNode>
  nodeUuidMap: Map<string, string>
  nodePathMappings: Array<{ sourceAbs: string; targetAbs: string }>
  sourceFilePathToTarget: Map<string, string>
  capacity: LibraryMergeCapacity
  summary: LibraryMergePlanSummary
}

const CORE_LIBRARY_ALIASES: Record<string, string[]> = {
  FilterLibrary: ['FilterLibrary', '筛选库'],
  CuratedLibrary: ['CuratedLibrary', '精选库'],
  SetLibrary: ['SetLibrary', 'SET库'],
  MixtapeLibrary: ['MixtapeLibrary', '混音库'],
  RecordingLibrary: ['RecordingLibrary', '录音库'],
  RecycleBin: ['RecycleBin', '回收站']
}

const IMPORTED_CORE_LIBRARY_NAMES = [
  'FilterLibrary',
  'CuratedLibrary',
  'SetLibrary',
  'MixtapeLibrary',
  'RecordingLibrary'
] as const

const CONTROL_FILE_NAMES = new Set(['.frkb.uuid', '.description.json', '.description.json.legacy'])
const SET_CUSTODY_DIR_NAME = '__set_custody__'
const MIXTAPE_VAULT_DIR_NAME = '.mixtape_vault'

const normalizeNameKey = (value: string): string => {
  const normalized = String(value || '').normalize('NFC')
  // Reject case-only sibling differences on every platform. This is conservative on a
  // case-sensitive macOS volume, but guarantees the plan can also be promoted safely to the
  // common case-insensitive target volumes without discovering a collision mid-merge.
  return normalized.toLocaleLowerCase()
}

const normalizeRelativePath = (value: string): string => {
  const normalized = path.normalize(String(value || '')).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized
}

const isPathInside = (parentPath: string, targetPath: string): boolean => {
  const parent = path.resolve(parentPath)
  const target = path.resolve(targetPath)
  const relative = path.relative(parent, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

export const assertDistinctLibraryMergeRoots = async (
  sourceRootInput: string,
  targetRootInput: string
): Promise<void> => {
  const sourceRoot = path.resolve(sourceRootInput)
  const targetRoot = path.resolve(targetRootInput)
  if (sourceRoot === targetRoot) {
    throw new LibraryMergeError('SOURCE_EQUALS_TARGET', '来源库不能是当前库')
  }
  if (isPathInside(sourceRoot, targetRoot) || isPathInside(targetRoot, sourceRoot)) {
    throw new LibraryMergeError('NESTED_LIBRARY_ROOT', '来源库与当前库不能互相嵌套')
  }
  const [sourceManifest, targetManifest] = await Promise.all([
    readManifestFile(path.join(sourceRoot, MANIFEST_FILE_NAME)),
    readManifestFile(path.join(targetRoot, MANIFEST_FILE_NAME))
  ])
  if (sourceManifest.uuid === targetManifest.uuid) {
    throw new LibraryMergeError('SOURCE_EQUALS_TARGET', '来源库与当前库具有相同的库标识')
  }
}

const getRowText = (row: Record<string, unknown>, key: string): string =>
  typeof row[key] === 'string' ? row[key].trim() : String(row[key] || '').trim()

const getNullableText = (row: Record<string, unknown>, key: string): string | null => {
  const value = row[key]
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

const getOrder = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const isSafeNodeDirectoryName = (value: string): boolean => {
  if (!value || value === '.' || value === '..') return false
  if (value.includes('\u0000') || /[\\/]/.test(value)) return false
  return path.basename(value) === value && !path.isAbsolute(value)
}

const toLibraryNode = (row: Record<string, unknown>): LibraryNode => {
  const nodeType = getRowText(row, 'node_type') as LibraryNodeType
  const allowed: LibraryNodeType[] = [
    'root',
    'library',
    'dir',
    'songList',
    'mixtapeList',
    'setList'
  ]
  if (!allowed.includes(nodeType)) {
    throw new LibraryMergeError('SOURCE_TREE_INVALID', `来源库包含未知节点类型：${nodeType}`)
  }
  const uuid = getRowText(row, 'uuid')
  const dirName = typeof row.dir_name === 'string' ? row.dir_name : String(row.dir_name || '')
  if (!uuid || !isSafeNodeDirectoryName(dirName)) {
    throw new LibraryMergeError('SOURCE_TREE_INVALID', '来源库包含缺少 UUID 或目录名的节点')
  }
  return {
    uuid,
    parentUuid: getNullableText(row, 'parent_uuid'),
    dirName,
    nodeType,
    order: getOrder(row.sort_order)
  }
}

const listTableNames = (db: SqliteDatabase): string[] => {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
    .all() as Array<Record<string, unknown>>
  return rows
    .map((row) => getRowText(row, 'name'))
    .filter((name) => !!name && !name.startsWith('sqlite_'))
}

const requireKnownTables = (db: SqliteDatabase): void => {
  for (const tableName of listTableNames(db)) {
    if (!LIBRARY_MERGE_KNOWN_TABLES.has(tableName)) {
      throw new LibraryMergeError(
        'SOURCE_SCHEMA_UNSUPPORTED',
        `来源库包含当前合并器未支持的数据表：${tableName}`
      )
    }
  }
}

const requireRegisteredMetadata = (db: SqliteDatabase): void => {
  if (!listTableNames(db).includes('meta')) return
  const rows = db.prepare('SELECT key FROM meta ORDER BY key ASC').all() as Array<
    Record<string, unknown>
  >
  const unknownKey = rows
    .map((row) => getRowText(row, 'key'))
    .find((key) => key && !isRegisteredLibraryMetadataKey(key))
  if (!unknownKey) return
  throw new LibraryMergeError(
    'SOURCE_METADATA_UNSUPPORTED',
    `来源库包含当前合并器未声明的业务数据：${unknownKey}`
  )
}

const getIntegrityError = (db: SqliteDatabase): string | null => {
  const integrity = db.pragma('integrity_check', { simple: true })
  if (String(integrity).toLowerCase() !== 'ok') return `integrity_check: ${String(integrity)}`
  const foreignRows = db.pragma('foreign_key_check') as Array<Record<string, unknown>>
  if (Array.isArray(foreignRows) && foreignRows.length > 0) return 'foreign_key_check failed'
  return null
}

const getUserVersion = (db: SqliteDatabase): number =>
  Number(db.pragma('user_version', { simple: true }))

const sortNodes = (nodes: LibraryNode[]): LibraryNode[] =>
  [...nodes].sort((left, right) => {
    const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER
    const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    return left.dirName.localeCompare(right.dirName)
  })

const getCoreKeyForName = (name: string): string | null => {
  const normalized = normalizeNameKey(name)
  for (const [key, aliases] of Object.entries(CORE_LIBRARY_ALIASES)) {
    if (aliases.some((alias) => normalizeNameKey(alias) === normalized)) return key
  }
  return null
}

const listNodes = (db: SqliteDatabase): LibraryNode[] => {
  const rows = db
    .prepare('SELECT uuid, parent_uuid, dir_name, node_type, sort_order FROM library_nodes')
    .all() as Array<Record<string, unknown>>
  if (rows.length === 0) {
    throw new LibraryMergeError('SOURCE_TREE_INVALID', '来源库没有库树节点')
  }
  return rows.map(toLibraryNode)
}

const buildChildren = (nodes: LibraryNode[]): Map<string, LibraryNode[]> => {
  const result = new Map<string, LibraryNode[]>()
  for (const node of nodes) {
    if (!node.parentUuid) continue
    const list = result.get(node.parentUuid)
    if (list) list.push(node)
    else result.set(node.parentUuid, [node])
  }
  for (const [parentUuid, children] of result.entries()) {
    const names = new Set<string>()
    for (const child of children) {
      const key = normalizeNameKey(child.dirName)
      if (names.has(key)) {
        throw new LibraryMergeError('SOURCE_TREE_INVALID', `来源库同级目录重名：${child.dirName}`)
      }
      names.add(key)
    }
    result.set(parentUuid, sortNodes(children))
  }
  return result
}

const getRootNode = (nodes: LibraryNode[]): LibraryNode => {
  const roots = nodes.filter((node) => node.parentUuid === null && node.nodeType === 'root')
  if (roots.length !== 1) {
    throw new LibraryMergeError('SOURCE_TREE_INVALID', '来源库必须且只能有一个根节点')
  }
  const root = roots[0]
  if (normalizeNameKey(root.dirName) !== normalizeNameKey('library')) {
    throw new LibraryMergeError('SOURCE_TREE_INVALID', '来源库根节点不是 library')
  }
  return root
}

const assertDirectory = async (dirPath: string, code: string): Promise<void> => {
  const stat = await fs.lstat(dirPath).catch(() => null)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new LibraryMergeError(code, `缺少或无法访问目录：${dirPath}`)
  }
}

const getCoreNodes = (
  root: LibraryNode,
  children: Map<string, LibraryNode[]>,
  side: '来源' | '目标'
): Map<string, LibraryNode> => {
  const result = new Map<string, LibraryNode>()
  for (const child of children.get(root.uuid) || []) {
    if (child.nodeType !== 'library') continue
    const key = getCoreKeyForName(child.dirName)
    if (!key) continue
    if (result.has(key)) {
      throw new LibraryMergeError(
        'SOURCE_TREE_INVALID',
        `${side}库包含重复核心库：${child.dirName}`
      )
    }
    result.set(key, child)
  }
  for (const key of Object.keys(CORE_LIBRARY_ALIASES)) {
    if (!result.has(key)) {
      throw new LibraryMergeError('SOURCE_TREE_INVALID', `${side}库缺少核心库：${key}`)
    }
  }
  return result
}

const buildAbsolutePaths = (
  rootDir: string,
  rootNode: LibraryNode,
  children: Map<string, LibraryNode[]>
): Map<string, { abs: string; rel: string }> => {
  const result = new Map<string, { abs: string; rel: string }>()
  const queue: LibraryNode[] = [rootNode]
  result.set(rootNode.uuid, { abs: path.join(rootDir, rootNode.dirName), rel: rootNode.dirName })
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]
    const parentPath = result.get(parent.uuid)
    if (!parentPath) continue
    for (const child of children.get(parent.uuid) || []) {
      const rel = path.join(parentPath.rel, child.dirName)
      result.set(child.uuid, { abs: path.join(rootDir, rel), rel })
      queue.push(child)
    }
  }
  if (result.size !== queue.length) {
    throw new LibraryMergeError('SOURCE_TREE_INVALID', '来源库树包含孤立节点或循环引用')
  }
  return result
}

const suffixName = (name: string, sourceLabel: string, occupied: Set<string>): string => {
  const base = `${name} (from ${sourceLabel})`
  let candidate = base
  let index = 2
  while (occupied.has(normalizeNameKey(candidate))) {
    candidate = `${base} ${index}`
    index += 1
  }
  return candidate
}

const sanitizeSourceLabel = (sourceRoot: string): string => {
  const base = path.basename(sourceRoot).trim()
  const normalized = base.replace(/[\\/:*?"<>|]/g, '_').trim()
  return (normalized || 'source').slice(0, 64)
}

const getAvailableBytes = async (targetRoot: string): Promise<number | null> => {
  try {
    const stats = await fs.statfs(targetRoot)
    const available = Number(stats.bavail) * Number(stats.bsize)
    return Number.isFinite(available) && available >= 0 ? available : null
  } catch {
    return null
  }
}

const getDatabasePeakBytes = (sourceDb: SqliteDatabase): number => {
  const pageSize = Number(sourceDb.pragma('page_size', { simple: true }))
  const pageCount = Number(sourceDb.pragma('page_count', { simple: true }))
  const sourceLogicalBytes = Math.max(
    0,
    Number.isFinite(pageSize) && Number.isFinite(pageCount) ? pageSize * pageCount : 0
  )
  // The source DB is an upper bound for the transformed rows and indexes. During a WAL
  // commit, the target can temporarily hold both the new pages and the WAL frames.
  return Math.max(64 * 1024 * 1024, Math.ceil(sourceLogicalBytes * 2 + 16 * 1024 * 1024))
}

const getJournalPeakBytes = (nodes: PlannedNode[], files: PlannedFile[]): number => {
  const nodePathBytes = nodes.reduce(
    (total, node) => total + Buffer.byteLength(node.targetAbs, 'utf8'),
    0
  )
  const filePathBytes = files.reduce(
    (total, file) => total + Buffer.byteLength(file.targetAbs, 'utf8'),
    0
  )
  // Each target path can be present in intent, completion and hash maps. Journal updates are
  // copy-on-write, so journal.json and journal.json.next coexist during the durable rename.
  const encodedJournalPayloadBytes = 128 * 1024 + nodePathBytes * 3 + filePathBytes * 5
  return Math.max(1024 * 1024, Math.ceil(encodedJournalPayloadBytes * 2.25))
}

const getCapacity = async (
  targetRoot: string,
  sourceDb: SqliteDatabase,
  payloadBytes: number,
  journalBytes: number,
  sourceSchemaSnapshotBytes: number,
  availableBytesBeforeSnapshot?: number
): Promise<LibraryMergeCapacity> => {
  const databasePeakBytes = getDatabasePeakBytes(sourceDb)
  const remainingBeforeSafety = payloadBytes + databasePeakBytes + journalBytes
  const beforeSafety = remainingBeforeSafety + sourceSchemaSnapshotBytes
  const safetyBytes = Math.max(2 * 1024 * 1024 * 1024, Math.ceil(beforeSafety * 0.15))
  const requiredBytes = beforeSafety + safetyBytes
  const remainingRequiredBytes = remainingBeforeSafety + safetyBytes
  const availableBytes =
    availableBytesBeforeSnapshot === undefined
      ? await getAvailableBytes(targetRoot)
      : availableBytesBeforeSnapshot
  if (availableBytes === null) {
    throw new LibraryMergeError('CAPACITY_UNAVAILABLE', '无法读取目标磁盘可用空间')
  }
  if (availableBytes < requiredBytes) {
    throw new LibraryMergeError(
      'INSUFFICIENT_SPACE',
      `目标磁盘可用空间不足，还需要 ${requiredBytes - availableBytes} 字节`
    )
  }
  return {
    payloadBytes,
    databasePeakBytes,
    sourceSchemaSnapshotBytes,
    journalBytes,
    safetyBytes,
    requiredBytes,
    remainingRequiredBytes,
    availableBytes
  }
}

const assertSourceSongList = async (node: PlannedNode): Promise<PlannedFile[]> => {
  await assertDirectory(node.sourceAbs, 'SOURCE_TREE_INVALID')
  const entries = await fs.readdir(node.sourceAbs, { withFileTypes: true })
  const files: PlannedFile[] = []
  const fileNameKeys = new Set<string>()
  for (const entry of entries) {
    if (CONTROL_FILE_NAMES.has(entry.name)) continue
    const fileNameKey = normalizeNameKey(entry.name)
    if (fileNameKeys.has(fileNameKey)) {
      throw new LibraryMergeError(
        'SOURCE_TREE_INVALID',
        `来源歌单包含大小写冲突文件：${entry.name}`
      )
    }
    fileNameKeys.add(fileNameKey)
    const sourceAbs = path.join(node.sourceAbs, entry.name)
    const stat = await fs.lstat(sourceAbs)
    if (
      stat.isDirectory() &&
      LIBRARY_MERGE_IGNORED_CACHE_DIRECTORY_NAMES.some(
        (cacheName) => normalizeNameKey(cacheName) === fileNameKey
      )
    ) {
      continue
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new LibraryMergeError(
        'SOURCE_TREE_INVALID',
        `普通歌单只能包含常规文件，发现不支持的项目：${sourceAbs}`
      )
    }
    files.push({
      kind: 'song-list',
      sourceAbs,
      stageRel: path.join(node.targetUuid, entry.name),
      targetAbs: path.join(node.targetAbs, entry.name),
      targetListRoot: node.targetRel,
      targetFilePath: entry.name,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })
  }
  return files
}

const validatePlannedSongCacheRows = (
  sourceDb: SqliteDatabase,
  sourceRoot: string,
  sourceListRootToTarget: Map<string, PlannedNode>,
  files: PlannedFile[]
): void => {
  if (!listTableNames(sourceDb).includes('song_cache')) return
  const sourceFileKeys = new Set<string>()
  for (const file of files) {
    const sourceListRoot = normalizeRelativePath(
      path.dirname(path.relative(sourceRoot, file.sourceAbs))
    )
    sourceFileKeys.add(`${sourceListRoot}\u0000${path.basename(file.sourceAbs)}`)
  }
  const rows = sourceDb
    .prepare('SELECT list_root, file_path, info_json FROM song_cache')
    .all() as Array<Record<string, unknown>>
  for (const row of rows) {
    const sourceListRoot = normalizeLibraryMergeCacheRoot(sourceRoot, String(row.list_root || ''))
    if (!sourceListRootToTarget.has(sourceListRoot)) continue
    const sourceFilePath = normalizeLibraryMergeCacheFilePath(
      sourceRoot,
      sourceListRoot,
      String(row.file_path || '')
    )
    if (!sourceFilePath || !sourceFileKeys.has(`${sourceListRoot}\u0000${sourceFilePath}`)) continue
    try {
      const parsed = JSON.parse(String(row.info_json || '')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('invalid info')
    } catch {
      throw new LibraryMergeError('SOURCE_ANALYSIS_INVALID', '来源曲目分析数据无法在合并前验证')
    }
  }
}

const validateOptionalJsonObject = (value: unknown, description: string): void => {
  if (value === null || value === undefined || value === '') return
  try {
    const parsed = JSON.parse(String(value)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('invalid json')
  } catch {
    throw new LibraryMergeError('SOURCE_DATA_INVALID', `来源库的 ${description} 不是合法对象 JSON`)
  }
}

const assertMergeableReferencePath = async (params: {
  value: unknown
  description: string
  sourceRoot: string
  sourceFilePathToTarget: Map<string, string>
}): Promise<void> => {
  const filePath = String(params.value || '').trim()
  if (!filePath) {
    throw new LibraryMergeError(
      'SOURCE_DATA_INVALID',
      `来源库的 ${params.description} 缺少文件路径`
    )
  }
  const sourceAbs = path.resolve(filePath)
  const stat = await fs.lstat(sourceAbs).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new LibraryMergeError(
      'SOURCE_DATA_INVALID',
      `来源库的 ${params.description} 指向无法读取的文件：${filePath}`
    )
  }
  if (
    isPathInside(params.sourceRoot, sourceAbs) &&
    !params.sourceFilePathToTarget.has(getMergeFilePathKey(sourceAbs))
  ) {
    throw new LibraryMergeError(
      'SOURCE_DATA_INVALID',
      `来源库的 ${params.description} 指向未纳入迁移计划的文件：${filePath}`
    )
  }
}

const validateSpecialDataRows = async (params: {
  sourceDb: SqliteDatabase
  sourceRoot: string
  sourceToPlan: Map<string, PlannedNode>
  sourceFilePathToTarget: Map<string, string>
}): Promise<void> => {
  const tableNames = new Set(listTableNames(params.sourceDb))
  const validateItems = async (
    tableName: 'set_items' | 'mixtape_items',
    expectedNodeType: 'setList' | 'mixtapeList',
    jsonColumn: 'analysis_json' | 'info_json'
  ): Promise<void> => {
    if (!tableNames.has(tableName)) return
    const rows = params.sourceDb
      .prepare(
        `SELECT playlist_uuid, file_path, origin_playlist_uuid, origin_path_snapshot, ${jsonColumn} FROM ${tableName}`
      )
      .all() as Array<Record<string, unknown>>
    for (const row of rows) {
      const playlistUuid = getRowText(row, 'playlist_uuid')
      const plannedNode = params.sourceToPlan.get(playlistUuid)
      if (!plannedNode || plannedNode.nodeType !== expectedNodeType) {
        throw new LibraryMergeError(
          'SOURCE_DATA_INVALID',
          `来源库的 ${tableName} 引用了无法迁移的歌单：${playlistUuid || '(empty)'}`
        )
      }
      await assertMergeableReferencePath({
        value: row.file_path,
        description: `${tableName}.file_path`,
        sourceRoot: params.sourceRoot,
        sourceFilePathToTarget: params.sourceFilePathToTarget
      })
      const originUuid = getNullableText(row, 'origin_playlist_uuid')
      if (originUuid && !params.sourceToPlan.has(originUuid)) {
        throw new LibraryMergeError(
          'SOURCE_DATA_INVALID',
          `来源库的 ${tableName} 引用了无法迁移的来源歌单：${originUuid}`
        )
      }
      const originPathSnapshot = getNullableText(row, 'origin_path_snapshot')
      if (originPathSnapshot && path.isAbsolute(originPathSnapshot)) {
        const sourcePath = path.resolve(originPathSnapshot)
        if (isPathInside(params.sourceRoot, sourcePath)) {
          const mapped = Array.from(params.sourceToPlan.values()).some((node) =>
            isPathInside(node.sourceAbs, sourcePath)
          )
          if (!mapped) {
            throw new LibraryMergeError(
              'SOURCE_DATA_INVALID',
              `来源库的 ${tableName} 包含无法重写的来源路径：${originPathSnapshot}`
            )
          }
        }
      }
      validateOptionalJsonObject(row[jsonColumn], `${tableName}.${jsonColumn}`)
    }
  }

  await validateItems('set_items', 'setList', 'analysis_json')
  await validateItems('mixtape_items', 'mixtapeList', 'info_json')
  if (!tableNames.has('mixtape_projects')) return
  const projects = params.sourceDb
    .prepare('SELECT playlist_uuid, info_json FROM mixtape_projects')
    .all() as Array<Record<string, unknown>>
  for (const project of projects) {
    const playlistUuid = getRowText(project, 'playlist_uuid')
    const plannedNode = params.sourceToPlan.get(playlistUuid)
    if (!plannedNode || plannedNode.nodeType !== 'mixtapeList') {
      throw new LibraryMergeError(
        'SOURCE_DATA_INVALID',
        `来源库的 mixtape_projects 引用了无法迁移的歌单：${playlistUuid || '(empty)'}`
      )
    }
    validateOptionalJsonObject(project.info_json, 'mixtape_projects.info_json')
  }
}

export async function buildLibraryMergePlan(params: {
  sourceRoot: string
  targetRoot: string
  sourceDb: SqliteDatabase
  targetDb: SqliteDatabase
  appVersion?: string
  sourceSchemaSnapshotBytes?: number
  availableBytesBeforeSourceSnapshot?: number
}): Promise<LibraryMergePlan> {
  const sourceRoot = path.resolve(params.sourceRoot)
  const targetRoot = path.resolve(params.targetRoot)
  await assertDistinctLibraryMergeRoots(sourceRoot, targetRoot)

  const [sourceManifest, targetManifest] = await Promise.all([
    readManifestFile(path.join(sourceRoot, MANIFEST_FILE_NAME)),
    readManifestFile(path.join(targetRoot, MANIFEST_FILE_NAME))
  ])
  if (params.appVersion && !isManifestCompatible(sourceManifest, params.appVersion)) {
    throw new LibraryMergeError(
      'SOURCE_VERSION_INCOMPATIBLE',
      '来源库版本不受当前 FRKB 支持，请先升级 FRKB 后再合并'
    )
  }
  if (params.appVersion && !isManifestCompatible(targetManifest, params.appVersion)) {
    throw new LibraryMergeError(
      'TARGET_VERSION_INCOMPATIBLE',
      '当前库版本不受当前 FRKB 支持，请先升级 FRKB 后再合并'
    )
  }
  const sourceIntegrityError = getIntegrityError(params.sourceDb)
  if (sourceIntegrityError) {
    throw new LibraryMergeError(
      'SOURCE_DATABASE_CORRUPT',
      `来源数据库完整性检查失败：${sourceIntegrityError}`
    )
  }
  const targetIntegrityError = getIntegrityError(params.targetDb)
  if (targetIntegrityError) {
    throw new LibraryMergeError(
      'TARGET_DATABASE_CORRUPT',
      `当前数据库完整性检查失败：${targetIntegrityError}`
    )
  }
  const sourceSchemaVersion = getUserVersion(params.sourceDb)
  const targetSchemaVersion = getUserVersion(params.targetDb)
  if (sourceSchemaVersion !== targetSchemaVersion) {
    throw new LibraryMergeError(
      'SOURCE_SCHEMA_UNSUPPORTED',
      `来源库与当前库的数据库版本不一致（来源 ${sourceSchemaVersion}，当前 ${targetSchemaVersion}）。请先用当前 FRKB 打开来源库完成升级后再合并`
    )
  }
  requireKnownTables(params.sourceDb)
  requireRegisteredMetadata(params.sourceDb)

  const sourceNodes = listNodes(params.sourceDb)
  const targetNodes = listNodes(params.targetDb)
  const sourceChildren = buildChildren(sourceNodes)
  const targetChildren = buildChildren(targetNodes)
  const sourceRootNode = getRootNode(sourceNodes)
  const targetRootNode = getRootNode(targetNodes)
  const sourcePaths = buildAbsolutePaths(sourceRoot, sourceRootNode, sourceChildren)
  const targetPaths = buildAbsolutePaths(targetRoot, targetRootNode, targetChildren)
  if (sourcePaths.size !== sourceNodes.length || targetPaths.size !== targetNodes.length) {
    throw new LibraryMergeError('SOURCE_TREE_INVALID', '库树包含孤立节点或循环引用')
  }
  await assertDirectory(sourcePaths.get(sourceRootNode.uuid)?.abs || '', 'SOURCE_TREE_INVALID')
  await assertDirectory(targetPaths.get(targetRootNode.uuid)?.abs || '', 'TARGET_TREE_INVALID')
  for (const node of sourceNodes) {
    const nodePath = sourcePaths.get(node.uuid)
    if (!nodePath) continue
    await assertDirectory(nodePath.abs, 'SOURCE_TREE_INVALID')
  }
  for (const node of targetNodes) {
    const nodePath = targetPaths.get(node.uuid)
    if (!nodePath) continue
    await assertDirectory(nodePath.abs, 'TARGET_TREE_INVALID')
  }

  const sourceCores = getCoreNodes(sourceRootNode, sourceChildren, '来源')
  const targetCores = getCoreNodes(targetRootNode, targetChildren, '目标')

  const recordingSourceCore = sourceCores.get('RecordingLibrary')
  if (recordingSourceCore && (sourceChildren.get(recordingSourceCore.uuid) || []).length > 0) {
    throw new LibraryMergeError('SOURCE_TREE_INVALID', '来源录音库不应包含库树子节点')
  }
  for (const sourceNode of sourceNodes) {
    const children = sourceChildren.get(sourceNode.uuid) || []
    if (
      (sourceNode.nodeType === 'songList' ||
        sourceNode.nodeType === 'mixtapeList' ||
        sourceNode.nodeType === 'setList') &&
      children.length > 0
    ) {
      throw new LibraryMergeError(
        'SOURCE_TREE_INVALID',
        `来源叶节点包含子节点：${sourceNode.dirName}`
      )
    }
    if (
      sourceNode.nodeType !== 'root' &&
      sourceNode.nodeType !== 'library' &&
      sourceNode.nodeType !== 'songList'
    ) {
      const nodePath = sourcePaths.get(sourceNode.uuid)
      if (!nodePath) continue
      await assertExpectedDirectoryEntries({
        dirPath: nodePath.abs,
        expectedDirectoryNames: children.map((child) => child.dirName),
        code: 'SOURCE_TREE_INVALID'
      })
    }
  }
  for (const coreKey of ['FilterLibrary', 'CuratedLibrary'] as const) {
    const core = sourceCores.get(coreKey)
    const corePath = core ? sourcePaths.get(core.uuid) : null
    if (!core || !corePath) continue
    await assertExpectedDirectoryEntries({
      dirPath: corePath.abs,
      expectedDirectoryNames: (sourceChildren.get(core.uuid) || []).map((child) => child.dirName),
      code: 'SOURCE_TREE_INVALID'
    })
  }
  for (const [coreKey, extraDirectory] of [
    ['SetLibrary', SET_CUSTODY_DIR_NAME],
    ['MixtapeLibrary', MIXTAPE_VAULT_DIR_NAME]
  ] as const) {
    const core = sourceCores.get(coreKey)
    const corePath = core ? sourcePaths.get(core.uuid) : null
    if (!core || !corePath) continue
    await assertExpectedDirectoryEntries({
      dirPath: corePath.abs,
      expectedDirectoryNames: (sourceChildren.get(core.uuid) || []).map((child) => child.dirName),
      allowedExtraDirectoryNames: [extraDirectory],
      code: 'SOURCE_TREE_INVALID'
    })
  }
  if (recordingSourceCore) {
    const recordingPath = sourcePaths.get(recordingSourceCore.uuid)
    if (recordingPath) {
      await assertExpectedDirectoryEntries({
        dirPath: recordingPath.abs,
        expectedDirectoryNames: [],
        allowRegularFiles: true,
        code: 'SOURCE_TREE_INVALID'
      })
    }
  }

  const sourceLabel = sanitizeSourceLabel(sourceRoot)
  const plannedNodes: PlannedNode[] = []
  const sourceToPlan = new Map<string, PlannedNode>()
  const plannedChildren = new Map<string, Map<string, PlannedNode | LibraryNode>>()

  for (const [parentUuid, children] of targetChildren.entries()) {
    const byName = new Map<string, PlannedNode | LibraryNode>()
    for (const child of children) byName.set(normalizeNameKey(child.dirName), child)
    plannedChildren.set(parentUuid, byName)
  }

  const mapSourceNode = (sourceNode: LibraryNode, targetNode: LibraryNode | PlannedNode): void => {
    const sourcePath = sourcePaths.get(sourceNode.uuid)
    const targetPath =
      'targetRel' in targetNode
        ? { abs: targetNode.targetAbs, rel: targetNode.targetRel }
        : targetPaths.get(targetNode.uuid)
    if (!sourcePath || !targetPath) {
      throw new LibraryMergeError('SOURCE_TREE_INVALID', '无法解析库树节点路径')
    }
    const mapping: PlannedNode = {
      sourceUuid: sourceNode.uuid,
      targetUuid: 'targetUuid' in targetNode ? targetNode.targetUuid : targetNode.uuid,
      parentTargetUuid:
        'parentTargetUuid' in targetNode ? targetNode.parentTargetUuid : targetNode.parentUuid,
      sourceRel: sourcePath.rel,
      targetRel: targetPath.rel,
      sourceAbs: sourcePath.abs,
      targetAbs: targetPath.abs,
      nodeType:
        sourceNode.nodeType === 'songList' ||
        sourceNode.nodeType === 'mixtapeList' ||
        sourceNode.nodeType === 'setList'
          ? sourceNode.nodeType
          : 'dir',
      order: 'order' in targetNode ? targetNode.order : null,
      isNew: false
    }
    sourceToPlan.set(sourceNode.uuid, mapping)
  }

  mapSourceNode(sourceRootNode, targetRootNode)
  for (const coreKey of IMPORTED_CORE_LIBRARY_NAMES) {
    const sourceCore = sourceCores.get(coreKey)
    const targetCore = targetCores.get(coreKey)
    if (!sourceCore || !targetCore) continue
    mapSourceNode(sourceCore, targetCore)
  }

  const planChildren = async (sourceParent: LibraryNode): Promise<void> => {
    const parentPlan = sourceToPlan.get(sourceParent.uuid)
    if (!parentPlan) {
      throw new LibraryMergeError('SOURCE_TREE_INVALID', '来源节点缺少目标映射')
    }
    const parentTargetUuid = parentPlan.targetUuid
    const occupied =
      plannedChildren.get(parentTargetUuid) || new Map<string, PlannedNode | LibraryNode>()
    plannedChildren.set(parentTargetUuid, occupied)
    let nextOrder = Math.max(0, ...Array.from(occupied.values()).map((node) => node.order ?? 0))
    for (const sourceNode of sourceChildren.get(sourceParent.uuid) || []) {
      if (
        sourceNode.nodeType !== 'dir' &&
        sourceNode.nodeType !== 'songList' &&
        sourceNode.nodeType !== 'mixtapeList' &&
        sourceNode.nodeType !== 'setList'
      ) {
        throw new LibraryMergeError(
          'SOURCE_SPECIAL_LIBRARY_UNSUPPORTED',
          `来源普通库包含不支持的节点：${sourceNode.dirName}`
        )
      }
      const existing = occupied.get(normalizeNameKey(sourceNode.dirName))
      if (
        sourceNode.nodeType === 'dir' &&
        existing &&
        'nodeType' in existing &&
        existing.nodeType === 'dir'
      ) {
        mapSourceNode(sourceNode, existing)
        await planChildren(sourceNode)
        continue
      }

      const needsRename = !!existing
      const targetName = needsRename
        ? suffixName(sourceNode.dirName, sourceLabel, new Set(occupied.keys()))
        : sourceNode.dirName
      const targetUuid = uuidV4()
      const parentTargetPath =
        'targetRel' in parentPlan
          ? { abs: parentPlan.targetAbs, rel: parentPlan.targetRel }
          : targetPaths.get(parentTargetUuid)
      const sourcePath = sourcePaths.get(sourceNode.uuid)
      if (!parentTargetPath || !sourcePath) {
        throw new LibraryMergeError('SOURCE_TREE_INVALID', '无法建立来源节点映射')
      }
      const nextPlan: PlannedNode = {
        sourceUuid: sourceNode.uuid,
        targetUuid,
        parentTargetUuid,
        sourceRel: sourcePath.rel,
        targetRel: path.join(parentTargetPath.rel, targetName),
        sourceAbs: sourcePath.abs,
        targetAbs: path.join(parentTargetPath.abs, targetName),
        nodeType: sourceNode.nodeType,
        order: (nextOrder += 1),
        isNew: true
      }
      const occupiedTargetPath = await fs.lstat(nextPlan.targetAbs).catch(() => null)
      if (occupiedTargetPath) {
        throw new LibraryMergeError(
          'TARGET_TREE_INVALID',
          `当前库目录中存在未登记的同名项目，无法安全合并：${nextPlan.targetAbs}`
        )
      }
      plannedNodes.push(nextPlan)
      sourceToPlan.set(sourceNode.uuid, nextPlan)
      occupied.set(normalizeNameKey(targetName), nextPlan)
      if (sourceNode.nodeType === 'dir') await planChildren(sourceNode)
    }
  }

  for (const coreKey of [
    'FilterLibrary',
    'CuratedLibrary',
    'SetLibrary',
    'MixtapeLibrary'
  ] as const) {
    const sourceCore = sourceCores.get(coreKey)
    if (sourceCore) await planChildren(sourceCore)
  }

  const files: PlannedFile[] = []
  for (const node of plannedNodes) {
    if (node.nodeType === 'songList') {
      files.push(...(await assertSourceSongList(node)))
      continue
    }
    if (node.nodeType === 'mixtapeList' || node.nodeType === 'setList') {
      await assertLeafDirectoryHasNoUserContent(node.sourceAbs, node.sourceRel)
    }
  }
  const reservedAssetPaths = new Set<string>()
  const sourceSetCore = sourceCores.get('SetLibrary')
  const targetSetCore = targetCores.get('SetLibrary')
  const sourceMixtapeCore = sourceCores.get('MixtapeLibrary')
  const targetMixtapeCore = targetCores.get('MixtapeLibrary')
  const targetRecordingCore = targetCores.get('RecordingLibrary')
  const sourceSetPath = sourceSetCore ? sourcePaths.get(sourceSetCore.uuid) : null
  const targetSetPath = targetSetCore ? targetPaths.get(targetSetCore.uuid) : null
  const sourceMixtapePath = sourceMixtapeCore ? sourcePaths.get(sourceMixtapeCore.uuid) : null
  const targetMixtapePath = targetMixtapeCore ? targetPaths.get(targetMixtapeCore.uuid) : null
  const sourceRecordingPath = recordingSourceCore ? sourcePaths.get(recordingSourceCore.uuid) : null
  const targetRecordingPath = targetRecordingCore ? targetPaths.get(targetRecordingCore.uuid) : null
  if (sourceSetPath && targetSetPath) {
    const custodyPath = path.join(sourceSetPath.abs, SET_CUSTODY_DIR_NAME)
    if (await fs.lstat(custodyPath).catch(() => null)) {
      files.push(
        ...(await planAssets({
          sourceDir: custodyPath,
          targetDir: path.join(targetSetPath.abs, SET_CUSTODY_DIR_NAME),
          sourceLabel,
          stagePrefix: 'set-custody',
          reservedPaths: reservedAssetPaths
        }))
      )
    }
  }
  if (sourceMixtapePath && targetMixtapePath) {
    const vaultPath = path.join(sourceMixtapePath.abs, MIXTAPE_VAULT_DIR_NAME)
    if (await fs.lstat(vaultPath).catch(() => null)) {
      files.push(
        ...(await planAssets({
          sourceDir: vaultPath,
          targetDir: path.join(targetMixtapePath.abs, MIXTAPE_VAULT_DIR_NAME),
          sourceLabel,
          stagePrefix: 'mixtape-vault',
          reservedPaths: reservedAssetPaths
        }))
      )
    }
  }
  if (sourceRecordingPath && targetRecordingPath) {
    files.push(
      ...(await planAssets({
        sourceDir: sourceRecordingPath.abs,
        targetDir: targetRecordingPath.abs,
        sourceLabel,
        stagePrefix: 'recordings',
        reservedPaths: reservedAssetPaths
      }))
    )
  }
  const sourceFilePathToTarget = new Map(
    files.map((file) => [getMergeFilePathKey(file.sourceAbs), path.resolve(file.targetAbs)])
  )
  await validateSpecialDataRows({
    sourceDb: params.sourceDb,
    sourceRoot,
    sourceToPlan,
    sourceFilePathToTarget
  })
  const copiedBytes = files.reduce((total, file) => total + file.size, 0)
  const capacity = await getCapacity(
    targetRoot,
    params.sourceDb,
    copiedBytes,
    getJournalPeakBytes(plannedNodes, files),
    Math.max(0, Number(params.sourceSchemaSnapshotBytes || 0)),
    params.availableBytesBeforeSourceSnapshot
  )
  const sourceListRootToTarget = new Map<string, PlannedNode>()
  for (const node of plannedNodes) {
    if (node.nodeType !== 'songList') continue
    sourceListRootToTarget.set(normalizeRelativePath(node.sourceRel), node)
  }
  validatePlannedSongCacheRows(params.sourceDb, sourceRoot, sourceListRootToTarget, files)

  const songListCount = plannedNodes.filter((node) => node.nodeType === 'songList').length
  const renamedSongListCount = plannedNodes.filter(
    (node) =>
      node.nodeType === 'songList' &&
      path.basename(node.sourceRel) !== path.basename(node.targetRel)
  ).length
  const summary: LibraryMergePlanSummary = {
    sourceRoot,
    targetRoot,
    sourceLabel,
    sourceManifestUuid: sourceManifest.uuid,
    targetManifestUuid: targetManifest.uuid,
    songListCount,
    renamedSongListCount,
    copiedFileCount: files.length,
    copiedBytes,
    capacity
  }
  return {
    sourceRoot,
    targetRoot,
    sourceLabel,
    sourceManifestUuid: sourceManifest.uuid,
    targetManifestUuid: targetManifest.uuid,
    nodes: plannedNodes,
    files,
    sourceListRootToTarget,
    nodeUuidMap: new Map(
      Array.from(sourceToPlan.entries()).map(([sourceUuid, node]) => [sourceUuid, node.targetUuid])
    ),
    nodePathMappings: Array.from(sourceToPlan.values()).map((node) => ({
      sourceAbs: node.sourceAbs,
      targetAbs: node.targetAbs
    })),
    sourceFilePathToTarget,
    capacity,
    summary
  }
}

export const normalizeLibraryMergeCacheRoot = (sourceRoot: string, value: string): string => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (path.isAbsolute(raw)) {
    if (!isPathInside(sourceRoot, raw)) return ''
    return normalizeRelativePath(path.relative(sourceRoot, raw))
  }
  return normalizeRelativePath(raw)
}

export const normalizeLibraryMergeCacheFilePath = (
  sourceRoot: string,
  sourceListRoot: string,
  value: string
): string => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (path.isAbsolute(raw)) {
    const sourceListAbs = path.join(sourceRoot, sourceListRoot)
    if (!isPathInside(sourceListAbs, raw)) return ''
    return path.normalize(path.relative(sourceListAbs, raw))
  }
  return path.normalize(raw)
}
