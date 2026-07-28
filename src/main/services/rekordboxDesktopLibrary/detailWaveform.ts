import { loadPioneerDetailWaveformsByDrivePath } from '../pioneerDeviceLibrary/detailWaveform'

export async function loadRekordboxDesktopDetailWaveforms(
  rootPath: string,
  analyzePaths: string[]
) {
  const loaded = await loadPioneerDetailWaveformsByDrivePath(rootPath, analyzePaths)
  return {
    rootPath: loaded.drivePath,
    items: loaded.items
  }
}
