import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../log'
import { decodeAudioShared } from './audioDecodePool'
import { findSongListRoot } from './cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'
import mixtapeWindow from '../window/mixtapeWindow'
import type { MixxxWaveformData } from '../waveformCache'
import { isMissingFileDecodeError } from './decodeErrorUtils'
import { resolveMixtapeFilePathWithFallback } from './mixtapeFileFallback'

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
    const resolved = await resolveMixtapeFilePathWithFallback(normalized, 'waveform')
    if (!resolved) return null
    const result = await decodeAudioShared(resolved.filePath, {
      analyzeKey: false,
      needWaveform: true,
      waveformTargetRate: rate,
      traceLabel
    })
    return (result.mixxxWaveformData as MixxxWaveformData | null | undefined) ?? null
  } catch (error) {
    if (!isMissingFileDecodeError(error)) {
      log.error('[mixtape] waveform request failed', {
        filePath: normalized,
        targetRate: rate,
        error
      })
    }
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
    const resolved = await resolveMixtapeFilePathWithFallback(normalized, 'waveform')
    const targetPath = resolved?.filePath || ''
    let resolvedRoot = listRoot?.trim() || ''
    if (!resolvedRoot || resolved?.recovered) {
      const probePath = targetPath || normalized
      resolvedRoot = (await findSongListRoot(path.dirname(probePath))) || resolvedRoot
    }
    if (!resolvedRoot) return
    if (!targetPath) {
      await LibraryCacheDb.removeMixtapeWaveformCacheEntry(resolvedRoot, normalized)
      return
    }
    const stat = await fs.stat(targetPath).catch(() => null)
    if (!stat) {
      await LibraryCacheDb.removeMixtapeWaveformCacheEntry(resolvedRoot, normalized)
      return
    }
    const waveform = await requestMixtapeWaveform(targetPath, MIXTAPE_WAVEFORM_TARGET_RATE)
    if (!waveform) return
    await LibraryCacheDb.upsertMixtapeWaveformCacheEntry(
      resolvedRoot,
      targetPath,
      { size: stat.size, mtimeMs: stat.mtimeMs },
      waveform
    )
    notifyMixtapeWaveformUpdated(targetPath)
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
