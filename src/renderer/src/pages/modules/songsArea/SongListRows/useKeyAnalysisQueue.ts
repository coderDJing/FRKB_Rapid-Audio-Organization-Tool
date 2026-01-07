import { onUnmounted, watch } from 'vue'
import type { Ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'

interface UseKeyAnalysisQueueOptions {
  visibleSongsWithIndex: Ref<Array<{ song: ISongInfo; idx: number }>>
}

export function useKeyAnalysisQueue({ visibleSongsWithIndex }: UseKeyAnalysisQueueOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastSignature = ''

  const buildVisiblePayload = () => {
    const paths: string[] = []
    const seen = new Set<string>()
    for (const item of visibleSongsWithIndex.value || []) {
      const song = item?.song
      if (!song || song.key) continue
      const filePath = song.filePath
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      paths.push(filePath)
    }
    return paths
  }

  const flush = () => {
    const paths = buildVisiblePayload()
    const signature = paths.join('|')
    if (!paths.length || signature === lastSignature) return
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
    () => visibleSongsWithIndex.value.map((item) => item.song?.filePath || '').join('|'),
    () => {
      schedule()
    },
    { immediate: true }
  )

  onUnmounted(() => {
    if (timer) clearTimeout(timer)
    stopWatch()
  })
}
