let tipEl: HTMLDivElement | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let lastShowAt = 0

const ensureTipEl = () => {
  if (tipEl) return tipEl
  const el = document.createElement('div')
  el.className = 'frkb-near-mouse-tip'
  el.style.position = 'fixed'
  el.style.zIndex = '99999'
  el.style.pointerEvents = 'none'
  el.style.padding = '4px 8px'
  el.style.borderRadius = '3px'
  el.style.border = '1px solid var(--border)'
  el.style.background = 'var(--bg-elev)'
  el.style.color = 'var(--text)'
  el.style.fontSize = '12px'
  el.style.lineHeight = '1.3'
  el.style.maxWidth = '260px'
  el.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.25)'
  el.style.opacity = '0'
  el.style.transition = 'opacity 120ms ease'
  document.body.appendChild(el)
  tipEl = el
  return el
}

export const showNearMouseTip = (clientX: number, clientY: number, text: string) => {
  const message = String(text || '').trim()
  if (!message) return
  const now = Date.now()
  if (now - lastShowAt < 900) return
  lastShowAt = now
  const el = ensureTipEl()
  el.textContent = message

  const offset = 12
  const maxLeft = Math.max(8, window.innerWidth - 268)
  const maxTop = Math.max(8, window.innerHeight - 48)
  const left = Math.min(maxLeft, Math.max(8, clientX + offset))
  const top = Math.min(maxTop, Math.max(8, clientY + offset))
  el.style.left = `${left}px`
  el.style.top = `${top}px`
  el.style.opacity = '1'

  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (!tipEl) return
    tipEl.style.opacity = '0'
    hideTimer = setTimeout(() => {
      if (tipEl) {
        tipEl.remove()
        tipEl = null
      }
      hideTimer = null
    }, 140)
  }, 1600)
}
