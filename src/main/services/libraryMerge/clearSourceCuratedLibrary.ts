import fs from 'node:fs/promises'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createReadStream } from 'node:fs'
import { LibraryMergeError } from './types'

type SqliteDatabase = InstanceType<typeof import('better-sqlite3')>

type LibraryNodeRow = {
  uuid: string
  parentUuid: string | null
  dirName: string
  nodeType: string
  sortOrder: number | null
}

const SET_CUSTODY_DIR_NAME = '__set_custody__'
const CONTROL_FILE_NAMES = new Set(['.frkb.uuid', '.description.json', '.description.json.legacy'])
const DEFAULT_AUDIO_EXTS = [
  '.mp3',
  '.wav',
  '.flac',
  '.aiff',
  '.aif',
  '.m4a',
  '.aac',
  '.ogg',
  '.wma',
  '.alac'
]

const normalizeNameKey = (value: string): string =>
  String(value || '')
    .normalize('NFC')
    .toLocaleLowerCase()

const normalizePathKey = (value: string): string => {
  const normalized = path.resolve(String(value || ''))
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

const getCoreKeyForName = (name: string): string | null => {
  const aliases: Record<string, string[]> = {
    CuratedLibrary: ['CuratedLibrary', '精选库'],
    SetLibrary: ['SetLibrary', 'SET库'],
    RecycleBin: ['RecycleBin', '回收站']
  }
  const normalized = normalizeNameKey(name)
  for (const [key, list] of Object.entries(aliases)) {
    if (list.some((alias) => normalizeNameKey(alias) === normalized)) return key
  }
  return null
}

const listNodes = (db: SqliteDatabase): LibraryNodeRow[] => {
  const rows = db
    .prepare('SELECT uuid, parent_uuid, dir_name, node_type, sort_order FROM library_nodes')
    .all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    uuid: String(row.uuid || ''),
    parentUuid:
      row.parent_uuid === null || row.parent_uuid === undefined ? null : String(row.parent_uuid),
    dirName: typeof row.dir_name === 'string' ? row.dir_name : String(row.dir_name || ''),
    nodeType: String(row.node_type || ''),
    sortOrder:
      row.sort_order === null || row.sort_order === undefined ? null : Number(row.sort_order)
  }))
}

const buildChildren = (nodes: LibraryNodeRow[]): Map<string, LibraryNodeRow[]> => {
  const result = new Map<string, LibraryNodeRow[]>()
  for (const node of nodes) {
    if (!node.parentUuid) continue
    const list = result.get(node.parentUuid)
    if (list) list.push(node)
    else result.set(node.parentUuid, [node])
  }
  return result
}

const findRootNode = (nodes: LibraryNodeRow[]): LibraryNodeRow => {
  const roots = nodes.filter((node) => node.parentUuid === null && node.nodeType === 'root')
  if (roots.length !== 1) {
    throw new LibraryMergeError('SOURCE_TREE_INVALID', '来源库必须且只能有一个根节点')
  }
  return roots[0]
}

const findCoreNode = (
  root: LibraryNodeRow,
  children: Map<string, LibraryNodeRow[]>,
  coreKey: string
): LibraryNodeRow => {
  for (const child of children.get(root.uuid) || []) {
    if (child.nodeType !== 'library') continue
    if (getCoreKeyForName(child.dirName) === coreKey) return child
  }
  throw new LibraryMergeError('SOURCE_TREE_INVALID', `来源库缺少核心库：${coreKey}`)
}

const collectSubtreeNodes = (
  rootUuid: string,
  children: Map<string, LibraryNodeRow[]>
): LibraryNodeRow[] => {
  const result: LibraryNodeRow[] = []
  const queue = [...(children.get(rootUuid) || [])]
  while (queue.length > 0) {
    const node = queue.shift()
    if (!node) continue
    result.push(node)
    queue.push(...(children.get(node.uuid) || []))
  }
  return result
}

const resolveNodeAbsPath = (
  sourceRoot: string,
  node: LibraryNodeRow,
  nodesByUuid: Map<string, LibraryNodeRow>
): string => {
  const parts: string[] = []
  let current: LibraryNodeRow | undefined = node
  while (current) {
    parts.unshift(current.dirName)
    current = current.parentUuid ? nodesByUuid.get(current.parentUuid) : undefined
  }
  return path.join(sourceRoot, ...parts)
}

