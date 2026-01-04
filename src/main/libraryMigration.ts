import { app, dialog, BrowserWindow } from 'electron'
import type { MessageBoxOptions } from 'electron'
import fs = require('fs-extra')
import path = require('path')
import store from './store'
import { getMetaValue, initLibraryDb, setMetaValue } from './libraryDb'
import {
  scanLegacyCacheRoots,
  migrateLegacyCachesInLibrary,
  LegacyCacheRoots
} from './libraryCacheDb'
import FingerprintStore from './fingerprintStore'
import { syncLibrarySettingsFromDb } from './librarySettingsDb'
import { log } from './log'
import zhCNLocale from '../renderer/src/i18n/locales/zh-CN.json'
import enUSLocale from '../renderer/src/i18n/locales/en-US.json'
import {
  archiveLegacyDescriptionFiles,
  archiveLegacyDescriptionFilesByRoot,
  isLibraryTreeMigrationDone,
  isLibraryTreeMigrationInProgress,
  needsLibraryTreeArchive,
  needsLibraryTreeMigration,
  migrateLegacyLibraryTree,
  setLibraryTreeMigrationDone,
  setLibraryTreeMigrationInProgress
} from './libraryTreeDb'

const MIGRATION_DONE_KEY = 'legacy_migration_done_v1'
const MIGRATION_IN_PROGRESS_KEY = 'legacy_migration_in_progress_v1'
const CACHE_MIGRATION_DONE_KEY = 'legacy_cache_migrated_v1'
const FINGERPRINT_MIGRATED_PCM_KEY = 'fingerprints_migrated_pcm'
const FINGERPRINT_MIGRATED_FILE_KEY = 'fingerprints_migrated_file'
const DATA_PREFIX = 'songFingerprintV2_'

type LegacyFingerprintNeed = {
  pcm: boolean
  file: boolean
}

type LegacyMigrationPlan = {
  reasons: string[]
  cacheRoots: LegacyCacheRoots
  fingerprintNeeded: boolean
  libraryTreeNeeded: boolean
  libraryTreeArchiveNeeded: boolean
}

const getCurrentLocaleId = (): 'zh-CN' | 'en-US' =>
  (store.settingConfig as any)?.language === 'enUS' ? 'en-US' : 'zh-CN'

const tMigration = (key: string): string => {
  const MESSAGES: Record<'zh-CN' | 'en-US', any> = {
    'zh-CN': zhCNLocale as any,
    'en-US': enUSLocale as any
  }
  const localeId = getCurrentLocaleId()
  const parts = key.split('.')
  let cur: any = MESSAGES[localeId]
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p]
    else return key
  }
  return typeof cur === 'string' ? cur : key
}

function hasMetaFlag(db: any, key: string): boolean {
  return getMetaValue(db, key) === '1'
}

function hasFingerprintRows(db: any, mode: 'pcm' | 'file'): boolean {
  try {
    const row = db.prepare('SELECT COUNT(1) as count FROM fingerprints WHERE mode = ?').get(mode)
    return row && Number(row.count) > 0
  } catch {
    return false
  }
}

async function hasVersionedFiles(dirPath: string): Promise<boolean> {
  try {
    const names = await fs.readdir(dirPath)
    return names.some((name) => name.startsWith(DATA_PREFIX) && name.endsWith('.json'))
  } catch {
    return false
  }
}

async function detectLegacyFingerprints(dbRoot: string, db: any): Promise<LegacyFingerprintNeed> {
  const result: LegacyFingerprintNeed = { pcm: false, file: false }
  if (!dbRoot) return result
  const base = path.join(dbRoot, 'songFingerprint')
  if (!(await fs.pathExists(base))) return result

  const pcmDone = hasMetaFlag(db, FINGERPRINT_MIGRATED_PCM_KEY) || hasFingerprintRows(db, 'pcm')
  const fileDone = hasMetaFlag(db, FINGERPRINT_MIGRATED_FILE_KEY) || hasFingerprintRows(db, 'file')

  if (!pcmDone) {
    const legacyV1 = path.join(base, 'songFingerprint.json')
    const legacyV2 = path.join(base, 'songFingerprintV2.json')
    if (await fs.pathExists(legacyV1)) result.pcm = true
    if (await fs.pathExists(legacyV2)) result.pcm = true
    if (!result.pcm && (await hasVersionedFiles(base))) result.pcm = true
    if (!result.pcm && (await hasVersionedFiles(path.join(base, 'pcm')))) result.pcm = true
  }

  if (!fileDone) {
    if (await hasVersionedFiles(path.join(base, 'file'))) result.file = true
  }

  return result
}

