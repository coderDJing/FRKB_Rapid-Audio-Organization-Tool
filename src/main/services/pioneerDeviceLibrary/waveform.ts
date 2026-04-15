import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  IPioneerPreviewWaveformData,
  IPioneerPreviewWaveformColumn
} from '../../../types/globals'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { readPioneerPreviewWaveformsInWorker } from './workerPool'

type RustPioneerPreviewWaveformColumn = {
  backHeight?: number
  back_height?: number
  frontHeight?: number
  front_height?: number
  backColorR?: number
  back_color_r?: number
  backColorG?: number
  back_color_g?: number
  backColorB?: number
  back_color_b?: number
  frontColorR?: number
  front_color_r?: number
  frontColorG?: number
  front_color_g?: number
  frontColorB?: number
  front_color_b?: number
}

type RustPioneerPreviewWaveformDump = {
  analyzeFilePath?: string
  analyze_file_path?: string
  previewFilePath?: string
  preview_file_path?: string
  style?: string
  columnCount?: number
  column_count?: number
  maxHeight?: number
  max_height?: number
  columns?: RustPioneerPreviewWaveformColumn[]
  error?: string
}

type WorkerPreviewWaveformItem = {
  analyzeFilePath?: string
  dump?: RustPioneerPreviewWaveformDump | null
}

export type PioneerPreviewWaveformLoadItem = {
  analyzePath: string
  data: IPioneerPreviewWaveformData | null
  error?: string
}

type PreparedAnalyzePathItem = {
  analyzePath: string
  absoluteAnalyzePath: string
  signature: string
}

const PIONEER_PREVIEW_WAVEFORM_SIGNATURE_VERSION = 'preview-v2'

const resolvePioneerDevicePath = (rootPath: string, devicePath: string) => {
  const normalizedRoot = String(rootPath || '').trim()
  const normalizedDevicePath = String(devicePath || '').trim()
  if (!normalizedRoot || !normalizedDevicePath) return ''
  const sanitized = normalizedDevicePath.replace(/^[/\\]+/, '')
  return path.join(normalizedRoot, sanitized)
}

const buildPreviewCandidatePaths = (absoluteAnalyzePath: string) => {
  const normalized = String(absoluteAnalyzePath || '').trim()
  if (!normalized) return []
  const candidates = new Set<string>()
  const parsed = path.parse(normalized)
  const extensions = ['.EXT', '.DAT', '.2EX']
  for (const ext of extensions) {
    candidates.add(path.join(parsed.dir, `${parsed.name}${ext}`))
  }
  candidates.add(normalized)
  return Array.from(candidates)
}

