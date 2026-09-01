import { onBeforeUnmount, watch, type ComputedRef, type Ref } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import {
  HIDDEN_MINI_PLAYER_TASK_PROGRESS,
  isSameMiniPlayerTaskProgress,
  resolveMiniPlayerTaskProgress,
  resolveTaskProgressPercent,
  type MiniPlayerTaskProgressInput
} from '@shared/miniPlayerTaskProgress'

type BottomInfoTaskLike = {
  noProgress?: boolean
  now: number
  total: number
}

const toVisibleInput = (visible: boolean, percent: number): MiniPlayerTaskProgressInput => ({
  visible,
  percent: visible ? percent : null
})

export function useBottomInfoTaskProgressMirror(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  analysisRuntimeVisible: ComputedRef<boolean>
  analysisRuntimePercent: ComputedRef<number>
  cloudSyncVisible: ComputedRef<boolean>
  cloudSyncPercent: ComputedRef<number>
  libraryStemVisible: ComputedRef<boolean>
  libraryStemPercent: ComputedRef<number>
  tasks: Ref<BottomInfoTaskLike[]>
}) {
  const publish = () => {
    const next = resolveMiniPlayerTaskProgress([
      toVisibleInput(params.analysisRuntimeVisible.value, params.analysisRuntimePercent.value),
      toVisibleInput(params.cloudSyncVisible.value, params.cloudSyncPercent.value),
      toVisibleInput(params.libraryStemVisible.value, params.libraryStemPercent.value),
      ...params.tasks.value.map((task) => ({
        visible: true,
        percent: resolveTaskProgressPercent(task)
      }))
    ])
    if (isSameMiniPlayerTaskProgress(params.runtime.bottomInfoTaskProgress, next)) return
    params.runtime.bottomInfoTaskProgress = next
  }

  watch(
    [
      params.analysisRuntimeVisible,
      params.analysisRuntimePercent,
      params.cloudSyncVisible,
      params.cloudSyncPercent,
      params.libraryStemVisible,
      params.libraryStemPercent,
      params.tasks
    ],
    publish,
    { deep: true, immediate: true }
  )

  onBeforeUnmount(() => {
    params.runtime.bottomInfoTaskProgress = { ...HIDDEN_MINI_PLAYER_TASK_PROGRESS }
  })
}