async function buildLegacyMigrationPlan(dbRoot: string, db: any): Promise<LegacyMigrationPlan> {
  const cacheDone = hasMetaFlag(db, CACHE_MIGRATION_DONE_KEY)
  const cacheRoots = cacheDone
    ? { songRoots: new Set<string>(), coverRoots: new Set<string>() }
    : await scanLegacyCacheRoots(dbRoot)
  const fingerprintNeed = await detectLegacyFingerprints(dbRoot, db)
  const libraryTreeNeeded = await needsLibraryTreeMigration(dbRoot, db)
  const libraryTreeArchiveNeeded = await needsLibraryTreeArchive(dbRoot, db)
  const reasons: string[] = []
  if (libraryTreeNeeded || libraryTreeArchiveNeeded) reasons.push('库结构')
  if (fingerprintNeed.pcm || fingerprintNeed.file) reasons.push('指纹库')
  if (cacheRoots.songRoots.size > 0) reasons.push('扫描缓存')
  if (cacheRoots.coverRoots.size > 0) reasons.push('封面索引')
  return {
    reasons,
    cacheRoots,
    fingerprintNeeded: fingerprintNeed.pcm || fingerprintNeed.file,
    libraryTreeNeeded,
    libraryTreeArchiveNeeded
  }
}

function buildPromptMessage(inProgress: boolean): string {
  const lines: string[] = []
  if (inProgress) {
    lines.push(tMigration('migration.legacyInProgress'))
  }
  lines.push(tMigration('migration.legacyRequired'))
  lines.push(tMigration('migration.legacyActions'))
  return lines.join('\n')
}

async function collectLegacyDescriptionFiles(dbRoot: string): Promise<string[]> {
  const result: string[] = []
  if (!dbRoot) return result
  const libRoot = path.join(dbRoot, 'library')
  if (!(await fs.pathExists(libRoot))) return result
  const queue: string[] = [libRoot]
  while (queue.length > 0) {
    const current = queue.shift() as string
    const desc = path.join(current, '.description.json')
    const legacy = path.join(current, '.description.json.legacy')
    if (await fs.pathExists(desc)) result.push(desc)
    if (await fs.pathExists(legacy)) result.push(legacy)
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      queue.push(path.join(current, entry.name))
    }
  }
  return result
}

async function collectLegacyCacheFiles(dbRoot: string): Promise<string[]> {
  const result: string[] = []
  if (!dbRoot) return result
  const roots = await scanLegacyCacheRoots(dbRoot)
  for (const root of roots.songRoots) {
    result.push(path.join(root, '.songs.cache.json'))
  }
  for (const root of roots.coverRoots) {
    result.push(path.join(root, '.frkb_covers', '.index.json'))
  }
  return result
}

async function collectLegacyFingerprintFiles(dbRoot: string): Promise<string[]> {
  const result: string[] = []
  if (!dbRoot) return result
  const base = path.join(dbRoot, 'songFingerprint')
  if (!(await fs.pathExists(base))) return result
  const staticNames = [
    'songFingerprint.json',
    'songFingerprintV2.json',
    'latest.meta',
    '.fingerprint_healed'
  ]
  for (const name of staticNames) {
    const full = path.join(base, name)
    if (await fs.pathExists(full)) result.push(full)
  }
  try {
    const names = await fs.readdir(base)
    for (const name of names) {
      if (!name.startsWith(DATA_PREFIX) || !name.endsWith('.json')) continue
      const full = path.join(base, name)
      const stat = await fs.stat(full).catch(() => null)
      if (stat && stat.isFile()) result.push(full)
    }
  } catch {}
  return result
}

