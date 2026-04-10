import { onUnmounted, watch } from 'vue'
import type { Ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'

interface UseKeyAnalysisQueueOptions {
  visibleSongsWithIndex: Ref<Array<{ song: ISongInfo; idx: number }>>
  songs?: Ref<ISongInfo[]>
  enabled?: Ref<boolean>
}

const CURRENT_LIST_QUEUE_LIMIT = 400

const hasCompleteKeyAnalysis = (song: ISongInfo | undefined) => {
  if (!song) return false
  const keyText = typeof song.key === 'string' ? song.key.trim() : ''
  const bpm = Number(song.bpm)
  const firstBeatMs = Number(song.firstBeatMs)
  const barBeatOffset = Number(song.barBeatOffset)
  return (
    keyText.length > 0 &&
    Number.isFinite(bpm) &&
    bpm > 0 &&
    Number.isFinite(firstBeatMs) &&
    firstBeatMs >= 0 &&
    Number.isFinite(barBeatOffset)
  )
}

export function useKeyAnalysisQueue({
  visibleSongsWithIndex,
  songs,
  enabled
}: UseKeyAnalysisQueueOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastSignature = ''
  const isEnabled = () => (enabled ? enabled.value !== false : true)

  const appendPendingSongPath = (
    paths: string[],
    seen: Set<string>,
    song: ISongInfo | undefined
  ) => {
    if (!song || hasCompleteKeyAnalysis(song)) return
    const filePath = typeof song.filePath === 'string' ? song.filePath.trim() : ''
    if (!filePath || seen.has(filePath)) return
    seen.add(filePath)
    paths.push(filePath)
  }

  const buildForegroundPayload = () => {
    const paths: string[] = []
    const seen = new Set<string>()
    for (const item of visibleSongsWithIndex.value || []) {
      appendPendingSongPath(paths, seen, item?.song)
    }
    for (const song of songs?.value || []) {
      if (paths.length >= CURRENT_LIST_QUEUE_LIMIT) break
      appendPendingSongPath(paths, seen, song)
    }
    return paths
  }

  const flush = () => {
    if (!isEnabled()) return
    const paths = buildForegroundPayload()
    const signature = paths.join('|')
    if (signature === lastSignature) return
    lastSignature = signature
    window.electron.ipcRenderer.send('key-analysis:queue-visible', { filePaths: paths })
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      flush()
    }, 160)
  }

  const stopWatch = watch(
    () => buildForegroundPayload().join('|'),
    () => {
      if (!isEnabled()) return
      schedule()
    },
    { immediate: true }
  )

  onUnmounted(() => {
    if (timer) clearTimeout(timer)
    stopWatch()
  })
}
