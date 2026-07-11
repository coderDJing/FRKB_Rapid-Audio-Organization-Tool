import { describe, expect, it } from 'vitest'
import type { ISongInfo } from '../../../../types/globals'
import {
  CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  CURRENT_SONG_STRUCTURE_FORMAT_VERSION,
  type SongStructureAnalysis,
  type SongStructureSectionKind
} from '../../../../shared/songStructure'
import {
  patchHorizontalBrowseRuntimeSongSnapshots,
  type HorizontalBrowseSongSnapshotRuntime
} from './horizontalBrowseSongSnapshotPatch'

const FILE_PATH = 'G:\\FRKB_database-A\\library\\FilterLibrary\\test.mp3'

const createStructure = (kind: SongStructureSectionKind): SongStructureAnalysis => ({
  formatVersion: CURRENT_SONG_STRUCTURE_FORMAT_VERSION,
  algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  source: 'algorithmic',
  durationSec: 64,
  bpm: 128,
  firstBeatMs: 0,
  barBeatOffset: 0,
  phraseBars: 8,
  sections: [
    {
      startSec: 0,
      endSec: 64,
      startBar: 1,
      endBar: 32,
      phraseIndex: 0,
      kind,
      confidence: 0.8,
      energy: 0.7,
      low: 0.7,
      high: 0.5,
      novelty: 0.2
    }
  ]
})

const createSong = (songStructure: SongStructureAnalysis): ISongInfo => ({
  filePath: FILE_PATH,
  fileName: 'test.mp3',
  fileFormat: 'MP3',
  cover: null,
  title: 'test',
  artist: '',
  album: '',
  duration: '64',
  genre: '',
  label: '',
  bitrate: undefined,
  container: undefined,
  bpm: 128,
  firstBeatMs: 0,
  barBeatOffset: 0,
  songStructure
})

describe('useHorizontalBrowseDeckSongSync', () => {
  it('段落更新会同步播放快照和 Deck 来源歌单', () => {
    const oldStructure = createStructure('groove')
    const nextStructure = createStructure('drop')
    const runtime: HorizontalBrowseSongSnapshotRuntime = {
      playingData: {
        playingSong: createSong(oldStructure),
        playingSongListData: [createSong(oldStructure)]
      },
      horizontalBrowseDecks: {
        topSongListData: [createSong(oldStructure)],
        bottomSongListData: [createSong(oldStructure)]
      },
      externalPlaylist: { songs: [createSong(oldStructure)] },
      songsArea: { songInfoArr: [createSong(oldStructure)] },
      songsAreaPanels: {
        panes: {
          single: { songInfoArr: [createSong(oldStructure)] },
          left: { songInfoArr: [] },
          right: { songInfoArr: [] }
        }
      }
    }

    patchHorizontalBrowseRuntimeSongSnapshots(
      runtime,
      { filePath: FILE_PATH, songStructure: nextStructure },
      (song, payload) =>
        song.filePath === payload.filePath
          ? { ...song, songStructure: payload.songStructure }
          : song
    )

    const resolveKind = (song: ISongInfo | null | undefined) =>
      song?.songStructure?.sections[0]?.kind
    expect(resolveKind(runtime.playingData.playingSong)).toBe('drop')
    expect(resolveKind(runtime.playingData.playingSongListData[0])).toBe('drop')
    expect(resolveKind(runtime.horizontalBrowseDecks.topSongListData[0])).toBe('drop')
    expect(resolveKind(runtime.horizontalBrowseDecks.bottomSongListData[0])).toBe('drop')
    expect(resolveKind(runtime.externalPlaylist.songs[0])).toBe('drop')
    expect(resolveKind(runtime.songsArea.songInfoArr[0])).toBe('drop')
    expect(resolveKind(runtime.songsAreaPanels.panes.single.songInfoArr[0])).toBe('drop')
  })
})
