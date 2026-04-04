import {
  loadPioneerPreviewWaveformsByDrivePath,
  streamPioneerPreviewWaveformsByDrivePath
} from '../pioneerDeviceLibrary/waveform'
import type { RekordboxDesktopPreviewWaveformLoadItem } from './types'

export async function loadRekordboxDesktopPreviewWaveforms(
  rootPath: string,
  analyzePaths: string[]
): Promise<{
  rootPath: string
  items: RekordboxDesktopPreviewWaveformLoadItem[]
}> {
  const loaded = await loadPioneerPreviewWaveformsByDrivePath(rootPath, analyzePaths)
  return {
    rootPath: loaded.drivePath,
    items: loaded.items
  }
}

export async function streamRekordboxDesktopPreviewWaveforms(
  rootPath: string,
  analyzePaths: string[],
  onItem: (item: RekordboxDesktopPreviewWaveformLoadItem) => void
): Promise<{
  rootPath: string
  total: number
}> {
  const streamed = await streamPioneerPreviewWaveformsByDrivePath(rootPath, analyzePaths, onItem)
  return {
    rootPath: streamed.drivePath,
    total: streamed.total
  }
}
