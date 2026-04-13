export const createSongListWaveformPreviewWorker = () =>
  new Worker(new URL('./songListWaveformPreview.worker.ts', import.meta.url), {
    type: 'module'
  })
