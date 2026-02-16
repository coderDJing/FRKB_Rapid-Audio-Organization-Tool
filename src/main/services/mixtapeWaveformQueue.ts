import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../log'
import { decodeAudioShared } from './audioDecodePool'
import { findSongListRoot } from './cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'
import mixtapeWindow from '../window/mixtapeWindow'
import type { MixxxWaveformData } from '../waveformCache'

const MIXTAPE_WAVEFORM_TARGET_RATE = 441
const inflight = new Set<string>()

const normalizeTargetRate = (value: number | undefined) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return MIXTAPE_WAVEFORM_TARGET_RATE
  return Math.max(1, parsed)
}

export async function requestMixtapeWaveform(
  filePath: string,
  targetRate?: number,
  options?: { traceLabel?: string }
) {
  const normalized = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalized) return null
  const rate = normalizeTargetRate(targetRate)
  const traceLabel = options?.traceLabel || 'mixtape-waveform'
  try {
    const result = await decodeAudioShared(normalized, {
      analyzeKey: false,
      needWaveform: true,
      waveformTargetRate: rate,
      traceLabel
    })
    return (result.mixxxWaveformData as MixxxWaveformData | null | undefined) ?? null
  } catch (error) {
    log.error('[mixtape] waveform request failed', {
      filePath: normalized,
      targetRate: rate,
      error
    })
    return null
  }
}

const notifyMixtapeWaveformUpdated = (filePath: string) => {
  try {
    mixtapeWindow.broadcast?.('mixtape-waveform-updated', { filePath })
  } catch {}
}

const computeMixtapeWaveform = async (filePath: string, listRoot?: string) => {
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
      await LibraryCacheDb.removeMixtapeWaveformCacheEntry(resolvedRoot, normalized)
      return
    }
    const waveform = await requestMixtapeWaveform(normalized, MIXTAPE_WAVEFORM_TARGET_RATE)
    if (!waveform) return
    await LibraryCacheDb.upsertMixtapeWaveformCacheEntry(
      resolvedRoot,
      normalized,
      { size: stat.size, mtimeMs: stat.mtimeMs },
      waveform
    )
    notifyMixtapeWaveformUpdated(normalized)
  } catch (error) {
    log.error('[mixtape] waveform build failed', { filePath: normalized, error })
  } finally {
    inflight.delete(normalized)
  }
}

export function queueMixtapeWaveforms(filePaths: string[], listRoot?: string) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return
  for (const filePath of filePaths) {
    void computeMixtapeWaveform(filePath, listRoot)
  }
}
