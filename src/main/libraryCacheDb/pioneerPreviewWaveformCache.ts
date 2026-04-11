import path = require('path')
import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import type { IPioneerPreviewWaveformData } from '../../types/globals'

const PIONEER_PREVIEW_WAVEFORM_CACHE_TABLE = 'pioneer_preview_waveform_cache'
const PIONEER_PREVIEW_WAVEFORM_CACHE_VERSION = 1

type PioneerPreviewWaveformCacheStatus = 'ready' | 'missing'

export type PioneerPreviewWaveformCacheEntry = {
  signature: string
  status: PioneerPreviewWaveformCacheStatus
  previewFilePath?: string
  data: IPioneerPreviewWaveformData | null
  error?: string
}

const normalizeRootKey = (rootPath: string) => {
  const normalized = path.resolve(String(rootPath || '').trim())
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const normalizeAnalyzePathKey = (analyzePath: string) => {
  const sanitized = String(analyzePath || '')
    .trim()
    .replace(/^[/\\]+/, '')
  if (!sanitized) return ''
  const normalized = sanitized.replace(/[\\/]+/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const normalizeSignature = (signature: unknown) => String(signature || '').trim()

const parseWaveformDataJson = (value: unknown): IPioneerPreviewWaveformData | null => {
  if (!value) return null
  try {
    const parsed = JSON.parse(String(value)) as IPioneerPreviewWaveformData | null
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export async function loadPioneerPreviewWaveformCacheEntry(
  rootPath: string,
  analyzePath: string,
  signature: string
): Promise<PioneerPreviewWaveformCacheEntry | null | undefined> {
  const db = getLibraryDb()
  const listRootKey = normalizeRootKey(rootPath)
  const analyzePathKey = normalizeAnalyzePathKey(analyzePath)
  const signatureKey = normalizeSignature(signature)
  if (!db || !listRootKey || !analyzePathKey || !signatureKey) return undefined

  try {
    const row = db
      .prepare<{
        cache_version?: unknown
        signature?: unknown
        status?: unknown
        preview_file_path?: unknown
        data_json?: unknown
        error?: unknown
      }>(
        `SELECT cache_version, signature, status, preview_file_path, data_json, error
         FROM ${PIONEER_PREVIEW_WAVEFORM_CACHE_TABLE}
         WHERE list_root = ? AND analyze_path = ?`
      )
      .get(listRootKey, analyzePathKey)

    if (!row) return null

    const cacheVersion = Number(row.cache_version || 0)
    const cachedSignature = normalizeSignature(row.signature)
    if (
      cacheVersion !== PIONEER_PREVIEW_WAVEFORM_CACHE_VERSION ||
      !cachedSignature ||
      cachedSignature !== signatureKey
    ) {
      db.prepare(
        `DELETE FROM ${PIONEER_PREVIEW_WAVEFORM_CACHE_TABLE}
           WHERE list_root = ? AND analyze_path = ?`
      ).run(listRootKey, analyzePathKey)
      return null
    }

    const status = String(row.status || '').trim() === 'ready' ? 'ready' : 'missing'
    return {
      signature: cachedSignature,
      status,
      previewFilePath: String(row.preview_file_path || '').trim() || undefined,
      data: status === 'ready' ? parseWaveformDataJson(row.data_json) : null,
      error: String(row.error || '').trim() || undefined
    }
  } catch (error) {
    log.error('[sqlite] pioneer preview waveform cache load failed', error)
    return undefined
  }
}

export async function upsertPioneerPreviewWaveformCacheEntry(
  rootPath: string,
  analyzePath: string,
  entry: PioneerPreviewWaveformCacheEntry
): Promise<boolean> {
  const db = getLibraryDb()
  const listRootKey = normalizeRootKey(rootPath)
  const analyzePathKey = normalizeAnalyzePathKey(analyzePath)
  const signatureKey = normalizeSignature(entry.signature)
  if (!db || !listRootKey || !analyzePathKey || !signatureKey) return false

  const status: PioneerPreviewWaveformCacheStatus = entry.status === 'ready' ? 'ready' : 'missing'
  const dataJson = status === 'ready' && entry.data ? JSON.stringify(entry.data) : null
  const previewFilePath = String(entry.previewFilePath || '').trim() || null
  const errorText = String(entry.error || '').trim() || null

  try {
    db.prepare(
      `INSERT INTO ${PIONEER_PREVIEW_WAVEFORM_CACHE_TABLE}
       (list_root, analyze_path, cache_version, signature, status, preview_file_path, data_json, error, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(list_root, analyze_path) DO UPDATE SET
         cache_version = excluded.cache_version,
         signature = excluded.signature,
         status = excluded.status,
         preview_file_path = excluded.preview_file_path,
         data_json = excluded.data_json,
         error = excluded.error,
         updated_at_ms = excluded.updated_at_ms`
    ).run(
      listRootKey,
      analyzePathKey,
      PIONEER_PREVIEW_WAVEFORM_CACHE_VERSION,
      signatureKey,
      status,
      previewFilePath,
      dataJson,
      errorText,
      Date.now()
    )
    return true
  } catch (error) {
    log.error('[sqlite] pioneer preview waveform cache upsert failed', error)
    return false
  }
}

export async function clearPioneerPreviewWaveformCache(rootPath?: string): Promise<boolean> {
  const db = getLibraryDb()
  if (!db) return false
  try {
    if (rootPath) {
      const listRootKey = normalizeRootKey(rootPath)
      if (!listRootKey) return false
      db.prepare(`DELETE FROM ${PIONEER_PREVIEW_WAVEFORM_CACHE_TABLE} WHERE list_root = ?`).run(
        listRootKey
      )
    } else {
      db.prepare(`DELETE FROM ${PIONEER_PREVIEW_WAVEFORM_CACHE_TABLE}`).run()
    }
    return true
  } catch (error) {
    log.error('[sqlite] pioneer preview waveform cache clear failed', error)
    return false
  }
}
