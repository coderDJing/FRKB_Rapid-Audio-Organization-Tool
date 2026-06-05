export const createHorizontalBrowseCompactVisualWaveformWorker = () =>
  new Worker(new URL('./horizontalBrowseCompactVisualWaveform.worker.ts', import.meta.url), {
    type: 'module'
  })
