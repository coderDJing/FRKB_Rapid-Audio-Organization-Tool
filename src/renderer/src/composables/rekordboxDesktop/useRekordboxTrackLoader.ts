import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type { RekordboxSourceKind, RekordboxSourceLibraryType } from '@shared/rekordboxSources'
import type { IPioneerPlaylistTrack } from '../../../../types/globals'

/**
 * 加载单个播放列表的轨道，统一 desktop / usb 两种来源。
 * 从 usePioneerCopyToLibrary 抽出，供"复制到精选库"与"导入精选艺人"共用，避免重复。
 */
export const loadRekordboxPlaylistTracks = async ({
  sourceKind,
  playlistId,
  sourceRootPath,
  sourceLibraryType
}: {
  sourceKind: RekordboxSourceKind
  playlistId: number
  sourceRootPath?: string
  sourceLibraryType?: RekordboxSourceLibraryType | ''
}): Promise<{ tracks?: IPioneerPlaylistTrack[] }> => {
  if (sourceKind === 'desktop') {
    return (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'load-playlist-tracks'),
      playlistId
    )) as { tracks?: IPioneerPlaylistTrack[] }
  }

  const rootPath = String(sourceRootPath || '').trim()
  if (!rootPath) return { tracks: [] }
  return (await window.electron.ipcRenderer.invoke(
    buildRekordboxSourceChannel('usb', 'load-playlist-tracks'),
    rootPath,
    playlistId,
    sourceLibraryType || undefined
  )) as { tracks?: IPioneerPlaylistTrack[] }
}
