export type MiniPlayerTaskProgress = {
  visible: boolean
  /** 0–100；null 表示不确定进度 */
  percent: number | null
}

export type MiniPlayerTaskProgressInput = {
  visible: boolean
  percent: number | null
}

export const HIDDEN_MINI_PLAYER_TASK_PROGRESS: MiniPlayerTaskProgress = {
  visible: false,
  percent: null
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, Math.round(value)))

export const resolveTaskProgressPercent = (input: {
  noProgress?: boolean
  now: number
  total: number
}): number | null => {
  if (input.noProgress) return null
  const now = Number(input.now) || 0
  const total = Number(input.total) || 0
  if (!(total > 0)) return 0
  return clampPercent((now / total) * 100)
}

export const resolveMiniPlayerTaskProgress = (
  inputs: MiniPlayerTaskProgressInput[]
): MiniPlayerTaskProgress => {
  const visible = inputs.filter((item) => item.visible)
  if (visible.length === 0) return { ...HIDDEN_MINI_PLAYER_TASK_PROGRESS }
  const determinate = visible
    .map((item) => item.percent)
    .filter((percent): percent is number => percent !== null && Number.isFinite(percent))
    .map((percent) => clampPercent(percent))
  if (determinate.length === 0) {
    return { visible: true, percent: null }
  }
  return {
    visible: true,
    percent: Math.min(...determinate)
  }
}

export const cloneMiniPlayerTaskProgress = (
  value: MiniPlayerTaskProgress | null | undefined
): MiniPlayerTaskProgress => {
  if (!value?.visible) return { ...HIDDEN_MINI_PLAYER_TASK_PROGRESS }
  if (value.percent === null || !Number.isFinite(Number(value.percent))) {
    return { visible: true, percent: null }
  }
  return {
    visible: true,
    percent: clampPercent(Number(value.percent))
  }
}

export const isSameMiniPlayerTaskProgress = (
  left: MiniPlayerTaskProgress | null | undefined,
  right: MiniPlayerTaskProgress | null | undefined
) => {
  const a = cloneMiniPlayerTaskProgress(left)
  const b = cloneMiniPlayerTaskProgress(right)
  return a.visible === b.visible && a.percent === b.percent
}
