import type { ISongInfo } from 'src/types/globals'

type SongCueCopyEntry = {
  targetFilePath?: string | null
  sourceSong?: ISongInfo | null
}

const normalizeFilePath = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const copySongCueDefinitionsToTargets = async (entries: SongCueCopyEntry[]) => {
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
        hotCues: NonNullable<ISongInfo['hotCues']>
        memoryCues: NonNullable<ISongInfo['memoryCues']>
      } => Boolean(entry)
    )

  if (normalizedEntries.length === 0) return
  await window.electron.ipcRenderer.invoke('song:copy-cue-definitions-by-file-path', {
    entries: normalizedEntries
  })
}
