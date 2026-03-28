export interface SongsAreaScrollCarrierInfo {
  carrier: HTMLElement | null
  host: HTMLElement | null
  viewport: HTMLElement | null
  content: HTMLElement | null
  height: number
  top: number
  left: number
}

const isScrollable = (element: HTMLElement | null | undefined) => {
  if (!element) return false
  return element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1
}

const pushCandidate = (list: HTMLElement[], element: HTMLElement | null | undefined) => {
  if (!element || list.includes(element)) return
  list.push(element)
}

export function detectSongsAreaScrollCarrier(
  explicitElement?: HTMLElement | null,
  fallbackElement?: HTMLElement | null
): SongsAreaScrollCarrierInfo {
  const explicit = explicitElement instanceof HTMLElement ? explicitElement : null
  const fallback = fallbackElement instanceof HTMLElement ? fallbackElement : null
  const host =
    (explicit?.closest('.os-host') as HTMLElement | null) ||
    (fallback?.closest('.os-host') as HTMLElement | null) ||
    (explicit?.classList.contains('os-host') ? explicit : null) ||
    (fallback?.classList.contains('os-host') ? fallback : null) ||
    null
  const viewport =
    (explicit?.classList.contains('os-viewport') ? explicit : null) ||
    ((host?.querySelector('.os-viewport') as HTMLElement | null) ?? null)
  const content =
    (explicit?.classList.contains('os-content') ? explicit : null) ||
    ((host?.querySelector('.os-content') as HTMLElement | null) ?? null)
  const candidates: HTMLElement[] = []
  pushCandidate(candidates, explicit)
  pushCandidate(candidates, viewport)
  pushCandidate(candidates, content)
  pushCandidate(candidates, host)
  pushCandidate(candidates, fallback)

  const carrier = candidates.find((element) => isScrollable(element)) ?? candidates[0] ?? null

  return {
    carrier,
    host,
    viewport,
    content,
    height: carrier?.clientHeight || 0,
    top: carrier?.scrollTop || 0,
    left: carrier?.scrollLeft || 0
  }
}
