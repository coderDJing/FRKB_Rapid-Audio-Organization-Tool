import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../log'
import { decodeAudioShared, type SharedRawWaveformData } from './audioDecodePool'
import { findSongListRoot } from './cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'

const RAW_WAVEFORM_TARGET_RATE = 2400
const inflight = new Set<string>()

export async function requestMixtapeRawWaveform(
  filePath: string,
  targetRate?: number
): Promise<SharedRawWaveformData | null> {
  const normalized = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalized) return null
  const rate =
    Number.isFinite(targetRate) && (targetRate as number) > 0
      ? (targetRate as number)
      : RAW_WAVEFORM_TARGET_RATE
  try {
    const result = await decodeAudioShared(normalized, {
      analyzeKey: false,
      needWaveform: false,
      needRawWaveform: true,
      rawTargetRate: rate,
      traceLabel: 'mixtape-raw-waveform'
    })
    return (result.rawWaveformData as SharedRawWaveformData | null | undefined) ?? null
  } catch (error) {
    log.error('[mixtape] raw waveform request failed', {
      filePath: normalized,
      targetRate: rate,
      error
    })
    return null
  }
}

const computeMixtapeRawWaveform = async (
  filePath: string,
  listRoot?: string,
  targetRate?: number
) => {
  if (!filePath) return
  const normalized = filePath.trim()
  if (!normalized) return
  if (inflight.has(normalized)) return
  inflight.add(normalized)
  try {
    let resolvedRoot = listRoot?.trim() || ''
    if (!resolvedRoot) {
      resolvedRoot = (await findSongListRoot(path.dirname(normalized))) || ''
    }
    if (!resolvedRoot) return
    const stat = await fs.stat(normalized).catch(() => null)
    if (!stat) {
      await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(resolvedRoot, normalized)
      return
    }
    const cached = await LibraryCacheDb.loadMixtapeRawWaveformCacheData(resolvedRoot, normalized, {
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })
    if (cached) return
    const waveform = await requestMixtapeRawWaveform(normalized, targetRate)
    if (!waveform) return
    await LibraryCacheDb.upsertMixtapeRawWaveformCacheEntry(
      resolvedRoot,
      normalized,
      { size: stat.size, mtimeMs: stat.mtimeMs },
      waveform
    )
  } catch (error) {
    log.error('[mixtape] raw waveform build failed', { filePath: normalized, error })
  } finally {
    inflight.delete(normalized)
  }
}

export function queueMixtapeRawWaveforms(
  filePaths: string[],
  listRoot?: string,
  targetRate?: number
) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return
  for (const filePath of filePaths) {
    void computeMixtapeRawWaveform(filePath, listRoot, targetRate)
  }
}
