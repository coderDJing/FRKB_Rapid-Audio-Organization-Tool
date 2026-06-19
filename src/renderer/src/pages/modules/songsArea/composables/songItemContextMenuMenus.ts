import {
  resolveLibraryTransferActionLabelKey,
  resolveLibraryTransferActionModeForSongList
} from '@renderer/utils/libraryTransfer'
import type { IMenu } from '../../../../../../types/globals'

const RECORDING_LIBRARY_ANALYSIS_MENU_NAMES = new Set([
  'tracks.neteaseSearch',
  'similarTracks.menu',
  'metadata.autoFillMenu',
  'fingerprints.analyzeAndAdd',
  'tracks.clearTrackCache'
])

const cloneMenuItem = (item: IMenu): IMenu => ({
  ...item,
  ...(item.children ? { children: item.children.map(cloneMenuItem) } : {})
})

const cloneMenuArr = (source: IMenu[][]): IMenu[][] =>
  source.map((group) => group.map(cloneMenuItem))

const resolveMoveMenuName = (songListUUID: string, target: 'FilterLibrary' | 'CuratedLibrary') =>
  resolveLibraryTransferActionLabelKey(
    target,
    resolveLibraryTransferActionModeForSongList(songListUUID)
  )

export const buildSongItemMenuArr = (base: IMenu[][], matchedArtists: string[]) => {
  const next = cloneMenuArr(base)
  if (matchedArtists.length > 0) {
    next.splice(2, 0, [{ menuName: 'library.removeCuratedArtistFavorite' }])
  }
  return next
}

export const createNeteaseSearchMenu = (): IMenu[] => [
  {
    menuName: 'tracks.neteaseSearch',
    children: [
      { menuName: 'tracks.neteaseSearchTitleArtist' },
      { menuName: 'tracks.neteaseSearchTitle' },
      { menuName: 'tracks.neteaseSearchArtist' },
      { menuName: 'tracks.neteaseSearchAlbum' }
    ]
  }
]

export const createDefaultMenuArr = (songListUUID: string): IMenu[][] => [
  [{ menuName: 'tracks.exportTracks' }],
  [
    { menuName: 'rekordboxDesktop.menuCreatePlaylistFromSelectedTracks' },
    { menuName: 'rekordboxXmlExport.menuExportSelectedTracks' }
  ],
  [
    { menuName: resolveMoveMenuName(songListUUID, 'FilterLibrary') },
    { menuName: resolveMoveMenuName(songListUUID, 'CuratedLibrary') },
    { menuName: 'library.addToSet' },
    { menuName: 'library.addToMixtape' }
  ],
  [
    { menuName: 'tracks.deleteTracks', shortcutKey: 'Delete' },
    { menuName: 'tracks.deleteAllAbove' }
  ],
  [{ menuName: 'tracks.showInFileExplorer' }],
  createNeteaseSearchMenu(),
  [{ menuName: 'similarTracks.menu' }],
  [{ menuName: 'metadata.autoFillMenu' }, { menuName: 'tracks.editMetadata' }],
  [{ menuName: 'fingerprints.analyzeAndAdd' }],
  [{ menuName: 'tracks.convertFormat' }],
  [{ menuName: 'tracks.clearTrackCache' }]
]

export const createSetMenuArr = (songListUUID: string): IMenu[][] =>
  createDefaultMenuArr(songListUUID)
    .map((group) =>
      group
        .filter((item) => item.menuName !== 'tracks.deleteAllAbove')
        .map((item) =>
          item.menuName === 'tracks.deleteTracks'
            ? { ...item, menuName: 'library.removeFromSet' }
            : item
        )
    )
    .filter((group) => group.length > 0)

export const createRecycleMenuArr = (): IMenu[][] => [
  [{ menuName: 'recycleBin.restoreToOriginal' }],
  [{ menuName: 'tracks.exportTracks' }],
  [{ menuName: 'library.moveToFilter' }, { menuName: 'library.moveToCurated' }],
  [
    { menuName: 'recycleBin.permanentlyDeleteTracks', shortcutKey: 'Delete' },
    { menuName: 'tracks.deleteAllAbove' }
  ],
  [{ menuName: 'tracks.showInFileExplorer' }],
  createNeteaseSearchMenu(),
  [{ menuName: 'similarTracks.menu' }],
  [{ menuName: 'metadata.autoFillMenu' }, { menuName: 'tracks.editMetadata' }],
  [{ menuName: 'fingerprints.analyzeAndAdd' }],
  [{ menuName: 'tracks.convertFormat' }],
  [{ menuName: 'tracks.clearTrackCache' }]
]

export const createMixtapeMenuArr = (): IMenu[][] => [
  [{ menuName: 'tracks.exportTracks' }],
  [
    { menuName: 'library.copyToFilter' },
    { menuName: 'library.copyToCurated' },
    { menuName: 'library.addToSet' },
    { menuName: 'library.addToMixtape' }
  ],
  [{ menuName: 'tracks.deleteTracks', shortcutKey: 'Delete' }],
  [{ menuName: 'tracks.showInFileExplorer' }],
  createNeteaseSearchMenu(),
  [{ menuName: 'similarTracks.menu' }],
  [{ menuName: 'tracks.editMetadata' }],
  [{ menuName: 'tracks.clearTrackCache' }]
]

export const withoutRecordingAnalysisMenus = (groups: IMenu[][]): IMenu[][] =>
  groups
    .map((group) =>
      group.filter((item) => !RECORDING_LIBRARY_ANALYSIS_MENU_NAMES.has(item.menuName))
    )
    .filter((group) => group.length > 0)
