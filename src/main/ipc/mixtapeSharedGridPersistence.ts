import { upsertMixtapeItemGridByFilePath } from '../mixtapeDb'
import {
  isCompleteSharedSongGridDefinition,
  loadSharedSongGridDefinition,
  loadSharedSongGridDefinitions,
  persistSharedSongGridDefinition,
  shouldKeepManualSharedSongGridDefinition,
  type SharedSongGridDefinition
} from '../services/sharedSongGrid'
import { emitSongGridUpdated } from '../services/songGridEvents'

export const resolveWritableSharedGridEntries = async (
  entries: SharedSongGridDefinition[],
  beatGridSource: SharedSongGridDefinition['beatGridSource'] = 'analysis'
): Promise<SharedSongGridDefinition[]> => {
  const normalizedEntries = entries
    .filter(
      (item) =>
        typeof item?.filePath === 'string' &&
        item.filePath.trim().length > 0 &&
        (item.bpm !== undefined ||
          item.firstBeatMs !== undefined ||
          item.barBeatOffset !== undefined ||
          item.timeBasisOffsetMs !== undefined ||
          item.beatGridMap !== undefined ||
          item.beatGridAlgorithmVersion !== undefined)
    )
    .map((item) => ({ ...item, beatGridSource }))
  if (!normalizedEntries.length) return []
  const writableEntries: SharedSongGridDefinition[] = []
  for (const item of normalizedEntries) {
    if (beatGridSource === 'analysis') {
      const current = await loadSharedSongGridDefinition(item.filePath).catch(
        (): SharedSongGridDefinition | null => null
      )
      if (shouldKeepManualSharedSongGridDefinition(current, item)) continue
    }
    writableEntries.push(item)
  }
  return writableEntries
}

export const persistAndBroadcastSharedGridEntries = async (
  writableEntries: SharedSongGridDefinition[]
): Promise<void> => {
  if (!writableEntries.length) return
  const results = await Promise.allSettled(
    writableEntries.map((item) => persistSharedSongGridDefinition(item))
  )
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    if (result.status === 'fulfilled' && result.value) {
      emitSongGridUpdated(result.value)
      continue
    }
    emitSongGridUpdated(writableEntries[index])
  }
}

export const persistAndBroadcastSharedGridBatch = async (
  entries: SharedSongGridDefinition[],
  beatGridSource: SharedSongGridDefinition['beatGridSource'] = 'analysis'
): Promise<void> => {
  const writableEntries = await resolveWritableSharedGridEntries(entries, beatGridSource)
  await persistAndBroadcastSharedGridEntries(writableEntries)
}

export const hydrateMixtapeItemsGridFromShared = async (items: Array<{ filePath?: string }>) => {
  const filePaths = Array.from(
    new Set(
      items
        .map((item) => (typeof item?.filePath === 'string' ? item.filePath.trim() : ''))
        .filter(Boolean)
    )
  )
  if (!filePaths.length) return { updated: 0 }

  const sharedGridMap = await loadSharedSongGridDefinitions(filePaths).catch(
    (): Map<string, SharedSongGridDefinition> => new Map()
  )
  const entries: SharedSongGridDefinition[] = []
  for (const filePath of filePaths) {
    const sharedGrid = sharedGridMap.get(filePath)
    if (!isCompleteSharedSongGridDefinition(sharedGrid)) continue
    entries.push({
      filePath,
      bpm: sharedGrid.bpm,
      firstBeatMs: sharedGrid.firstBeatMs,
      barBeatOffset: sharedGrid.barBeatOffset,
      timeBasisOffsetMs: sharedGrid.timeBasisOffsetMs,
      beatGridMap: sharedGrid.beatGridMap ?? undefined,
      beatGridAlgorithmVersion: sharedGrid.beatGridAlgorithmVersion
    })
  }
  return upsertMixtapeItemGridByFilePath(entries)
}
