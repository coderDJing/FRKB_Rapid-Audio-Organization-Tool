import { screen, type BrowserWindow, type Rectangle } from 'electron'

export type PopupAnchor = {
  x: number
  y: number
  width: number
  height: number
}

export const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

export const resolveWorkAreaNear = (point: { x: number; y: number }): Rectangle =>
  screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea

export const resolveAnchoredPopupBounds = (
  anchor: PopupAnchor,
  size: { width: number; height: number },
  gap = 2
): Rectangle => {
  const workArea = resolveWorkAreaNear({ x: anchor.x, y: anchor.y })
  const width = Math.max(1, Math.round(size.width))
  const height = Math.max(1, Math.round(size.height))
  const spaceBelow = workArea.y + workArea.height - (anchor.y + anchor.height)
  const spaceAbove = anchor.y - workArea.y
  const belowY = anchor.y + anchor.height + gap
  const aboveY = anchor.y - height - gap
  const canBelow = belowY + height <= workArea.y + workArea.height
  const canAbove = aboveY >= workArea.y
  const preferBelow = spaceBelow >= spaceAbove
  let y = preferBelow ? belowY : aboveY
  if (preferBelow && canBelow) {
    y = belowY
  } else if (!preferBelow && canAbove) {
    y = aboveY
  } else if (canBelow) {
    y = belowY
  } else if (canAbove) {
    y = aboveY
  }
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height
  return {
    x: Math.round(clampNumber(anchor.x, workArea.x, Math.max(workArea.x, maxX))),
    y: Math.round(clampNumber(y, workArea.y, Math.max(workArea.y, maxY))),
    width,
    height
  }
}

export const toScreenAnchor = (
  contentBounds: Rectangle,
  localAnchor: PopupAnchor
): PopupAnchor => ({
  x: contentBounds.x + localAnchor.x,
  y: contentBounds.y + localAnchor.y,
  width: localAnchor.width,
  height: localAnchor.height
})

export const resolveContentBoundsForMove = (
  currentBounds: Rectangle,
  currentContent: Rectangle,
  nextWindowBounds: Rectangle
): Rectangle => ({
  x: nextWindowBounds.x + (currentContent.x - currentBounds.x),
  y: nextWindowBounds.y + (currentContent.y - currentBounds.y),
  width: currentContent.width,
  height: currentContent.height
})

export const applyExactContentBounds = (target: BrowserWindow, bounds: Rectangle) => {
  const desired = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  }
  try {
    target.setContentBounds(desired)
  } catch {
    target.setBounds(desired)
  }
  const actual = target.getContentBounds()
  const extraWidth = desired.width - actual.width
  const extraHeight = desired.height - actual.height
  if (Math.abs(extraWidth) < 1 && Math.abs(extraHeight) < 1) return
  const corrected = {
    x: desired.x,
    y: desired.y,
    width: Math.max(1, desired.width + extraWidth),
    height: Math.max(1, desired.height + extraHeight)
  }
  try {
    target.setContentBounds(corrected)
  } catch {
    target.setBounds(corrected)
  }
}
