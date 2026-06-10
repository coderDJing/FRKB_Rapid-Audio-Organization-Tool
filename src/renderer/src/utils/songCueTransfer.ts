import type { ISongHotCue, ISongMemoryCue } from 'src/types/globals'

type SongCueSource = {
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
}

export type SongCueCopyEntry = {
  targetFilePath?: string | null
  sourceSong?: SongCueSource | null
}

export type SongCueCopySummary = {
  targetCount: number
  hotCueTargetCount: number
  memoryCueTargetCount: number
  hotCueUpdated: number
  memoryCueUpdated: number
}

const normalizeFilePath = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const copySongCueDefinitionsToTargets = async (
  entries: SongCueCopyEntry[]
): Promise<SongCueCopySummary> => {
  const normalizedEntries = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const filePath = normalizeFilePath(entry?.targetFilePath)
      const hotCues = Array.isArray(entry?.sourceSong?.hotCues)
        ? entry.sourceSong.hotCues.map((cue) => ({ ...cue }))
        : []
      const memoryCues = Array.isArray(entry?.sourceSong?.memoryCues)
        ? entry.sourceSong.memoryCues.map((cue) => ({ ...cue }))
        : []
      if (!filePath || (hotCues.length === 0 && memoryCues.length === 0)) return null
      return {
        filePath,
        hotCues,
        memoryCues
      }
    })
    .filter(
      (
        entry
      ): entry is {
        filePath: string
        hotCues: ISongHotCue[]
        memoryCues: ISongMemoryCue[]
      } => Boolean(entry)
    )

  const baseSummary: SongCueCopySummary = {
    targetCount: normalizedEntries.length,
    hotCueTargetCount: normalizedEntries.filter((entry) => entry.hotCues.length > 0).length,
    memoryCueTargetCount: normalizedEntries.filter((entry) => entry.memoryCues.length > 0).length,
    hotCueUpdated: 0,
    memoryCueUpdated: 0
  }

  if (normalizedEntries.length === 0) return baseSummary
  const result = (await window.electron.ipcRenderer.invoke(
    'song:copy-cue-definitions-by-file-path',
    {
      entries: normalizedEntries
    }
  )) as Partial<Pick<SongCueCopySummary, 'hotCueUpdated' | 'memoryCueUpdated'>> | undefined

  return {
    ...baseSummary,
    hotCueUpdated: Number(result?.hotCueUpdated) || 0,
    memoryCueUpdated: Number(result?.memoryCueUpdated) || 0
  }
}
