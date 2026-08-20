import { nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties, type Ref } from 'vue'
import type { UserGuideBeatId, UserGuideStepId } from '@shared/userGuide'
import {
  buildUserGuideMaskPath,
  measureUserGuideHole,
  USER_GUIDE_HOLE_RADIUS,
  USER_GUIDE_HOLE_WAIT_MS,
  type UserGuideHole
} from '@renderer/composables/userGuideTargets'

export type UserGuideArrowSide = 'left' | 'right' | 'top' | 'bottom' | 'none'

type PanelStyle = CSSProperties & {
  '--user-guide-arrow-offset'?: string
}

const HOLE_PAD = 6
const LARGE_HOLE_PAD = 2
const LARGE_HOLE_AREA_RATIO = 0.28
const VIEW_EDGE = 3
const PANEL_WIDTH = 360
const PANEL_GAP = 14
const VIEW_PAD = 16
const ARROW_MIN = 18

const isLargeHole = (hole: UserGuideHole) =>
  hole.w * hole.h > window.innerWidth * window.innerHeight * LARGE_HOLE_AREA_RATIO

const expandHole = (hole: UserGuideHole): UserGuideHole => {
  const pad = isLargeHole(hole) ? LARGE_HOLE_PAD : HOLE_PAD
  const x = Math.max(VIEW_EDGE, hole.x - pad)
  const y = Math.max(VIEW_EDGE, hole.y - pad)
  const right = Math.min(window.innerWidth - VIEW_EDGE, hole.x + hole.w + pad)
  const bottom = Math.min(window.innerHeight - VIEW_EDGE, hole.y + hole.h + pad)
  return {
    x,
    y,
    w: Math.max(0, right - x),
    h: Math.max(0, bottom - y)
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const roundPx = (value: number) => Math.round(value)

export const useUserGuideSpotlight = (
  step: Ref<UserGuideStepId>,
  beat: Ref<UserGuideBeatId>,
  isRekordboxUser: Ref<boolean>,
  panelEl: Ref<HTMLElement | null>
) => {
  const hole = ref<UserGuideHole | null>(null)
  const panelStyle = ref<PanelStyle>({})
  const arrowSide = ref<UserGuideArrowSide>('none')
  const viewWidth = ref(window.innerWidth)
  const viewHeight = ref(window.innerHeight)
  const maskPath = ref(buildUserGuideMaskPath(window.innerWidth, window.innerHeight, null))
  const retriesExhausted = ref(false)
  let panelObserver: ResizeObserver | null = null
  let retryRaf = 0
  let retryUntil = 0

  const layoutPanel = (nextHole: UserGuideHole | null) => {
    const width = window.innerWidth
    const height = window.innerHeight
    const panelHeight = Math.max(panelEl.value?.offsetHeight || 220, 160)
    const maxLeft = Math.max(VIEW_PAD, width - PANEL_WIDTH - VIEW_PAD)
    const maxTop = Math.max(VIEW_PAD, height - panelHeight - VIEW_PAD)
    const assignStyle = (left: number, top: number, offset: number) => {
      panelStyle.value = {
        left: `${roundPx(left)}px`,
        top: `${roundPx(top)}px`,
        '--user-guide-arrow-offset': `${roundPx(offset)}px`
      }
    }

    if (!nextHole) {
      arrowSide.value = 'none'
      assignStyle((width - PANEL_WIDTH) / 2, (height - panelHeight) / 2, ARROW_MIN)
      return
    }

    const rightSpace = width - (nextHole.x + nextHole.w) - VIEW_PAD
    const leftSpace = nextHole.x - VIEW_PAD
    const bottomSpace = height - (nextHole.y + nextHole.h) - VIEW_PAD
    const topSpace = nextHole.y - VIEW_PAD
    const holeCenterX = nextHole.x + nextHole.w / 2
    const holeCenterY = nextHole.y + nextHole.h / 2
    const verticalArrowMax = Math.max(ARROW_MIN, panelHeight - ARROW_MIN)
    const horizontalArrowMax = Math.max(ARROW_MIN, PANEL_WIDTH - ARROW_MIN)
    const placeRight = () => {
      const top = clamp(nextHole.y, VIEW_PAD, maxTop)
      arrowSide.value = 'left'
      assignStyle(
        clamp(nextHole.x + nextHole.w + PANEL_GAP, VIEW_PAD, maxLeft),
        top,
        clamp(holeCenterY - top, ARROW_MIN, verticalArrowMax)
      )
    }
    const placeLeft = () => {
      const top = clamp(nextHole.y + (isLargeHole(nextHole) ? 20 : 0), VIEW_PAD, maxTop)
      arrowSide.value = 'right'
      assignStyle(
        clamp(nextHole.x - PANEL_GAP - PANEL_WIDTH, VIEW_PAD, maxLeft),
        top,
        clamp(holeCenterY - top, ARROW_MIN, verticalArrowMax)
      )
    }
    const placeBottom = () => {
      const left = clamp(nextHole.x, VIEW_PAD, maxLeft)
      arrowSide.value = 'top'
      assignStyle(
        left,
        clamp(nextHole.y + nextHole.h + PANEL_GAP, VIEW_PAD, maxTop),
        clamp(holeCenterX - left, ARROW_MIN, horizontalArrowMax)
      )
    }
    const placeTop = () => {
      const left = clamp(nextHole.x, VIEW_PAD, maxLeft)
      arrowSide.value = 'bottom'
      assignStyle(
        left,
        clamp(nextHole.y - PANEL_GAP - panelHeight, VIEW_PAD, maxTop),
        clamp(holeCenterX - left, ARROW_MIN, horizontalArrowMax)
      )
    }
    type SideKey = 'right' | 'left' | 'bottom' | 'top'
    const sides: Array<{ key: SideKey; space: number; needed: number; place: () => void }> = [
      { key: 'right', space: rightSpace, needed: PANEL_WIDTH + PANEL_GAP, place: placeRight },
      { key: 'left', space: leftSpace, needed: PANEL_WIDTH + PANEL_GAP, place: placeLeft },
      { key: 'bottom', space: bottomSpace, needed: panelHeight + PANEL_GAP, place: placeBottom },
      { key: 'top', space: topSpace, needed: panelHeight + PANEL_GAP, place: placeTop }
    ]
    const preferred: SideKey[] = isLargeHole(nextHole)
      ? ['left', 'bottom', 'top', 'right']
      : ['right', 'left', 'bottom', 'top']
    const fitting = sides.filter((side) => side.space >= side.needed)
    if (fitting.length > 0) {
      for (const key of preferred) {
        const hit = fitting.find((side) => side.key === key)
        if (hit) {
          hit.place()
          return
        }
      }
    }
    const fallback = [...sides].sort((left, right) => right.space - left.space)[0]
    fallback?.place()
  }

  const update = () => {
    viewWidth.value = window.innerWidth
    viewHeight.value = window.innerHeight
    const measured = measureUserGuideHole(step.value, beat.value, isRekordboxUser.value)
    hole.value = measured ? expandHole(measured) : null
    maskPath.value = buildUserGuideMaskPath(viewWidth.value, viewHeight.value, hole.value)
    layoutPanel(hole.value)
  }

  const stopRetry = () => {
    if (!retryRaf) return
    cancelAnimationFrame(retryRaf)
    retryRaf = 0
  }

  const scheduleRetryIfNeeded = () => {
    stopRetry()
    if (hole.value) {
      retriesExhausted.value = false
      return
    }
    if (performance.now() >= retryUntil) {
      retriesExhausted.value = true
      return
    }
    retryRaf = requestAnimationFrame(() => {
      retryRaf = 0
      update()
      scheduleRetryIfNeeded()
    })
  }

  const beginRetryWindow = () => {
    retriesExhausted.value = false
    retryUntil = performance.now() + USER_GUIDE_HOLE_WAIT_MS
    update()
    scheduleRetryIfNeeded()
  }

  const bindPanelObserver = (element: HTMLElement | null) => {
    panelObserver?.disconnect()
    panelObserver = null
    if (!element) return
    panelObserver = new ResizeObserver(() => {
      layoutPanel(hole.value)
    })
    panelObserver.observe(element)
  }

  onMounted(() => {
    beginRetryWindow()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    bindPanelObserver(panelEl.value)
  })

  onBeforeUnmount(() => {
    stopRetry()
    window.removeEventListener('resize', update)
    window.removeEventListener('scroll', update, true)
    panelObserver?.disconnect()
    panelObserver = null
  })

  watch([step, beat, isRekordboxUser], () => {
    beginRetryWindow()
    void nextTick(() => {
      update()
      scheduleRetryIfNeeded()
    })
  })

  watch(panelEl, (element) => {
    bindPanelObserver(element)
    update()
    scheduleRetryIfNeeded()
  })

  return {
    hole,
    retriesExhausted,
    panelStyle,
    arrowSide,
    panelWidth: PANEL_WIDTH,
    holeRadius: USER_GUIDE_HOLE_RADIUS,
    viewWidth,
    viewHeight,
    maskPath,
    update
  }
}
