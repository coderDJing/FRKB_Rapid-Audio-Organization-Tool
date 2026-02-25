import { computed } from 'vue'

export const createTimelineViewportModule = (ctx: any) => {
  const {
    timelineViewportWidth,
    overviewWidth,
    timelineScrollWidth,
    timelineContentWidth,
    timelineLayout,
    timelineScrollLeft,
    preRenderState
  } = ctx

  const overviewViewportMetrics = computed(() => {
    const viewportWidth = Math.max(0, timelineViewportWidth.value)
    const overviewTotalWidth = Math.max(0, overviewWidth.value)
    const domScrollWidth = Number(timelineScrollWidth.value) || 0
    const fallbackScrollWidth = Math.max(
      1,
      Number(timelineContentWidth.value) || 0,
      Number(timelineLayout.value.totalWidth) || 0
    )
    const scrollTotalWidth = Math.max(1, domScrollWidth > 0 ? domScrollWidth : fallbackScrollWidth)
    if (!overviewTotalWidth || !viewportWidth) {
      return { left: 0, width: 0 }
    }
    const widthRatio = overviewTotalWidth / scrollTotalWidth
    const rawWidth = viewportWidth * widthRatio
    const width = Math.min(overviewTotalWidth, Math.max(0, rawWidth))
    const maxLeft = Math.max(0, overviewTotalWidth - width)
    const maxScrollLeft = Math.max(0, scrollTotalWidth - viewportWidth)
    const safeScrollLeft = Math.max(
      0,
      Math.min(maxScrollLeft, Number(timelineScrollLeft.value) || 0)
    )
    const scrollRatio =
      maxScrollLeft > 0 ? Math.max(0, Math.min(1, safeScrollLeft / maxScrollLeft)) : 0
    const left = maxLeft * scrollRatio
    return { left, width }
  })
  const overviewViewportLeft = computed(() => overviewViewportMetrics.value.left)
  const overviewViewportWidth = computed(() => overviewViewportMetrics.value.width)
  const overviewViewportStyle = computed(() => ({
    left: `${overviewViewportMetrics.value.left}px`,
    width: `${overviewViewportMetrics.value.width}px`
  }))
  const timelineScrollbarOptions = {
    scrollbars: {
      autoHide: 'leave' as const,
      autoHideDelay: 50,
      clickScroll: true
    },
    overflow: {
      x: 'scroll',
      y: 'scroll'
    } as const
  }
  const preRenderPercent = computed(() => {
    const total = preRenderState.value.total
    const done = preRenderState.value.done
    if (!total || total <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
  })

  return {
    overviewViewportMetrics,
    overviewViewportLeft,
    overviewViewportWidth,
    overviewViewportStyle,
    timelineScrollbarOptions,
    preRenderPercent
  }
}
