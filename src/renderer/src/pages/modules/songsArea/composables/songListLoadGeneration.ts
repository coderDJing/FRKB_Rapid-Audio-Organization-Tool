export type SongListLoadTicket = Readonly<{
  generation: number
  songListUUID: string
}>

export const isSongListViewPending = (songListUUID: string, appliedSongListUUID: string) =>
  songListUUID !== '' && appliedSongListUUID !== songListUUID

// 回切到已落地歌单时，如果可见列表已被切走时清空，仍应保持载入态，避免先画出空表头。
export const shouldHoldSongListLoading = (params: {
  songListUUID: string
  appliedSongListUUID: string
  visibleCount: number
  isRequesting: boolean
  loadingShow?: boolean
}) => {
  if (params.loadingShow) return true
  if (isSongListViewPending(params.songListUUID, params.appliedSongListUUID)) return true
  return (
    params.isRequesting &&
    params.visibleCount === 0 &&
    params.songListUUID !== '' &&
    params.appliedSongListUUID === params.songListUUID
  )
}

// 离开动画只能画“当前 UUID 的数据还没落地”时的旧快照。
// 新歌单一旦 applied，绝不能再让上一份 leaveData 盖住真实列表。
export const resolveDisplayedSongList = <T>(
  leaveSongs: T[] | null | undefined,
  currentSongs: T[],
  songListUUID: string,
  appliedSongListUUID: string
): T[] => {
  if (leaveSongs && isSongListViewPending(songListUUID, appliedSongListUUID)) {
    return leaveSongs
  }
  return currentSongs
}

export const createSongListLoadGenerationGuard = (getCurrentSongListUUID: () => string) => {
  let generation = 0

  const begin = (songListUUID: string): SongListLoadTicket => ({
    generation: ++generation,
    songListUUID
  })

  const invalidate = () => {
    generation += 1
  }

  const isCurrent = (ticket: SongListLoadTicket) =>
    ticket.generation === generation && ticket.songListUUID === getCurrentSongListUUID()

  return {
    begin,
    invalidate,
    isCurrent
  }
}
