import path from 'node:path'
import { log } from '../../log'
import { readPioneerDetailWaveformsInWorker } from './workerPool'

type RustDetailWaveformColumn = {
  height?: number
  colorR?: number
  color_r?: number
  colorG?: number
  color_g?: number
  colorB?: number
  color_b?: number
}

type RustDetailWaveformDump = {
  style?: string
  detailRate?: number
  detail_rate?: number
  columns?: RustDetailWaveformColumn[]
  error?: string
}

type WorkerDetailWaveformItem = {
  analyzeFilePath?: string
  dump?: RustDetailWaveformDump | null
}

const resolvePioneerDevicePath = (rootPath: string, devicePath: string) => {
  const root = String(rootPath || '').trim()
  const device = String(devicePath || '')
    .trim()
    .replace(/^[/\\]+/, '')
  return root && device ? path.join(root, device) : ''
}

export async function loadPioneerDetailWaveformsByDrivePath(
  rootPath: string,
  analyzePaths: string[]
) {
  const requested = Array.from(
    new Set(
      (Array.isArray(analyzePaths) ? analyzePaths : []).map(String).map((value) => value.trim())
    )
  ).filter(Boolean)
  const result = new Map<
    string,
    { analyzePath: string; data: RustDetailWaveformDump | null; error?: string }
  >()
  const relativeByAbsolute = new Map<string, string>()
  for (const analyzePath of requested) {
    const absolute = resolvePioneerDevicePath(rootPath, analyzePath)
    if (!absolute) {
      result.set(analyzePath, { analyzePath, data: null, error: 'invalid analyze path' })
      continue
    }
    relativeByAbsolute.set(absolute, analyzePath)
  }
  await readPioneerDetailWaveformsInWorker<{ total?: number }>(
    Array.from(relativeByAbsolute.keys()),
    (progress) => {
      const item = progress as WorkerDetailWaveformItem | null
      const analyzePath = relativeByAbsolute.get(String(item?.analyzeFilePath || '').trim())
      if (!analyzePath) return
      const dump = item?.dump || null
      if (dump?.error) {
        log.error('[rekordbox-detail-waveform] read failed', {
          analyzePath,
          rootPath: String(rootPath || '').trim(),
          error: dump.error
        })
      }
      result.set(analyzePath, {
        analyzePath,
        data: dump?.error ? null : dump,
        error: dump?.error
      })
    }
  )
  const items = requested.map(
    (analyzePath) => result.get(analyzePath) || { analyzePath, data: null, error: 'missing result' }
  )
  return {
    drivePath: String(rootPath || '').trim(),
    items
  }
}
