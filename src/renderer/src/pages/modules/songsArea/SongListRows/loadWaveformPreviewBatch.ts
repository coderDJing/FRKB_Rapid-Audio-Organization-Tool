import type { WaveformListPreviewData } from '@shared/waveformSurfaceCache'

type WaveformPreviewItem = { filePath: string; data: WaveformListPreviewData | null }

export const loadWaveformPreviewBatch = async (
  filePaths: string[],
  resolveListRoot: (filePath: string) => string
): Promise<WaveformPreviewItem[] | null> => {
  const groups = new Map<string, string[]>()
  for (const filePath of filePaths) {
    const listRoot = resolveListRoot(filePath)
    const group = groups.get(listRoot) || []
    group.push(filePath)
    groups.set(listRoot, group)
  }
  try {
    const responses = await Promise.all(
      Array.from(groups.entries()).map(async ([listRoot, groupedFilePaths]) => {
        const response: { items?: WaveformPreviewItem[] } | null =
          await window.electron.ipcRenderer.invoke('waveform-list-preview-cache:batch', {
            listRoot,
            filePaths: groupedFilePaths,
            queueIfMissing: false
          })
        return Array.isArray(response?.items) ? response.items : []
      })
    )
    return responses.flat()
  } catch {
    return null
  }
}
