import { clearMixtapeItemGridCopiesByFilePath } from '../mixtapeDb'
import {
  loadSharedSongGridDefinition,
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

export const clearMixtapeItemsGridCopiesFromShared = async (
  items: Array<{ filePath?: string }>
) => {
  const filePaths = Array.from(
    new Set(
      items
        .map((item) => (typeof item?.filePath === 'string' ? item.filePath.trim() : ''))
        .filter(Boolean)
    )
  )
  if (!filePaths.length) return { updated: 0 }

  // 项目 item 不保存歌曲网格；打开项目时仅顺手删除可能残留的历史副本。
  return clearMixtapeItemGridCopiesByFilePath(filePaths.map((filePath) => ({ filePath })))
}
