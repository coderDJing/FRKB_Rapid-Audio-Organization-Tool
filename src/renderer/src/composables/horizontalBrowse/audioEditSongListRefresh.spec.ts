import { describe, expect, it } from 'vitest'
import type { ISongInfo } from 'src/types/globals'
import { applyAudioEditSongListSnapshot } from './audioEditSongListRefresh'

const song = (filePath: string): ISongInfo => ({ filePath }) as ISongInfo

describe('applyAudioEditSongListSnapshot', () => {
  it('只刷新 UUID 匹配的横向浏览歌单和正在播放列表', () => {
    const original = [song('D:\\a.wav')]
    const next = [song('D:\\a.wav'), song('D:\\a (2).wav')]
    const runtime = {
      playingData: {
        playingSongListUUID: 'list-1',
        playingSongListData: original
      },
      horizontalBrowseDecks: {
        topSongListUUID: 'list-1',
        topSongListData: original,
        bottomSongListUUID: 'list-other',
        bottomSongListData: original
      }
    }

    applyAudioEditSongListSnapshot(runtime, 'list-1', next)

    expect(runtime.horizontalBrowseDecks.topSongListData.map((item) => item.filePath)).toEqual([
      'D:\\a.wav',
      'D:\\a (2).wav'
    ])
    expect(runtime.playingData.playingSongListData.map((item) => item.filePath)).toEqual([
      'D:\\a.wav',
      'D:\\a (2).wav'
    ])
    expect(runtime.horizontalBrowseDecks.bottomSongListData).toBe(original)
  })
})
