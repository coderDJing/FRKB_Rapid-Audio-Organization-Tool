import { onMounted, onUnmounted } from 'vue'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import { useRuntimeStore } from '@renderer/stores/runtime'

const WINDOW_GLOBAL_SCOPE = 'windowGlobal'
const CROSSFADER_KEY_REPEAT_DELAY_MS = 180
const CROSSFADER_KEY_REPEAT_INTERVAL_MS = 80

type CrossfaderDirection = -1 | 0 | 1

type UseHorizontalBrowseHotkeysParams = {
  runtime: ReturnType<typeof useRuntimeStore>
  onTogglePlayPause: (deck: HorizontalBrowseDeckKey) => void
  onCueKeyDown: (deck: HorizontalBrowseDeckKey) => boolean
  onCueKeyUp: (deck: HorizontalBrowseDeckKey) => void
  onJumpBar: (deck: HorizontalBrowseDeckKey, direction: -1 | 1) => void
  onJumpPhrase: (deck: HorizontalBrowseDeckKey, direction: -1 | 1) => void
  onMoveToFilter: (deck: HorizontalBrowseDeckKey) => void
  onMoveToCurated: (deck: HorizontalBrowseDeckKey) => void
  onDelete: (deck: HorizontalBrowseDeckKey) => void
  onSeekPercent: (deck: HorizontalBrowseDeckKey, percent: number) => void
  onNudgeCrossfader: (direction: -1 | 1) => void
  onResetCrossfader: () => void
}

const isEditableTarget = (target: EventTarget | null) => {
  const element = target instanceof HTMLElement ? target : null
  if (!element) return false
  if (element.isContentEditable) return true
  return Boolean(
    element.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]'
    )
  )
}

const stopKeyboardEvent = (event: KeyboardEvent) => {
  event.preventDefault()
  event.stopPropagation()
}

const resolvePercentByCode = (code: string) => {
  if (code === 'Backquote') return 0
  if (code === 'Digit0') return 1
  const matchedDigit = /^Digit([1-9])$/.exec(code)
  if (!matchedDigit) return null
  return Number(matchedDigit[1]) / 10
}

const isHorizontalBrowsePhraseJumpHotkey = (event: KeyboardEvent) =>
  event.altKey && (event.code === 'KeyA' || event.code === 'KeyD')

