import { describe, expect, it } from 'vitest'
import { resolveSeekPercentHotkeyRatio } from './playerSeekHotkeyRatio'

const eventOf = (key: string, code: string) => ({ key, code })

describe('resolveSeekPercentHotkeyRatio', () => {
  it('maps backtick / tilde to the start', () => {
    expect(resolveSeekPercentHotkeyRatio(eventOf('`', 'Backquote'))).toBe(0)
    expect(resolveSeekPercentHotkeyRatio(eventOf('~', 'Backquote'))).toBe(0)
  })

  it('maps top-row digits to 10% steps', () => {
    expect(resolveSeekPercentHotkeyRatio(eventOf('1', 'Digit1'))).toBe(0.1)
    expect(resolveSeekPercentHotkeyRatio(eventOf('5', 'Digit5'))).toBe(0.5)
    expect(resolveSeekPercentHotkeyRatio(eventOf('0', 'Digit0'))).toBe(1)
  })

  it('maps numpad digits to the same 10% steps', () => {
    expect(resolveSeekPercentHotkeyRatio(eventOf('5', 'Numpad5'))).toBe(0.5)
    expect(resolveSeekPercentHotkeyRatio(eventOf('0', 'Numpad0'))).toBe(1)
  })

  it('falls back to the hotkeys-js handler key', () => {
    expect(resolveSeekPercentHotkeyRatio(eventOf('', ''), '7')).toBe(0.7)
    expect(resolveSeekPercentHotkeyRatio(eventOf('', ''), '`')).toBe(0)
  })

  it('returns null when the key is not a seek shortcut', () => {
    expect(resolveSeekPercentHotkeyRatio(eventOf('a', 'KeyA'), 'a')).toBeNull()
  })
})
