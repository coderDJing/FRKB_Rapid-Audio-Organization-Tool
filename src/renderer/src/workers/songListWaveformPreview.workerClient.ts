export const createSongListWaveformPreviewWorker = () =>
  // @ts-expect-error Vite resolves import.meta.url in renderer build
  new Worker(new URL('./songListWaveformPreview.worker.ts', import.meta.url), {
    type: 'module'
  })