async function deleteLegacyFiles(dbRoot: string, files: string[]): Promise<number> {
  const unique = Array.from(new Set(files.filter((item) => !!item)))
  if (!dbRoot || unique.length === 0) return 0
  let deleted = 0
  for (const filePath of unique) {
    try {
      if (!(await fs.pathExists(filePath))) continue
      await fs.remove(filePath)
      deleted += 1
    } catch {}
  }
  return deleted
}

async function cleanupLegacyFiles(dbRoot: string): Promise<number> {
  const descFiles = await collectLegacyDescriptionFiles(dbRoot)
  const cacheFiles = await collectLegacyCacheFiles(dbRoot)
  const fingerprintFiles = await collectLegacyFingerprintFiles(dbRoot)
  const targets = [...descFiles, ...cacheFiles, ...fingerprintFiles]
  const deleted = await deleteLegacyFiles(dbRoot, targets)
  try {
    const base = path.join(dbRoot, 'songFingerprint')
    if (await fs.pathExists(base)) {
      await fs.remove(base)
    }
  } catch {}
  return deleted
}

export async function ensureLegacyMigration(
  dbRoot: string,
  parent?: BrowserWindow | null
): Promise<boolean> {
  if (!dbRoot) return true
  const db = initLibraryDb(dbRoot)
  if (!db) return true

  const done = hasMetaFlag(db, MIGRATION_DONE_KEY)
  const inProgress = hasMetaFlag(db, MIGRATION_IN_PROGRESS_KEY)
  const treeDone = isLibraryTreeMigrationDone(db)
  const treeInProgress = isLibraryTreeMigrationInProgress(db)

  const plan = await buildLegacyMigrationPlan(dbRoot, db)
  const needsPrompt = inProgress || treeInProgress || plan.reasons.length > 0

  if (!needsPrompt) {
    setMetaValue(db, MIGRATION_DONE_KEY, '1')
    if (!treeDone) {
      setLibraryTreeMigrationDone(db, true)
      setLibraryTreeMigrationInProgress(db, false)
    }
    await syncLibrarySettingsFromDb(dbRoot)
    await FingerprintStore.healAndPrepare()
    return true
  }

  const message = buildPromptMessage(inProgress || treeInProgress)
  const dialogOptions: MessageBoxOptions = {
    type: 'warning',
    buttons: [tMigration('migration.legacyConfirm'), tMigration('migration.legacyExit')],
    defaultId: 0,
    cancelId: 1,
    title: tMigration('migration.legacyTitle'),
    message,
    noLink: true
  }
  const result = parent
    ? await dialog.showMessageBox(parent, dialogOptions)
    : await dialog.showMessageBox(dialogOptions)
  if (result.response !== 0) {
    app.quit()
    return false
  }

  setMetaValue(db, MIGRATION_IN_PROGRESS_KEY, '1')
  if (plan.libraryTreeNeeded || treeInProgress) {
    setLibraryTreeMigrationInProgress(db, true)
  }
  try {
    await syncLibrarySettingsFromDb(dbRoot)
    await FingerprintStore.healAndPrepare()
    if (plan.libraryTreeNeeded || treeInProgress) {
      const nodes = await migrateLegacyLibraryTree(dbRoot, db)
      if (nodes && nodes.length > 0) {
        setLibraryTreeMigrationDone(db, true)
        setLibraryTreeMigrationInProgress(db, false)
        if (plan.libraryTreeArchiveNeeded) {
          await archiveLegacyDescriptionFiles(nodes, db)
        }
      } else {
        setLibraryTreeMigrationInProgress(db, false)
      }
    } else if (plan.libraryTreeArchiveNeeded) {
      await archiveLegacyDescriptionFilesByRoot(dbRoot, db)
    }
    if (plan.cacheRoots.songRoots.size > 0 || plan.cacheRoots.coverRoots.size > 0) {
      await migrateLegacyCachesInLibrary(dbRoot, plan.cacheRoots)
      setMetaValue(db, CACHE_MIGRATION_DONE_KEY, '1')
    }
    await cleanupLegacyFiles(dbRoot)
    setMetaValue(db, MIGRATION_DONE_KEY, '1')
    setMetaValue(db, MIGRATION_IN_PROGRESS_KEY, '0')
  } catch (error) {
    log.error('[migration] legacy migration failed', error)
  }

  return true
}

export default {
  ensureLegacyMigration
}
