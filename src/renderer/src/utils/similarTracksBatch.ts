import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import type {
  ISimilarTracksBatchResult,
  ISimilarTracksBatchSeed,
  ISongInfo
} from 'src/types/globals'

export const createSimilarTracksProgressId = () => `similar_batch_${uuidV4()}`

export const seedKeyOfSimilarSong = (song: ISongInfo, index: number): string =>
  song.filePath || song.mixtapeItemId || song.setItemId || `seed:${index}`

export const buildSimilarTrackSeedPayloads = (seeds: ISongInfo[]): ISimilarTracksBatchSeed[] =>
  (seeds || []).map((song, index) => ({
    seedKey: seedKeyOfSimilarSong(song, index),
    filePath: song.filePath,
    title: song.title || song.fileName,
    artist: song.artist,
    album: song.album,
    limit: 60
  }))

export const mapSimilarTracksError = (message: string) => {
  if (message === 'SIMILAR_TRACKS_NO_SEED') return t('similarTracks.errorNoSeed')
  if (message === 'ACOUSTID_CLIENT_MISSING') return t('similarTracks.errorAcoustIdMissing')
  if (message === 'SIMILAR_TRACKS_NETWORK') return t('similarTracks.errorNetwork')
  if (message === 'SIMILAR_TRACKS_TIMEOUT') return t('similarTracks.errorTimeout')
  if (message === 'SIMILAR_TRACKS_RATE_LIMITED') return t('similarTracks.errorRateLimited')
  return t('similarTracks.loadFailed', { message })
}

export const runSimilarTracksBatch = async (
  seeds: ISongInfo[],
  progressId = createSimilarTracksProgressId()
): Promise<ISimilarTracksBatchResult> => {
  return (await window.electron.ipcRenderer.invoke('similarTracks:findBatch', {
    seeds: buildSimilarTrackSeedPayloads(seeds),
    progressId
  })) as ISimilarTracksBatchResult
}
