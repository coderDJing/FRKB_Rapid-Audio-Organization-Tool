import fs from 'node:fs/promises'
import path from 'node:path'
import { migrateStandaloneLibraryDb } from '../../libraryDb'
import { LibraryMergeError } from './types'

type SqliteDatabase = InstanceType<typeof import('better-sqlite3')>
type BackupCapableSqliteDatabase = {
  backup: (databasePath: string) => Promise<unknown>
}

const MIN_SOURCE_SCHEMA_SNAPSHOT_BYTES = 64 * 1024 * 1024
const SOURCE_SCHEMA_SNAPSHOT_OVERHEAD_BYTES = 16 * 1024 * 1024

export const getDatabaseSchemaVersion = (db: SqliteDatabase): number =>
  Number(db.pragma('user_version', { simple: true }))

export const getSourceSchemaSnapshotReserveBytes = (sourceDb: SqliteDatabase): number => {
  const pageSize = Number(sourceDb.pragma('page_size', { simple: true }))
  const pageCount = Number(sourceDb.pragma('page_count', { simple: true }))
  const logicalBytes = Math.max(
    0,
    Number.isFinite(pageSize) && Number.isFinite(pageCount) ? pageSize * pageCount : 0
  )
  // SQLite backup creates one complete copy; a schema migration can transiently retain old
  // pages plus WAL frames while rebuilding indexes or tables.
  return Math.max(
    MIN_SOURCE_SCHEMA_SNAPSHOT_BYTES,
    Math.ceil(logicalBytes * 3 + SOURCE_SCHEMA_SNAPSHOT_OVERHEAD_BYTES)
  )
}

export const getTargetAvailableBytes = async (targetRoot: string): Promise<number> => {
  try {
    const stats = await fs.statfs(targetRoot)
    const availableBytes = Number(stats.bavail) * Number(stats.bsize)
    if (Number.isFinite(availableBytes) && availableBytes >= 0) return availableBytes
  } catch {}
  throw new LibraryMergeError('CAPACITY_UNAVAILABLE', '无法读取目标磁盘可用空间')
}

export type SourceSchemaSnapshot = {
  databasePath: string
  reserveBytes: number
  availableBytesBeforeSnapshot: number
}

export async function createUpgradedSourceSchemaSnapshot(params: {
  sourceDb: SqliteDatabase
  targetDb: SqliteDatabase
  targetRoot: string
  workspaceDir: string
}): Promise<SourceSchemaSnapshot | null> {
  const sourceSchemaVersion = getDatabaseSchemaVersion(params.sourceDb)
  const targetSchemaVersion = getDatabaseSchemaVersion(params.targetDb)
  if (sourceSchemaVersion === targetSchemaVersion) return null
  if (sourceSchemaVersion > targetSchemaVersion) {
    throw new LibraryMergeError(
      'SOURCE_SCHEMA_UNSUPPORTED',
      `来源库数据库版本高于当前库（来源 ${sourceSchemaVersion}，当前 ${targetSchemaVersion}），请升级 FRKB 后再合并`
    )
  }
  const reserveBytes = getSourceSchemaSnapshotReserveBytes(params.sourceDb)
  const availableBytesBeforeSnapshot = await getTargetAvailableBytes(params.targetRoot)
  if (availableBytesBeforeSnapshot < reserveBytes) {
    throw new LibraryMergeError(
      'INSUFFICIENT_SPACE',
      `目标磁盘可用空间不足，无法创建来源库升级快照，还需要 ${reserveBytes - availableBytesBeforeSnapshot} 字节`
    )
  }
  const snapshotPath = path.join(params.workspaceDir, 'source-upgrade.sqlite')
  await fs.mkdir(params.workspaceDir, { recursive: true })
  try {
    // The bundled better-sqlite3 runtime supports backup(), but the installed declaration file
    // predates this method. Keep the boundary explicit instead of weakening the DB type globally.
    const backupDb = params.sourceDb as unknown as BackupCapableSqliteDatabase
    if (typeof backupDb.backup !== 'function') {
      throw new Error('当前 SQLite 运行时不支持一致性备份')
    }
    await backupDb.backup(snapshotPath)
    migrateStandaloneLibraryDb(snapshotPath)
    return { databasePath: snapshotPath, reserveBytes, availableBytesBeforeSnapshot }
  } catch (error) {
    await fs.rm(params.workspaceDir, { recursive: true, force: true }).catch(() => {})
    throw new LibraryMergeError(
      'SOURCE_SCHEMA_UPGRADE_FAILED',
      `无法在隔离副本中升级来源库：${error instanceof Error ? error.message : String(error)}`
    )
  }
}
