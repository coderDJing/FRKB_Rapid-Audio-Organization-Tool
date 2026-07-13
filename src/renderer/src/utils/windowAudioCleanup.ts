export const stopWindowAudio = () => {
  document.querySelectorAll('audio').forEach((element) => {
    try {
      element.pause()
    } catch {}
  })
  try {
    const contexts = window.__FRKB_AUDIO_CONTEXTS__
    if (!contexts) return
    for (const context of contexts) {
      try {
        void context.suspend()
      } catch {}
    }
  } catch {}
}
