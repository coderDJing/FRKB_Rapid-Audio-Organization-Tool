export const createHorizontalBrowseDetailLiveCanvasWorker = () =>
  new Worker(new URL('./horizontalBrowseDetailLiveCanvas.worker.ts', import.meta.url), {
    type: 'module'
  })
