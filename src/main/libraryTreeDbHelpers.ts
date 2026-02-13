import fs = require('fs-extra')
import path = require('path')
import { v4 as uuidV4 } from 'uuid'
import { getLibraryDb, initLibraryDb } from './libraryDb'
import { log } from './log'

export type LibraryNodeType = 'root' | 'library' | 'dir' | 'songList' | 'mixtapeList'

export type LibraryNodeRow = {
  uuid: string
  parentUuid: string | null
  dirName: string
  nodeType: LibraryNodeType
  order: number | null
}

export type LegacyLibraryNode = LibraryNodeRow & {
  fullPath: string
}

const NODE_UUID_MARKER_FILE = '.frkb.uuid'

export function normalizeOrder(value: any): number | null {
  if (value === null || value === undefined) return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

export function normalizeAudioExtensions(input?: string[]): Set<string> {
  const result = new Set<string>()
  if (!Array.isArray(input)) return result
  for (const raw of input) {
    if (!raw) continue
    let ext = String(raw).trim().toLowerCase()
    if (!ext) continue
    if (!ext.startsWith('.')) ext = `.${ext}`
    result.add(ext)
  }
  return result
}

export async function readUuidMarker(dirPath: string): Promise<string | null> {
  if (!dirPath) return null
  const markerPath = path.join(dirPath, NODE_UUID_MARKER_FILE)
  try {
    if (!(await fs.pathExists(markerPath))) return null
    const raw = await fs.readFile(markerPath, 'utf8')
    const value = String(raw || '').trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

async function setHiddenOnWindows(filePath: string): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    const { exec } = require('child_process')
    const { promisify } = require('util')
    const execAsync = promisify(exec)
    await execAsync(`attrib +h "${filePath}"`)
  } catch {}
}

export async function writeUuidMarker(dirPath: string, uuid: string): Promise<void> {
  if (!dirPath || !uuid) return
  const markerPath = path.join(dirPath, NODE_UUID_MARKER_FILE)
  try {
    let existing: string | null = null
    if (await fs.pathExists(markerPath)) {
      const raw = await fs.readFile(markerPath, 'utf8')
      existing = String(raw || '').trim()
    }
    if (existing === uuid) return
    await fs.outputFile(markerPath, uuid)
    await setHiddenOnWindows(markerPath)
  } catch {
    return
  }
}

export function decideNodeType(
  existingType: LibraryNodeType | null | undefined,
  hasSubdirs: boolean,
  hasAudio: boolean
): Exclude<LibraryNodeType, 'root' | 'library'> {
  if (existingType === 'mixtapeList') return 'mixtapeList'
  if (hasSubdirs) return 'dir'
  if (hasAudio) return 'songList'
  if (existingType === 'dir' || existingType === 'songList') return existingType
  return 'dir'
}

export function splitPath(input: string): string[] {
  return String(input || '')
    .split(/[\\/]+/)
    .filter((p) => p.length > 0)
}

export function getPathDepth(relPath: string): number {
  return splitPath(relPath).length
}

export function isNodeType(value: any): value is LibraryNodeType {
  return (
    value === 'root' ||
    value === 'library' ||
    value === 'dir' ||
    value === 'songList' ||
    value === 'mixtapeList'
  )
}

export function isChildNodeType(value: any): value is Exclude<LibraryNodeType, 'root'> {
  return value === 'library' || value === 'dir' || value === 'songList' || value === 'mixtapeList'
}

export function toNodeRow(row: any): LibraryNodeRow | null {
  if (!row || !row.uuid || !row.dir_name || !row.node_type) return null
  const nodeType = String(row.node_type)
  if (!isNodeType(nodeType)) return null
  return {
    uuid: String(row.uuid),
    parentUuid: row.parent_uuid ? String(row.parent_uuid) : null,
    dirName: String(row.dir_name),
    nodeType,
    order: normalizeOrder(row.sort_order)
  }
}

export function getDb(dbRoot?: string): any | null {
  if (dbRoot) return initLibraryDb(dbRoot)
  return getLibraryDb()
}

export function getRootNode(db: any): LibraryNodeRow | null {
  try {
    const row =
      db
        .prepare(
          'SELECT uuid, parent_uuid, dir_name, node_type, sort_order FROM library_nodes WHERE parent_uuid IS NULL AND node_type = ? LIMIT 1'
        )
        .get('root') ||
      db
        .prepare(
          'SELECT uuid, parent_uuid, dir_name, node_type, sort_order FROM library_nodes WHERE parent_uuid IS NULL AND dir_name = ? LIMIT 1'
        )
        .get('library')
    return toNodeRow(row)
  } catch {
    return null
  }
}

export function ensureRootNode(db: any): LibraryNodeRow | null {
  const existing = getRootNode(db)
  if (existing) return existing
  try {
    const uuid = uuidV4()
    db.prepare(
      'INSERT INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(uuid, null, 'library', 'root', 1)
    return {
      uuid,
      parentUuid: null,
      dirName: 'library',
      nodeType: 'root',
      order: 1
    }
  } catch (error) {
    log.error('[sqlite] library root create failed', error)
    return null
  }
}
