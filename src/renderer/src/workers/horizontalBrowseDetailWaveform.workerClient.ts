export const createHorizontalBrowseDetailWaveformWorker = () =>
  new Worker(new URL('./horizontalBrowseDetailWaveform.worker.ts', import.meta.url), {
    type: 'module'
  })
