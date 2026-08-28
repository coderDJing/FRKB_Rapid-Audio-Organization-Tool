import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAYER_GLOBAL_SHORTCUTS,
  SEEK_PERCENT_KEY_BINDINGS,
  buildSeekPercentAccelerators,
  formatSeekPercentModifierSettingValue,
  normalizePlayerGlobalShortcutPayload,
  normalizeSeekPercentModifier,
  parseSeekPercentModifierInput,
  sanitizePlayerGlobalShortcuts
} from './playerGlobalShortcuts'

describe('normalizeSeekPercentModifier', () => {
  it('将修饰键规范成 Ctrl、Alt、Shift 顺序', () => {
    expect(normalizeSeekPercentModifier('alt+shift')).toBe('Shift+Alt')
    expect(normalizeSeekPercentModifier('Shift+Ctrl+Alt')).toBe('Ctrl+Shift+Alt')
    expect(normalizeSeekPercentModifier('option')).toBe('Alt')
    expect(normalizeSeekPercentModifier('control')).toBe('Ctrl')
  })

  it('拒绝纯 Shift、Win/Command 以及带普通按键的组合', () => {
    expect(normalizeSeekPercentModifier('Shift')).toBe('')
    expect(normalizeSeekPercentModifier('Super+Alt')).toBe('')
    expect(normalizeSeekPercentModifier('Command+Alt')).toBe('')
    expect(normalizeSeekPercentModifier('Ctrl+Alt+1')).toBe('')
    expect(normalizeSeekPercentModifier('')).toBe('')
  })
})

describe('parseSeekPercentModifierInput', () => {
  it('空串表示关闭', () => {
    expect(parseSeekPercentModifierInput('')).toEqual({ ok: true, modifier: '' })
    expect(parseSeekPercentModifierInput('   ')).toEqual({ ok: true, modifier: '' })
  })

  it('合法前缀返回规范化结果，非法前缀失败', () => {
    expect(parseSeekPercentModifierInput('alt+shift')).toEqual({
      ok: true,
      modifier: 'Shift+Alt'
    })
    expect(parseSeekPercentModifierInput('Shift')).toEqual({ ok: false })
  })
})

describe('sanitizePlayerGlobalShortcuts', () => {
  it('缺字段时回退默认前缀，空串保持关闭', () => {
    expect(sanitizePlayerGlobalShortcuts(undefined).seekPercentModifier).toBe(
      DEFAULT_PLAYER_GLOBAL_SHORTCUTS.seekPercentModifier
    )
    expect(sanitizePlayerGlobalShortcuts({}).seekPercentModifier).toBe(
      DEFAULT_PLAYER_GLOBAL_SHORTCUTS.seekPercentModifier
    )
    expect(
      sanitizePlayerGlobalShortcuts({
        seekPercentModifier: ''
      }).seekPercentModifier
    ).toBe('')
  })

  it('非法前缀清洗成关闭，而不会复活成默认值', () => {
    expect(
      sanitizePlayerGlobalShortcuts({
        seekPercentModifier: 'Shift'
      }).seekPercentModifier
    ).toBe('')
    expect(
      sanitizePlayerGlobalShortcuts({
        seekPercentModifier: 'Super+Alt'
      }).seekPercentModifier
    ).toBe('')
  })

  it('5 个动作空值仍回退默认，不受快速定位字段影响', () => {
    const sanitized = sanitizePlayerGlobalShortcuts({
      togglePlayPause: '',
      seekPercentModifier: ''
    })
    expect(sanitized.togglePlayPause).toBe(DEFAULT_PLAYER_GLOBAL_SHORTCUTS.togglePlayPause)
    expect(sanitized.seekPercentModifier).toBe('')
  })
})

describe('buildSeekPercentAccelerators', () => {
  it('按前缀展开反引号、主键盘和小键盘数字', () => {
    const accelerators = buildSeekPercentAccelerators('Shift+Alt')
    expect(accelerators).toHaveLength(SEEK_PERCENT_KEY_BINDINGS.length)
    expect(accelerators[0]).toMatchObject({
      accelerator: 'Shift+Alt+`',
      percent: 0,
      key: '`',
      optional: true
    })
    expect(accelerators).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accelerator: 'Shift+Alt+3', percent: 0.3, key: '3' }),
        expect.objectContaining({ accelerator: 'Shift+Alt+0', percent: 1, key: '0' }),
        expect.objectContaining({ accelerator: 'Shift+Alt+num5', percent: 0.5, key: 'num5' }),
        expect.objectContaining({ accelerator: 'Shift+Alt+num0', percent: 1, key: 'num0' })
      ])
    )
  })

  it('空前缀不展开任何键', () => {
    expect(buildSeekPercentAccelerators('')).toEqual([])
    expect(buildSeekPercentAccelerators('Shift')).toEqual([])
  })
})

describe('formatSeekPercentModifierSettingValue', () => {
  it('展示前缀和固定键位范围', () => {
    expect(formatSeekPercentModifierSettingValue('alt+shift')).toBe('Shift+Alt + 1~0 / ~')
    expect(formatSeekPercentModifierSettingValue('')).toBe('')
  })
})

describe('normalizePlayerGlobalShortcutPayload', () => {
  it('兼容旧的纯 action 字符串，并接受带百分比的对象', () => {
    expect(normalizePlayerGlobalShortcutPayload('togglePlayPause')).toEqual({
      action: 'togglePlayPause'
    })
    expect(normalizePlayerGlobalShortcutPayload({ action: 'seekPercent', percent: 0.4 })).toEqual({
      action: 'seekPercent',
      percent: 0.4
    })
    expect(normalizePlayerGlobalShortcutPayload({ action: 'seekPercent' })).toBeNull()
    expect(normalizePlayerGlobalShortcutPayload('seekPercent')).toBeNull()
  })
})
