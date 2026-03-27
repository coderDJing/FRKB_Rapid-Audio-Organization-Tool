import path from 'node:path'
import type {
  IPioneerPreviewWaveformData,
  IPioneerPreviewWaveformColumn
} from '../../../types/globals'
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

const resolvePioneerDevicePath = (rootPath: string, devicePath: string) => {
  const normalizedRoot = String(rootPath || '').trim()
  const normalizedDevicePath = String(devicePath || '').trim()
  if (!normalizedRoot || !normalizedDevicePath) return ''
  const sanitized = normalizedDevicePath.replace(/^[/\\]+/, '')
  return path.join(normalizedRoot, sanitized)
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

export async function loadPioneerPreviewWaveformsByDrivePath(
  rootPath: string,
  analyzePaths: string[]
): Promise<{
  drivePath: string
  items: PioneerPreviewWaveformLoadItem[]
}> {
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

  const items = new Map<string, PioneerPreviewWaveformLoadItem>()
  for (const analyzePath of normalizedAnalyzePaths) {
    items.set(analyzePath, {
      analyzePath,
      data: null
    })
  }

  const absoluteAnalyzePathByRelative = new Map<string, string>()
  const relativeAnalyzePathByAbsolute = new Map<string, string>()
  const absoluteAnalyzePaths: string[] = []
  for (const analyzePath of normalizedAnalyzePaths) {
    const absoluteAnalyzePath = resolvePioneerDevicePath(normalizedRootPath, analyzePath)
    if (!absoluteAnalyzePath) {
      items.set(analyzePath, {
        analyzePath,
        data: null,
        error: 'invalid analyze path'
      })
      continue
    }
    absoluteAnalyzePathByRelative.set(analyzePath, absoluteAnalyzePath)
    relativeAnalyzePathByAbsolute.set(absoluteAnalyzePath, analyzePath)
    absoluteAnalyzePaths.push(absoluteAnalyzePath)
  }

  await readPioneerPreviewWaveformsInWorker<{ total?: number }>(
    absoluteAnalyzePaths,
    (progress) => {
      const item = progress as WorkerPreviewWaveformItem | null
      const absoluteAnalyzePath = String(item?.analyzeFilePath || '').trim()
      const analyzePath = relativeAnalyzePathByAbsolute.get(absoluteAnalyzePath)
      if (!analyzePath) return
      const normalized = normalizeWaveformData(item?.dump || null)
      items.set(analyzePath, {
        analyzePath,
        data: normalized.data,
        error: normalized.error || undefined
      })
    }
  )

  for (const analyzePath of normalizedAnalyzePaths) {
    const absoluteAnalyzePath = absoluteAnalyzePathByRelative.get(analyzePath)
    if (!absoluteAnalyzePath) continue
    const current = items.get(analyzePath)
    if (current?.data || current?.error) continue
    items.set(analyzePath, {
      analyzePath,
      data: null,
      error: 'waveform worker returned no item'
    })
  }

  return {
    drivePath: normalizedRootPath,
    items: normalizedAnalyzePaths.map(
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

  const absoluteAnalyzePaths: string[] = []
  const relativeAnalyzePathByAbsolute = new Map<string, string>()
  for (const analyzePath of normalizedAnalyzePaths) {
    const absoluteAnalyzePath = resolvePioneerDevicePath(normalizedRootPath, analyzePath)
    if (!absoluteAnalyzePath) {
      onItem({
        analyzePath,
        data: null,
        error: 'invalid analyze path'
      })
      continue
    }
    absoluteAnalyzePaths.push(absoluteAnalyzePath)
    relativeAnalyzePathByAbsolute.set(absoluteAnalyzePath, analyzePath)
  }

  await readPioneerPreviewWaveformsInWorker<{ total?: number }>(
    absoluteAnalyzePaths,
    (progress) => {
      const item = progress as WorkerPreviewWaveformItem | null
      const absoluteAnalyzePath = String(item?.analyzeFilePath || '').trim()
      const analyzePath = relativeAnalyzePathByAbsolute.get(absoluteAnalyzePath)
      if (!analyzePath) return
      const normalized = normalizeWaveformData(item?.dump || null)
      onItem({
        analyzePath,
        data: normalized.data,
        error: normalized.error || undefined
      })
    }
  )

  return {
    drivePath: normalizedRootPath,
    total: normalizedAnalyzePaths.length
  }
}