export const useHorizontalBrowseHotkeys = (params: UseHorizontalBrowseHotkeysParams) => {
  const activeCueDeckByCode = new Map<string, HorizontalBrowseDeckKey>()
  const activeCrossfaderKeys = new Set<string>()
  let crossfaderDirection: CrossfaderDirection = 0
  let crossfaderRepeatTimer: ReturnType<typeof setTimeout> | null = null

  const resolveCurrentScope = () =>
    params.runtime.hotkeysScopesHeap[params.runtime.hotkeysScopesHeap.length - 1] || ''

  const isHotkeysContextActive = (event: KeyboardEvent) => {
    if (params.runtime.mainWindowBrowseMode !== 'horizontal') return false
    if (resolveCurrentScope() !== WINDOW_GLOBAL_SCOPE) return false
    if (isEditableTarget(event.target)) return false
    if (event.ctrlKey || event.metaKey) return false
    if (event.altKey && !isHorizontalBrowsePhraseJumpHotkey(event)) return false
    return true
  }

  const clearCrossfaderRepeatTimer = () => {
    if (!crossfaderRepeatTimer) return
    clearTimeout(crossfaderRepeatTimer)
    crossfaderRepeatTimer = null
  }

  const clearCrossfaderKeyState = () => {
    activeCrossfaderKeys.clear()
    crossfaderDirection = 0
    clearCrossfaderRepeatTimer()
  }

  const resolveCrossfaderDirection = (): CrossfaderDirection => {
    const upActive = activeCrossfaderKeys.has('KeyW') || activeCrossfaderKeys.has('ArrowUp')
    const downActive = activeCrossfaderKeys.has('KeyS') || activeCrossfaderKeys.has('ArrowDown')
    if (upActive === downActive) return 0
    return upActive ? 1 : -1
  }

  const scheduleCrossfaderRepeat = () => {
    clearCrossfaderRepeatTimer()
    if (crossfaderDirection === 0) return
    crossfaderRepeatTimer = setTimeout(function repeat() {
      if (crossfaderDirection === 0) return
      if (resolveCurrentScope() !== WINDOW_GLOBAL_SCOPE) {
        clearCrossfaderKeyState()
        return
      }
      params.onNudgeCrossfader(crossfaderDirection)
      crossfaderRepeatTimer = setTimeout(repeat, CROSSFADER_KEY_REPEAT_INTERVAL_MS)
    }, CROSSFADER_KEY_REPEAT_DELAY_MS)
  }

  const syncCrossfaderRepeat = (applyImmediateStep: boolean) => {
    const nextDirection = resolveCrossfaderDirection()
    if (nextDirection === crossfaderDirection) return
    clearCrossfaderRepeatTimer()
    crossfaderDirection = nextDirection
    if (nextDirection === 0) return
    if (applyImmediateStep) {
      params.onNudgeCrossfader(nextDirection)
    }
    scheduleCrossfaderRepeat()
  }

  const stopAllKeyboardCuePreview = () => {
    for (const deck of activeCueDeckByCode.values()) {
      params.onCueKeyUp(deck)
    }
    activeCueDeckByCode.clear()
  }

  const resolveDeckByShiftState = (event: KeyboardEvent): HorizontalBrowseDeckKey =>
    event.shiftKey ? 'bottom' : 'top'

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isHotkeysContextActive(event)) return

    const code = event.code
    const deck = resolveDeckByShiftState(event)

    if (isHorizontalBrowsePhraseJumpHotkey(event)) {
      stopKeyboardEvent(event)
      if (event.repeat) return
      params.onJumpPhrase(deck, code === 'KeyA' ? -1 : 1)
      return
    }

    if (code === 'Space') {
      stopKeyboardEvent(event)
      if (event.repeat) return
      params.onTogglePlayPause(deck)
      return
    }

    if (code === 'KeyC') {
      stopKeyboardEvent(event)
      if (event.repeat || activeCueDeckByCode.has(code)) return
      if (params.onCueKeyDown(deck)) {
        activeCueDeckByCode.set(code, deck)
      }
      return
    }

    if (code === 'KeyA' || code === 'ArrowLeft') {
      stopKeyboardEvent(event)
      if (event.repeat) return
      params.onJumpBar(deck, -1)
      return
    }

    if (code === 'KeyD' || code === 'ArrowRight') {
      stopKeyboardEvent(event)
      if (event.repeat) return
      params.onJumpBar(deck, 1)
      return
    }

    if (code === 'KeyW' || code === 'ArrowUp') {
      stopKeyboardEvent(event)
      if (event.shiftKey) {
        clearCrossfaderKeyState()
        if (event.repeat) return
        params.onResetCrossfader()
        return
      }
      if (activeCrossfaderKeys.has(code)) return
      activeCrossfaderKeys.add(code)
      syncCrossfaderRepeat(true)
      return
    }

    if (code === 'KeyS' || code === 'ArrowDown') {
      stopKeyboardEvent(event)
      if (event.shiftKey) {
        clearCrossfaderKeyState()
        if (event.repeat) return
        params.onResetCrossfader()
        return
      }
      if (activeCrossfaderKeys.has(code)) return
      activeCrossfaderKeys.add(code)
      syncCrossfaderRepeat(true)
      return
    }

    if (code === 'KeyQ') {
      stopKeyboardEvent(event)
      if (event.repeat) return
      params.onMoveToFilter(deck)
      return
    }

    if (code === 'KeyE') {
      stopKeyboardEvent(event)
      if (event.repeat) return
      params.onMoveToCurated(deck)
      return
    }

    if (code === 'KeyF') {
      stopKeyboardEvent(event)
      if (event.repeat) return
      params.onDelete(deck)
      return
    }

    const percent = resolvePercentByCode(code)
    if (percent === null) return
    stopKeyboardEvent(event)
    if (event.repeat) return
    params.onSeekPercent(deck, percent)
  }

  const handleKeyUp = (event: KeyboardEvent) => {
    const code = event.code

    if (code === 'KeyC') {
      const deck = activeCueDeckByCode.get(code)
      if (!deck) return
      activeCueDeckByCode.delete(code)
      params.onCueKeyUp(deck)
      return
    }

    if (!activeCrossfaderKeys.has(code)) return
    activeCrossfaderKeys.delete(code)
    syncCrossfaderRepeat(true)
  }

  const handleWindowBlur = () => {
    stopAllKeyboardCuePreview()
    clearCrossfaderKeyState()
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', handleWindowBlur)
  })

  onUnmounted(() => {
    handleWindowBlur()
    window.removeEventListener('keydown', handleKeyDown, true)
    window.removeEventListener('keyup', handleKeyUp, true)
    window.removeEventListener('blur', handleWindowBlur)
  })
}
