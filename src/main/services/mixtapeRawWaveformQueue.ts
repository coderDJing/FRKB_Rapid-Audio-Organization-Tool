import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../log'
import { decodeAudioShared, type SharedRawWaveformData } from './audioDecodePool'
import { findMixtapeCacheRoot } from './cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'
import { isMissingFileDecodeError } from './decodeErrorUtils'
import { resolveMixtapeFilePathWithFallback } from './mixtapeFileFallback'
import { isLibraryMergeMutationLocked } from './libraryMerge/mutationGate'

const RAW_WAVEFORM_TARGET_RATE = 2400
const inflight = new Set<string>()
let cancelGeneration = 0

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
    const resolved = await resolveMixtapeFilePathWithFallback(normalized, 'raw-waveform')
    if (!resolved) return null
    const result = await decodeAudioShared(resolved.filePath, {
      analyzeKey: false,
      needWaveform: false,
      needRawWaveform: true,
      rawTargetRate: rate,
      traceLabel: 'mixtape-raw-waveform',
      priority: 'low'
    })
    return (result.rawWaveformData as SharedRawWaveformData | null | undefined) ?? null
  } catch (error) {
    if (!isMissingFileDecodeError(error)) {
      log.error('[mixtape] raw waveform request failed', {
        filePath: normalized,
        targetRate: rate,
        error
      })
    }
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
  const generation = cancelGeneration
  inflight.add(normalized)
  try {
    if (generation !== cancelGeneration) return
    const resolved = await resolveMixtapeFilePathWithFallback(normalized, 'raw-waveform')
    if (generation !== cancelGeneration) return
    const targetPath = resolved?.filePath || ''
    let resolvedRoot = listRoot?.trim() || ''
    if (!resolvedRoot || resolved?.recovered) {
      const probePath = targetPath || normalized
      resolvedRoot = (await findMixtapeCacheRoot(path.dirname(probePath))) || resolvedRoot
    }
    if (!resolvedRoot) return
    if (!targetPath) {
      if (generation !== cancelGeneration) return
      await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(resolvedRoot, normalized)
      return
    }
    const stat = await fs.stat(targetPath).catch(() => null)
    if (!stat) {
      if (generation !== cancelGeneration) return
      await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(resolvedRoot, normalized)
      return
    }
    const cached = await LibraryCacheDb.loadMixtapeRawWaveformCacheData(resolvedRoot, targetPath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })
    if (cached) return
    const waveform = await requestMixtapeRawWaveform(targetPath, targetRate)
    if (!waveform || generation !== cancelGeneration) return
    await LibraryCacheDb.upsertMixtapeRawWaveformCacheEntry(
      resolvedRoot,
      targetPath,
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
  if (isLibraryMergeMutationLocked()) return
  if (!Array.isArray(filePaths) || filePaths.length === 0) return
  // 并发控制由底层 AudioDecodeWorkerPool 的 worker 数量限制（2-10个）提供，
  // 超出的任务会在队列中等待，不会同时执行，无需在此处额外限制。
  for (const filePath of filePaths) {
    void computeMixtapeRawWaveform(filePath, listRoot, targetRate)
  }
}

export function isMixtapeRawWaveformQueueBusy(): boolean {
  return inflight.size > 0
}

export function cancelMixtapeRawWaveformQueueForLibraryMerge() {
  cancelGeneration += 1
}

export async function waitForMixtapeRawWaveformQueueIdle(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (inflight.size > 0) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}
