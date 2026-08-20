import type { UserGuideBeatId, UserGuideStepId } from '@shared/userGuide'

export const USER_GUIDE_TARGET_ATTR = 'data-user-guide-target'
export const USER_GUIDE_HOLE_RADIUS = 8

export type UserGuideHole = {
  x: number
  y: number
  w: number
  h: number
}

export const resolveUserGuideTargetIds = (
  step: UserGuideStepId,
  beat: UserGuideBeatId,
  _isRekordboxUser: boolean
): string[] => {
  if (step === 'browser') {
    switch (beat) {
      case 'browserSource':
        return ['songs-source', 'library-tree']
      case 'browserMode':
        return ['browse-mode']
      case 'browserLibraries':
      case 'browserLibraryMenu':
        return ['library-rail']
      case 'browserRekordboxUsb':
      case 'browserRekordboxUsbMenu':
        return ['rekordbox-library', 'usb-library']
      case 'browserTree':
      case 'browserTreeMenu':
        return ['library-tree']
      case 'browserPlayer':
        return ['song-player']
      default:
        return ['browse-mode']
    }
  }
  switch (step) {
    case 'songsSource':
      return ['songs-source', 'library-tree']
    case 'rekordboxUsb':
      return ['rekordbox-library', 'usb-library']
    case 'songsList':
      if (beat === 'songsListHeaderMenu') return ['songs-header']
      if (beat === 'songsListReorder') return ['songs-index-col', 'songs-header']
      return ['songs-list-body']
    case 'filterCurated':
      return ['filter-curated']
    case 'setLibrary':
      return ['set-library']
    case 'mixtapeLibrary':
      return ['mixtape-library']
    case 'recordingLibrary':
      return ['recording-library']
    case 'horizontal':
      if (beat === 'horizontalWaveforms') return ['horizontal-waveforms']
      if (beat === 'horizontalTransport') return ['horizontal-transport']
      if (beat === 'horizontalLink') return ['horizontal-link']
      if (beat === 'horizontalBeatSync') return ['horizontal-beat-sync']
      if (beat === 'horizontalTools') return ['horizontal-tools']
      if (beat === 'horizontalCues') return ['horizontal-cues']
      if (beat === 'horizontalRecording') return ['horizontal-recording']
      return ['horizontal-decks']
    case 'edit':
      if (beat === 'editGrid') return ['edit-grid', 'horizontal-tools']
      return ['horizontal-decks', 'browse-mode']
    case 'mixtapeWindow':
      if (beat === 'mixtapeParams') return ['mixtape-params']
      if (beat === 'mixtapeBpm') return ['mixtape-bpm']
      if (beat === 'mixtapeStem') return ['mixtape-stem']
      return ['mixtape-timeline']
    default:
      return []
  }
}

const CLUSTER_GAP = 28

const unionHole = (left: UserGuideHole, right: UserGuideHole): UserGuideHole => {
  const x = Math.min(left.x, right.x)
  const y = Math.min(left.y, right.y)
  return {
    x,
    y,
    w: Math.max(left.x + left.w, right.x + right.w) - x,
    h: Math.max(left.y + left.h, right.y + right.h) - y
  }
}

const isVisibleRect = (rect: DOMRect) => rect.width >= 2 && rect.height >= 2

const holesNear = (left: UserGuideHole, right: UserGuideHole) => {
  return (
    left.x - CLUSTER_GAP < right.x + right.w &&
    left.x + left.w + CLUSTER_GAP > right.x &&
    left.y - CLUSTER_GAP < right.y + right.h &&
    left.y + left.h + CLUSTER_GAP > right.y
  )
}

const clusterHoles = (holes: UserGuideHole[]): UserGuideHole[] => {
  const used = new Set<number>()
  const clusters: UserGuideHole[] = []
  for (let index = 0; index < holes.length; index += 1) {
    if (used.has(index)) continue
    const start = holes[index]
    if (!start) continue
    let cluster = start
    used.add(index)
    let grew = true
    while (grew) {
      grew = false
      for (let nextIndex = 0; nextIndex < holes.length; nextIndex += 1) {
        if (used.has(nextIndex)) continue
        const candidate = holes[nextIndex]
        if (!candidate || !holesNear(cluster, candidate)) continue
        cluster = unionHole(cluster, candidate)
        used.add(nextIndex)
        grew = true
      }
    }
    clusters.push(cluster)
  }
  return clusters
}

