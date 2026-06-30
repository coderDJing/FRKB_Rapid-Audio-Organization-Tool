export type HorizontalBrowseWaveformThemeVariant = 'light' | 'dark'

export const resolveHorizontalBrowseWaveformThemeVariant =
  (): HorizontalBrowseWaveformThemeVariant => {
    const htmlEl = document.documentElement
    const bodyEl = document.body
    if (htmlEl?.classList.contains('theme-light') || bodyEl?.classList.contains('theme-light')) {
      return 'light'
    }
    return 'dark'
  }