const normalizeSignaturePath = (value: string) => {
  const normalized = path.resolve(String(value || '').trim())
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const buildPreviewFileSignature = async (absoluteAnalyzePath: string) => {
  const candidatePaths = buildPreviewCandidatePaths(absoluteAnalyzePath)
  const parts: string[] = [PIONEER_PREVIEW_WAVEFORM_SIGNATURE_VERSION]
  for (const candidatePath of candidatePaths) {
    try {
      const stat = await fs.stat(candidatePath)
      parts.push(
        `${normalizeSignaturePath(candidatePath)}|${stat.size}|${Math.round(Number(stat.mtimeMs) || 0)}`
      )
    } catch {}
  }
  return parts.length ? parts.join('||') : 'missing'
}

const normalizeWaveformColumn = (
  column: RustPioneerPreviewWaveformColumn
): IPioneerPreviewWaveformColumn => {
  return {
    backHeight: Number(column?.backHeight ?? column?.back_height) || 0,
    frontHeight: Number(column?.frontHeight ?? column?.front_height) || 0,
    backColorR: Number(column?.backColorR ?? column?.back_color_r) || 0,
    backColorG: Number(column?.backColorG ?? column?.back_color_g) || 0,
    backColorB: Number(column?.backColorB ?? column?.back_color_b) || 0,
    frontColorR: Number(column?.frontColorR ?? column?.front_color_r) || 0,
    frontColorG: Number(column?.frontColorG ?? column?.front_color_g) || 0,
    frontColorB: Number(column?.frontColorB ?? column?.front_color_b) || 0
  }
}

const normalizeWaveformData = (
  dump: RustPioneerPreviewWaveformDump | null | undefined
): { data: IPioneerPreviewWaveformData | null; error: string | null } => {
  if (!dump) return { data: null, error: 'missing waveform dump' }
  if (dump.error) return { data: null, error: String(dump.error) }
  const style = String(dump.style || '')
    .trim()
    .toLowerCase()
  if (style !== 'blue' && style !== 'rgb') {
    return { data: null, error: `unsupported waveform style: ${style || 'unknown'}` }
  }
  const rawColumns = Array.isArray(dump.columns) ? dump.columns : []
  const columns = rawColumns.map(normalizeWaveformColumn)
  if (!columns.length) return { data: null, error: 'empty waveform columns' }
  const maxHeight =
    Number(dump.maxHeight ?? dump.max_height) ||
    columns.reduce((value, column) => Math.max(value, Number(column.backHeight) || 0), 0)
  if (!Number.isFinite(maxHeight) || maxHeight <= 0) {
    return { data: null, error: 'waveform columns have no visible height' }
  }
  return {
    data: {
      style,
      analyzeFilePath: String(dump.analyzeFilePath ?? dump.analyze_file_path ?? '').trim(),
      previewFilePath: String(dump.previewFilePath ?? dump.preview_file_path ?? '').trim(),
      columnCount: Number(dump.columnCount ?? dump.column_count) || columns.length,
      maxHeight,
      columns
    },
    error: null
  }
}

const prepareAnalyzePathItems = async (rootPath: string, analyzePaths: string[]) => {
  const normalizedRootPath = String(rootPath || '').trim()
  const normalizedAnalyzePaths = Array.isArray(analyzePaths)
    ? Array.from(
        new Set(
          analyzePaths
            .map((analyzePath) => String(analyzePath || '').trim())
            .filter((analyzePath) => analyzePath.length > 0)
        )
      )
    : []

  const preparedItems = new Map<string, PreparedAnalyzePathItem>()
  const invalidItems = new Map<string, PioneerPreviewWaveformLoadItem>()

  for (const analyzePath of normalizedAnalyzePaths) {
    const absoluteAnalyzePath = resolvePioneerDevicePath(normalizedRootPath, analyzePath)
    if (!absoluteAnalyzePath) {
      invalidItems.set(analyzePath, {
        analyzePath,
        data: null,
        error: 'invalid analyze path'
      })
      continue
    }
    preparedItems.set(analyzePath, {
      analyzePath,
      absoluteAnalyzePath,
      signature: await buildPreviewFileSignature(absoluteAnalyzePath)
    })
  }

  return {
    rootPath: normalizedRootPath,
    analyzePaths: normalizedAnalyzePaths,
    preparedItems,
    invalidItems
  }
}

export async function loadPioneerPreviewWaveformsByDrivePath(
  rootPath: string,
  analyzePaths: string[]
): Promise<{
  drivePath: string
  items: PioneerPreviewWaveformLoadItem[]
}> {
  const prepared = await prepareAnalyzePathItems(rootPath, analyzePaths)

  const items = new Map<string, PioneerPreviewWaveformLoadItem>()
  for (const analyzePath of prepared.analyzePaths) {
    items.set(analyzePath, prepared.invalidItems.get(analyzePath) || { analyzePath, data: null })
  }

  const relativeAnalyzePathByAbsolute = new Map<string, string>()
  const absoluteAnalyzePaths: string[] = []
  for (const analyzePath of prepared.analyzePaths) {
    const preparedItem = prepared.preparedItems.get(analyzePath)
    if (!preparedItem) continue
    const cached = await LibraryCacheDb.loadPioneerPreviewWaveformCacheEntry(
      prepared.rootPath,
      analyzePath,
      preparedItem.signature
    )
    if (cached) {
      items.set(analyzePath, {
        analyzePath,
        data: cached.status === 'ready' ? cached.data : null,
        error: cached.error
      })
      continue
    }
    relativeAnalyzePathByAbsolute.set(preparedItem.absoluteAnalyzePath, analyzePath)
    absoluteAnalyzePaths.push(preparedItem.absoluteAnalyzePath)
  }

  await readPioneerPreviewWaveformsInWorker<{ total?: number }>(
    absoluteAnalyzePaths,
    (progress) => {
      const item = progress as WorkerPreviewWaveformItem | null
      const absoluteAnalyzePath = String(item?.analyzeFilePath || '').trim()
      const analyzePath = relativeAnalyzePathByAbsolute.get(absoluteAnalyzePath)
      if (!analyzePath) return
      const normalized = normalizeWaveformData(item?.dump || null)
      const preparedItem = prepared.preparedItems.get(analyzePath)
      if (preparedItem) {
        void LibraryCacheDb.upsertPioneerPreviewWaveformCacheEntry(prepared.rootPath, analyzePath, {
          signature: preparedItem.signature,
          status: normalized.data ? 'ready' : 'missing',
          previewFilePath: normalized.data?.previewFilePath,
          data: normalized.data,
          error: normalized.error || undefined
        })
      }
      items.set(analyzePath, {
        analyzePath,
        data: normalized.data,
        error: normalized.error || undefined
      })
    }
  )

  for (const analyzePath of prepared.analyzePaths) {
    const preparedItem = prepared.preparedItems.get(analyzePath)
    if (!preparedItem) continue
    const current = items.get(analyzePath)
    if (current?.data || current?.error) continue
    void LibraryCacheDb.upsertPioneerPreviewWaveformCacheEntry(prepared.rootPath, analyzePath, {
      signature: preparedItem.signature,
      status: 'missing',
      data: null,
      error: 'waveform worker returned no item'
    })
    items.set(analyzePath, {
      analyzePath,
      data: null,
      error: 'waveform worker returned no item'
    })
  }

  return {
    drivePath: prepared.rootPath,
    items: prepared.analyzePaths.map(
      (analyzePath) =>
        items.get(analyzePath) || {
          analyzePath,
          data: null,
          error: 'missing analyze path result'
        }
    )
  }
}

export async function streamPioneerPreviewWaveformsByDrivePath(
  rootPath: string,
  analyzePaths: string[],
  onItem: (item: PioneerPreviewWaveformLoadItem) => void
): Promise<{
  drivePath: string
  total: number
}> {
  const prepared = await prepareAnalyzePathItems(rootPath, analyzePaths)

  const absoluteAnalyzePaths: string[] = []
  const relativeAnalyzePathByAbsolute = new Map<string, string>()
  for (const analyzePath of prepared.analyzePaths) {
    const invalidItem = prepared.invalidItems.get(analyzePath)
    if (invalidItem) {
      onItem(invalidItem)
      continue
    }
    const preparedItem = prepared.preparedItems.get(analyzePath)
    if (!preparedItem) continue
    const cached = await LibraryCacheDb.loadPioneerPreviewWaveformCacheEntry(
      prepared.rootPath,
      analyzePath,
      preparedItem.signature
    )
    if (cached) {
      onItem({
        analyzePath,
        data: cached.status === 'ready' ? cached.data : null,
        error: cached.error
      })
      continue
    }
    absoluteAnalyzePaths.push(preparedItem.absoluteAnalyzePath)
    relativeAnalyzePathByAbsolute.set(preparedItem.absoluteAnalyzePath, analyzePath)
  }

  await readPioneerPreviewWaveformsInWorker<{ total?: number }>(
    absoluteAnalyzePaths,
    (progress) => {
      const item = progress as WorkerPreviewWaveformItem | null
      const absoluteAnalyzePath = String(item?.analyzeFilePath || '').trim()
      const analyzePath = relativeAnalyzePathByAbsolute.get(absoluteAnalyzePath)
      if (!analyzePath) return
      const normalized = normalizeWaveformData(item?.dump || null)
      const preparedItem = prepared.preparedItems.get(analyzePath)
      if (preparedItem) {
        void LibraryCacheDb.upsertPioneerPreviewWaveformCacheEntry(prepared.rootPath, analyzePath, {
          signature: preparedItem.signature,
          status: normalized.data ? 'ready' : 'missing',
          previewFilePath: normalized.data?.previewFilePath,
          data: normalized.data,
          error: normalized.error || undefined
        })
      }
      onItem({
        analyzePath,
        data: normalized.data,
        error: normalized.error || undefined
      })
    }
  )

  return {
    drivePath: prepared.rootPath,
    total: prepared.analyzePaths.length
  }
}