const hasTable = (db: SqliteDatabase, tableName: string): boolean => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as Record<string, unknown> | undefined
  return typeof row?.name === 'string'
}

const listSetItemsByFilePath = (
  db: SqliteDatabase,
  filePath: string
): Array<{ id: string; filePath: string }> => {
  if (!hasTable(db, 'set_items')) return []
  const candidates = [filePath, path.normalize(filePath)]
  if (process.platform === 'win32') {
    candidates.push(filePath.replace(/\//g, '\\'), filePath.replace(/\\/g, '/'))
  }
  const whereClause = process.platform === 'win32' ? 'LOWER(file_path) = LOWER(?)' : 'file_path = ?'
  const stmt = db.prepare(
    `SELECT id, file_path FROM set_items WHERE ${whereClause} ORDER BY sort_order ASC, created_at_ms ASC, id ASC`
  )
  const seen = new Set<string>()
  const result: Array<{ id: string; filePath: string }> = []
  for (const candidate of candidates) {
    const rows = stmt.all(candidate) as Array<Record<string, unknown>>
    for (const row of rows) {
      const id = String(row.id || '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      result.push({ id, filePath: String(row.file_path || '') })
    }
  }
  return result
}

const updateSetItemFilePath = (db: SqliteDatabase, id: string, nextPath: string): void => {
  db.prepare('UPDATE set_items SET file_path = ? WHERE id = ?').run(nextPath, id)
}

const upsertRecycleRecord = (
  db: SqliteDatabase,
  record: {
    filePath: string
    deletedAtMs: number
    originalPlaylistPath: string | null
    originalFileName: string | null
    sourceType: string | null
  }
): void => {
  if (!hasTable(db, 'recycle_bin_records')) return
  db.prepare(
    `INSERT INTO recycle_bin_records
      (file_path, deleted_at_ms, original_playlist_path, original_file_name, source_type)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       deleted_at_ms = excluded.deleted_at_ms,
       original_playlist_path = excluded.original_playlist_path,
       original_file_name = excluded.original_file_name,
       source_type = excluded.source_type`
  ).run(
    record.filePath,
    record.deletedAtMs,
    record.originalPlaylistPath,
    record.originalFileName,
    record.sourceType
  )
}

const collectAudioFiles = async (dirPath: string, audioExts: string[]): Promise<string[]> => {
  const extensions = new Set(audioExts.map((ext) => ext.toLowerCase()))
  const result: string[] = []
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (CONTROL_FILE_NAMES.has(entry.name)) continue
      const abs = path.join(current, entry.name)
      const stat = await fs.lstat(abs).catch(() => null)
      if (!stat || stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!stat.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (extensions.has(ext)) result.push(abs)
    }
  }
  await walk(dirPath)
  return result
}

const ensureUniqueDestination = async (dirPath: string, fileName: string): Promise<string> => {
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  let candidate = path.join(dirPath, fileName)
  let index = 1
  while (
    await fs
      .access(candidate)
      .then(() => true)
      .catch(() => false)
  ) {
    candidate = path.join(dirPath, `${base}_${index}${ext}`)
    index += 1
    if (index > 10_000) {
      throw new LibraryMergeError('SOURCE_DELETE_FAILED', `无法为文件分配唯一目标名：${fileName}`)
    }
  }
  return candidate
}

const moveFile = async (sourcePath: string, destPath: string): Promise<void> => {
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  try {
    await fs.rename(sourcePath, destPath)
    return
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code !== 'EXDEV') throw error
  }
  await pipeline(createReadStream(sourcePath), createWriteStream(destPath, { flags: 'wx' }))
  await fs.rm(sourcePath, { force: true })
}

const toLibraryRelativePath = (libraryRoot: string, absPath: string): string => {
  const relative = path.relative(libraryRoot, absPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new LibraryMergeError('SOURCE_DELETE_FAILED', `无法计算库相对路径：${absPath}`)
  }
  return relative.replace(/\\/g, '/')
}

export async function clearSourceCuratedLibrarySubtree(params: {
  sourceRoot: string
  sourceDb: SqliteDatabase
  audioExts?: string[]
}): Promise<void> {
  const sourceRoot = path.resolve(params.sourceRoot)
  const sourceDb = params.sourceDb
  sourceDb.pragma('foreign_keys = ON')
  const audioExts =
    Array.isArray(params.audioExts) && params.audioExts.length > 0
      ? params.audioExts
      : DEFAULT_AUDIO_EXTS

  const nodes = listNodes(sourceDb)
  const children = buildChildren(nodes)
  const nodesByUuid = new Map(nodes.map((node) => [node.uuid, node]))
  const root = findRootNode(nodes)
  const curatedCore = findCoreNode(root, children, 'CuratedLibrary')
  const setCore = findCoreNode(root, children, 'SetLibrary')
  const recycleCore = findCoreNode(root, children, 'RecycleBin')
  const curatedAbs = resolveNodeAbsPath(sourceRoot, curatedCore, nodesByUuid)
  const setAbs = resolveNodeAbsPath(sourceRoot, setCore, nodesByUuid)
  const recycleAbs = resolveNodeAbsPath(sourceRoot, recycleCore, nodesByUuid)
  const libraryRoot = path.join(sourceRoot, root.dirName)
  const custodyAbs = path.join(setAbs, SET_CUSTODY_DIR_NAME)

  if (!isPathInside(libraryRoot, curatedAbs) || !isPathInside(libraryRoot, recycleAbs)) {
    throw new LibraryMergeError('SOURCE_DELETE_FAILED', '来源精选库路径无效')
  }

  const subtree = collectSubtreeNodes(curatedCore.uuid, children)
  if (subtree.length === 0) return

  const directChildren = children.get(curatedCore.uuid) || []
  for (const child of directChildren) {
    if (child.nodeType !== 'dir' && child.nodeType !== 'songList') {
      throw new LibraryMergeError(
        'SOURCE_DELETE_FAILED',
        `来源精选库包含无法按完整删除链路处理的节点：${child.dirName}`
      )
    }
  }

  const audioFiles = await collectAudioFiles(curatedAbs, audioExts)
  const protectedKeys = new Set<string>()
  for (const filePath of audioFiles) {
    const refs = listSetItemsByFilePath(sourceDb, filePath)
    if (refs.length === 0) continue
    await fs.mkdir(custodyAbs, { recursive: true })
    const destPath = await ensureUniqueDestination(custodyAbs, path.basename(filePath))
    await moveFile(filePath, destPath)
    for (const ref of refs) {
      updateSetItemFilePath(sourceDb, ref.id, destPath)
    }
    protectedKeys.add(normalizePathKey(filePath))
  }

  await fs.mkdir(recycleAbs, { recursive: true })
  const deletedAtMs = Date.now()
  for (const filePath of audioFiles) {
    if (protectedKeys.has(normalizePathKey(filePath))) continue
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue
    const destPath = await ensureUniqueDestination(recycleAbs, path.basename(filePath))
    await moveFile(filePath, destPath)
    const relative = toLibraryRelativePath(libraryRoot, destPath)
    const originalPlaylistPath = isPathInside(curatedAbs, path.dirname(filePath))
      ? toLibraryRelativePath(libraryRoot, path.dirname(filePath))
      : null
    upsertRecycleRecord(sourceDb, {
      filePath: relative,
      deletedAtMs,
      originalPlaylistPath,
      originalFileName: path.basename(filePath),
      sourceType: 'curated_library_merge_source_clear'
    })
  }

  for (const child of directChildren) {
    const childAbs = resolveNodeAbsPath(sourceRoot, child, nodesByUuid)
    if (!isPathInside(curatedAbs, childAbs)) {
      throw new LibraryMergeError('SOURCE_DELETE_FAILED', `拒绝删除精选库外路径：${childAbs}`)
    }
    await fs.rm(childAbs, { recursive: true, force: true })
    sourceDb.prepare('DELETE FROM library_nodes WHERE uuid = ?').run(child.uuid)
  }

  const remaining = collectSubtreeNodes(curatedCore.uuid, buildChildren(listNodes(sourceDb)))
  if (remaining.length > 0) {
    throw new LibraryMergeError('SOURCE_DELETE_FAILED', '来源精选库清理后仍有残留节点')
  }
}
