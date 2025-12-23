import { onMounted, onUnmounted, ref, type Ref, type ShallowRef, watch } from 'vue'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'
import type { useRuntimeStore } from '@renderer/stores/runtime'

const SCORE_BATCH_SIZE = 200

const normalizePath = (p: string) => (p || '').replace(/\//g, '\\').toLowerCase()

const toPercent = (rawScore: number): number | null => {
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) return null
  let p = rawScore
  // 若模型输出不是概率，做一次 sigmoid 映射
  if (p < 0 || p > 1) {
    p = 1 / (1 + Math.exp(-p))
  }
  p = Math.max(0, Math.min(1, p))
  return Math.round(p * 100)
}

const debugSelection = (...args: any[]) => {
  try {
    const isDev =
      typeof window !== 'undefined' &&
      typeof window.location?.protocol === 'string' &&
      (window.location.protocol === 'http:' || window.location.hostname === 'localhost')
    const forced =
      typeof window !== 'undefined' &&
      typeof window.localStorage?.getItem === 'function' &&
      window.localStorage.getItem('FRKB_DEBUG_SELECTION') === '1'
    if (isDev || forced) {
      console.log(...args)
    }
  } catch {}
}

export function useSelectionPrediction(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  originalSongInfoArr: ShallowRef<ISongInfo[]>
  columnData: Ref<ISongsAreaColumn[]>
  applyFiltersAndSorting: () => void
}) {
  const { runtime, originalSongInfoArr, columnData, applyFiltersAndSorting } = params

  const jobId = ref(0)
  const predicting = ref(false)

  const clearSelectionScores = () => {
    for (const song of originalSongInfoArr.value) {
      ;(song as any).selectionScore = null
      ;(song as any).selectionLabel = undefined
    }
    for (const song of runtime.songsArea.songInfoArr) {
      ;(song as any).selectionScore = null
      ;(song as any).selectionLabel = undefined
    }
  }

  const applyPredictionPatch = (
    patchByPath: Map<
      string,
      { score: number | null; label: ISongInfo['selectionLabel'] | undefined }
    >
  ) => {
    for (const song of originalSongInfoArr.value) {
      const patch = patchByPath.get(normalizePath(song.filePath))
      if (patch === undefined) continue
      ;(song as any).selectionScore = patch.score
      ;(song as any).selectionLabel = patch.label
    }
    for (const song of runtime.songsArea.songInfoArr) {
      const patch = patchByPath.get(normalizePath(song.filePath))
      if (patch === undefined) continue
      ;(song as any).selectionScore = patch.score
      ;(song as any).selectionLabel = patch.label
    }
  }

  const refreshSelectionScoresForFilePaths = async (filePaths: string[]) => {
    const current = (jobId.value += 1)
    const normalized = Array.from(
      new Set(filePaths.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()))
    )
    if (normalized.length === 0) return
    if (!runtime.songsArea.songListUUID) return
    if (!runtime.setting?.databaseUrl) return

    debugSelection('[selection] 刷新预测分数：开始', {
      jobId: current,
      fileCount: normalized.length
    })

    predicting.value = true
    try {
      for (let i = 0; i < normalized.length; i += SCORE_BATCH_SIZE) {
        if (jobId.value !== current) return
        const batch = normalized.slice(i, i + SCORE_BATCH_SIZE)
        const batchStartedAt = Date.now()
        debugSelection('[selection] 预测批次：开始', {
          jobId: current,
          index: i,
          size: batch.length
        })

        // 先只展示“已具备音频特征”的曲目分数；特征未提取的曲目返回 null（不显示）
        const predictOnce = async (): Promise<string | null> => {
          const res: any = await window.electron.ipcRenderer.invoke(
            'selection:predictForFilePaths',
            {
              filePaths: batch,
              topK: batch.length
            }
          )

          if (jobId.value !== current) return null
          const status = typeof res?.status === 'string' ? res.status : null

          const patchByPath = new Map<
            string,
            { score: number | null; label: ISongInfo['selectionLabel'] | undefined }
          >()
          const items = Array.isArray(res?.fileItems) ? res.fileItems : []
          let scored = 0
          let labeled = 0
          for (const it of items) {
            const filePath = typeof it?.filePath === 'string' ? it.filePath : ''
            if (!filePath) continue
            const rawScore = typeof it?.score === 'number' ? it.score : null
            const mapped = rawScore === null ? null : toPercent(rawScore)
            if (mapped !== null) scored += 1

            const rawLabel = typeof it?.label === 'string' ? it.label : ''
            const label =
              rawLabel === 'liked' || rawLabel === 'disliked'
                ? (rawLabel as ISongInfo['selectionLabel'])
                : undefined
            if (label) labeled += 1

            patchByPath.set(normalizePath(filePath), { score: mapped, label })
          }
          applyPredictionPatch(patchByPath)
          debugSelection('[selection] 预测批次：完成', {
            jobId: current,
            index: i,
            status,
            scored,
            labeled,
            total: items.length
          })

          if (!res || status !== 'ok') {
            return status
          }
          return status
        }

        const status = await predictOnce()
        // 未训练/失败状态下没有“展示分数”的意义，也不应后台触发昂贵的特征提取（尤其是 OpenL3 推理）
        if (status !== 'ok') {
          continue
        }

        // 自动补齐缺失音频特征（主进程并发=2），补齐后再预测一次让分数出现
        const ensureRes: any = await window.electron.ipcRenderer.invoke(
          'selection:features:ensureForFilePaths',
          {
            filePaths: batch
          }
        )
        if (jobId.value !== current) return
        const extracted = typeof ensureRes?.extracted === 'number' ? ensureRes.extracted : 0
        debugSelection('[selection] 补齐特征：完成', {
          jobId: current,
          index: i,
          extracted,
          affected: typeof ensureRes?.affected === 'number' ? ensureRes.affected : null,
          ms: Date.now() - batchStartedAt
        })
        if (extracted > 0) {
          await predictOnce()
        }
      }
    } finally {
      if (jobId.value === current) {
        predicting.value = false
        const sorted = columnData.value.find((c) => c.order)
        if (sorted?.key === 'selectionScore' || sorted?.key === 'selectionLabel') {
          applyFiltersAndSorting()
        }
      }
    }
  }

  const refreshSelectionScoresForCurrentList = async () => {
    const paths = runtime.songsArea.songInfoArr.map((s) => s.filePath)
    await refreshSelectionScoresForFilePaths(paths)
  }

  const onAutoTrainStatus = (_e: any, payload: any) => {
    debugSelection('[selection] 自动训练状态事件', payload)
    if (payload?.status === 'trained') {
      void refreshSelectionScoresForCurrentList()
      return
    }
    if (payload?.status === 'reset') {
      jobId.value += 1
      predicting.value = false
      clearSelectionScores()
      const sorted = columnData.value.find((c) => c.order)
      if (sorted?.key === 'selectionScore' || sorted?.key === 'selectionLabel') {
        applyFiltersAndSorting()
      }
    }
  }

  onMounted(() => {
    window.electron.ipcRenderer.on('selection:autoTrainStatus', onAutoTrainStatus)
  })

  onUnmounted(() => {
    try {
      window.electron.ipcRenderer.removeListener('selection:autoTrainStatus', onAutoTrainStatus)
    } catch {}
  })

  watch(
    () => runtime.songsArea.songListUUID,
    () => {
      jobId.value += 1
      predicting.value = false
      clearSelectionScores()
    }
  )

  return {
    predicting,
    clearSelectionScores,
    refreshSelectionScoresForFilePaths,
    refreshSelectionScoresForCurrentList
  }
}
