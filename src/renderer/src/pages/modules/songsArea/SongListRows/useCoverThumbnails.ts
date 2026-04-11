import { markRaw, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'
import emitter from '@renderer/utils/mitt'
import { getRekordboxCoverThumbChannel } from '@renderer/utils/rekordboxExternalSource'

interface UseCoverThumbnailsOptions {
  songs: Ref<ISongInfo[] | undefined>
  visibleSongsWithIndex: Ref<Array<{ song: ISongInfo; idx: number }>>
  startIndex: Ref<number>
  endIndex: Ref<number>
  visibleCount: Ref<number>
  songListRootDir?: Ref<string | undefined>
  enabled?: Ref<boolean>
}

type PioneerCoverResponse = {
  format?: string
  data?: Uint8Array | { data: number[] } | number[]
  dataUrl?: string
}

type QueueTask = (() => void) & { __fp?: string }

export function useCoverThumbnails({
  songs,
  visibleSongsWithIndex,
  startIndex,
  endIndex,
  visibleCount,
  songListRootDir,
  enabled
}: UseCoverThumbnailsOptions) {
  const coverUrlCache = markRaw(new Map<string, string | null>())
  const inflight = markRaw(new Map<string, Promise<string | null>>())
  const pendingQueue: QueueTask[] = []
  const coversTick = ref(0)
  let running = 0
  const MAX_CONCURRENCY = 12

  const resolveSongs = () => songs.value ?? []
  const resolveRootDir = () => (songListRootDir ? songListRootDir.value : undefined)
  const isEnabled = () => (enabled ? enabled.value !== false : true)
  const resolveSongByFilePath = (filePath: string) =>
    resolveSongs().find((song) => String(song?.filePath || '').trim() === filePath) || null

  function pump() {
    while (running < MAX_CONCURRENCY && pendingQueue.length > 0) {
      const task = pendingQueue.shift()
      if (!task) continue
      running++
      task()
    }
  }

  function onImgError(filePath: string) {
    coverUrlCache.set(filePath, null)
    coversTick.value++
  }

  function getCoverUrl(filePath: string): string | null | undefined {
    return coverUrlCache.get(filePath)
  }

  function fetchCoverUrl(filePath: string): Promise<string | null> {
    if (!isEnabled()) return Promise.resolve(null)
    if (!filePath) return Promise.resolve(null)
    const cached = coverUrlCache.get(filePath)
    if (cached !== undefined) return Promise.resolve(cached)
    const existing = inflight.get(filePath)
    if (existing) return existing

    const promise = new Promise<string | null>((resolve) => {
      const run = async () => {
        try {
          const song = resolveSongByFilePath(filePath)
          const pioneerCoverPath = String(song?.pioneerCoverPath || '').trim()
          const sourceKind =
            song?.externalSourceKind === 'desktop' || song?.externalSourceKind === 'usb'
              ? song.externalSourceKind
              : 'usb'
          const resp = pioneerCoverPath
            ? ((await window.electron.ipcRenderer.invoke(
                getRekordboxCoverThumbChannel(sourceKind),
                pioneerCoverPath
              )) as PioneerCoverResponse | null)
            : ((await window.electron.ipcRenderer.invoke(
                'getSongCoverThumb',
                filePath,
                48,
                resolveRootDir()
              )) as PioneerCoverResponse | null)

          if (resp && resp.dataUrl) {
            coverUrlCache.set(filePath, resp.dataUrl)
            coversTick.value++
            resolve(resp.dataUrl)
            return
          }
          if (resp && resp.data) {
            const rawData = resp.data
            const raw =
              rawData instanceof Uint8Array
                ? rawData
                : Array.isArray(rawData)
                  ? new Uint8Array(rawData)
                  : new Uint8Array(rawData.data || [])
            const blob = new Blob([raw.buffer], { type: resp.format || 'image/jpeg' })
            const url = URL.createObjectURL(blob)
            coverUrlCache.set(filePath, url)
            coversTick.value++
            resolve(url)
            return
          }
          coverUrlCache.set(filePath, null)
          coversTick.value++
          resolve(null)
        } catch {
          coverUrlCache.set(filePath, null)
          coversTick.value++
          resolve(null)
        } finally {
          inflight.delete(filePath)
          running--
          pump()
        }
      }

      if (!pendingQueue.some((fn) => fn?.__fp === filePath)) {
        run.__fp = filePath
        pendingQueue.push(run)
      }
      pump()
    })

    inflight.set(filePath, promise)
    return promise
  }

  function clearPendingByPath(filePath?: string) {
    if (!filePath) return
    for (let i = pendingQueue.length - 1; i >= 0; i -= 1) {
      const task = pendingQueue[i]
      if (task?.__fp === filePath) {
        pendingQueue.splice(i, 1)
      }
    }
  }

  function handleSongMetadataUpdated(payload: { filePath?: string; oldFilePath?: string }) {
    const newPath = payload?.filePath
    if (payload?.oldFilePath) {
      coverUrlCache.delete(payload.oldFilePath)
      inflight.delete(payload.oldFilePath)
      clearPendingByPath(payload.oldFilePath)
    }
    if (!newPath) return
    coverUrlCache.delete(newPath)
    inflight.delete(newPath)
    clearPendingByPath(newPath)
    coversTick.value++
    fetchCoverUrl(newPath)
  }

  function primePrefetchWindow() {
    if (!isEnabled()) return
    const arr = resolveSongs()
    const start = Math.max(0, startIndex.value - visibleCount.value)
    const end = Math.min(arr.length, endIndex.value + visibleCount.value)
    for (let i = start; i < end; i += 1) {
      const fp = arr[i]?.filePath
      if (fp && !coverUrlCache.has(fp)) fetchCoverUrl(fp)
    }
  }

  const stopVisibleWatch = watch(
    () =>
      visibleSongsWithIndex.value
        .map((item: { song: ISongInfo; idx: number }) => item.song?.filePath || '')
        .join('|'),
    () => {
      primePrefetchWindow()
    },
    { immediate: true }
  )

  const stopRangeWatch = watch(
    () => [startIndex.value, endIndex.value, resolveSongs().length] as const,
    () => primePrefetchWindow(),
    { deep: false }
  )

  onMounted(() => {
    if (isEnabled()) {
      primePrefetchWindow()
    }
    emitter.on('songMetadataUpdated', handleSongMetadataUpdated)
  })

  onUnmounted(() => {
    emitter.off('songMetadataUpdated', handleSongMetadataUpdated)
    stopVisibleWatch()
    stopRangeWatch()
    coverUrlCache.clear()
    inflight.clear()
    pendingQueue.length = 0
  })

  return {
    coversTick,
    getCoverUrl,
    fetchCoverUrl,
    onImgError
  }
}