const collectTargetHoles = (targetId: string): UserGuideHole[] => {
  const holes: UserGuideHole[] = []
  const nodes = document.querySelectorAll(`[${USER_GUIDE_TARGET_ATTR}="${targetId}"]`)
  nodes.forEach((node) => {
    if (!(node instanceof HTMLElement)) return
    const style = window.getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return
    const rect = node.getBoundingClientRect()
    if (!isVisibleRect(rect)) return
    holes.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })
  })
  return holes
}

const pickTargetHole = (holes: UserGuideHole[]): UserGuideHole | null => {
  if (holes.length === 0) return null
  const clusters = clusterHoles(holes)
  clusters.sort((left, right) => right.w * right.h - left.w * left.h)
  return clusters[0] || null
}

export const USER_GUIDE_HOLE_WAIT_MS = 1600

export const measureUserGuideHole = (
  step: UserGuideStepId,
  beat: UserGuideBeatId,
  isRekordboxUser: boolean
): UserGuideHole | null => {
  const targetIds = resolveUserGuideTargetIds(step, beat, isRekordboxUser)
  const unionRekordboxUsb =
    step === 'rekordboxUsb' ||
    (step === 'browser' && (beat === 'browserRekordboxUsb' || beat === 'browserRekordboxUsbMenu'))
  if (unionRekordboxUsb) {
    const holes = targetIds.flatMap((targetId) => collectTargetHoles(targetId))
    if (holes.length === 0) return null
    return holes.reduce(unionHole)
  }
  // 区域再大也框选当前目标，不改去框更小的其它控件
  for (const targetId of targetIds) {
    const hole = pickTargetHole(collectTargetHoles(targetId))
    if (hole) return hole
  }
  return null
}

export const waitForUserGuideHole = (
  step: UserGuideStepId,
  beat: UserGuideBeatId,
  isRekordboxUser: boolean,
  options?: {
    timeoutMs?: number
    shouldContinue?: () => boolean
  }
): Promise<UserGuideHole | null> => {
  const timeoutMs = options?.timeoutMs ?? USER_GUIDE_HOLE_WAIT_MS
  const started = performance.now()
  return new Promise((resolve) => {
    const tick = () => {
      if (options?.shouldContinue && !options.shouldContinue()) {
        resolve(null)
        return
      }
      const hole = measureUserGuideHole(step, beat, isRekordboxUser)
      if (hole) {
        resolve(hole)
        return
      }
      if (performance.now() - started >= timeoutMs) {
        resolve(null)
        return
      }
      requestAnimationFrame(tick)
    }
    tick()
  })
}

const roundedRectPath = (x: number, y: number, w: number, h: number, radius: number) => {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  const right = x + w
  const bottom = y + h
  if (r <= 0.5) {
    return `M${x} ${y}H${right}V${bottom}H${x}Z`
  }
  return [
    `M${x + r} ${y}`,
    `H${right - r}`,
    `A${r} ${r} 0 0 1 ${right} ${y + r}`,
    `V${bottom - r}`,
    `A${r} ${r} 0 0 1 ${right - r} ${bottom}`,
    `H${x + r}`,
    `A${r} ${r} 0 0 1 ${x} ${bottom - r}`,
    `V${y + r}`,
    `A${r} ${r} 0 0 1 ${x + r} ${y}`,
    'Z'
  ].join('')
}

export const buildUserGuideMaskPath = (
  viewW: number,
  viewH: number,
  hole: UserGuideHole | null,
  radius = USER_GUIDE_HOLE_RADIUS
): string => {
  const outer = `M0 0H${viewW}V${viewH}H0Z`
  if (!hole || hole.w < 2 || hole.h < 2) return outer
  return `${outer}${roundedRectPath(hole.x, hole.y, hole.w, hole.h, radius)}`
}
