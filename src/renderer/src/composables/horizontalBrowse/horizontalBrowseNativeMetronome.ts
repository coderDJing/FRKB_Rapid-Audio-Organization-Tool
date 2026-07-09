export const createHorizontalBrowseNativeMetronomeSync =
  (resolveDirection: () => 'up' | 'down') =>
  (state: { enabled: boolean; volumeLevel: 1 | 2 | 3 }) => {
    const deck = resolveDirection() === 'up' ? 'top' : 'bottom'
    void window.electron.ipcRenderer
      .invoke('horizontal-browse-transport:set-metronome', deck, state.enabled, state.volumeLevel)
      .catch((error) => {
        console.error('[horizontal-browse-metronome] sync native state failed', error)
      })
  }
