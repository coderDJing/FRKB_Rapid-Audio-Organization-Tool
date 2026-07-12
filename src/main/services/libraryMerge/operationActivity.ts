let importInProgressCount = 0

export const isImportSongsBusy = (): boolean => importInProgressCount > 0

export const beginImportSongsActivity = (): (() => void) => {
  importInProgressCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    importInProgressCount = Math.max(0, importInProgressCount - 1)
  }
}
