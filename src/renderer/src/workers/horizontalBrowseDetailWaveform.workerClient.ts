export const createHorizontalBrowseDetailWaveformWorker = () =>
  // @ts-expect-error Vite resolves import.meta.url in renderer build
  new Worker(new URL('./horizontalBrowseDetailWaveform.worker.ts', import.meta.url), {
    type: 'module'
  })
