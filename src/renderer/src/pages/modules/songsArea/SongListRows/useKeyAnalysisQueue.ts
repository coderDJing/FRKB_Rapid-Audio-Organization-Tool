import { onUnmounted, watch } from 'vue'
import type { Ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import { hasUsableSongEnergyAnalysis } from '@shared/songEnergy'
import {
  hasRequiredSongStructureAnalysis,
  hasUsableKeyAnalysis,
  hasUsableSongBeatGridAnalysis
} from '@shared/songAnalysisCompleteness'

interface UseKeyAnalysisQueueOptions {
  visibleSongsWithIndex: Ref<Array<{ song: ISongInfo; idx: number }>>
  songs?: Ref<ISongInfo[]>
  enabled?: Ref<boolean>
  queueKey?: Ref<string>
  requiresRuntimeAnalysis?: Ref<boolean>
}

const CURRENT_LIST_QUEUE_LIMIT = 400

const hasRequiredKeyAnalysis = (song: ISongInfo | undefined, requiresRuntimeAnalysis: boolean) => {
  if (!song) return false
  if (!hasUsableSongEnergyAnalysis(song) || !hasUsableKeyAnalysis(song)) return false
  if (!requiresRuntimeAnalysis) return true
  return hasUsableSongBeatGridAnalysis(song) && hasRequiredSongStructureAnalysis(song)
}

export function useKeyAnalysisQueue({
  visibleSongsWithIndex,
  songs,
  enabled,
  queueKey,
  requiresRuntimeAnalysis
}: UseKeyAnalysisQueueOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastSignature = ''
  const isEnabled = () => (enabled ? enabled.value !== false : true)
  const shouldRequireRuntimeAnalysis = () => requiresRuntimeAnalysis?.value === true
  const sendVisibleQueue = (filePaths: string[]) => {
    window.electron.ipcRenderer.send('key-analysis:queue-visible', {
      filePaths,
      scope: 'list'
    })
  }
  const clearVisibleQueue = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    lastSignature = ''
    sendVisibleQueue([])
  }

  const appendPendingSongPath = (
    paths: string[],
    seen: Set<string>,
    song: ISongInfo | undefined
  ) => {
    if (!song || hasRequiredKeyAnalysis(song, shouldRequireRuntimeAnalysis())) return
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
    const signature = `${queueKey?.value || ''}:${shouldRequireRuntimeAnalysis() ? 'runtime' : 'lite'}::${paths.join('|')}`
    if (signature === lastSignature) return
    lastSignature = signature
    sendVisibleQueue(paths)
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      flush()
    }, 160)
  }

  const stopWatch = watch(
    () =>
      `${queueKey?.value || ''}:${shouldRequireRuntimeAnalysis() ? 'runtime' : 'lite'}::${buildForegroundPayload().join('|')}`,
    () => {
      if (!isEnabled()) return
      schedule()
    },
    { immediate: true }
  )
  const stopEnabledWatch = watch(
    () => isEnabled(),
    (enabledNow, enabledBefore) => {
      if (enabledNow) {
        schedule()
        return
      }
      if (enabledBefore) clearVisibleQueue()
    }
  )

  onUnmounted(() => {
    stopWatch()
    stopEnabledWatch()
    clearVisibleQueue()
  })
}
