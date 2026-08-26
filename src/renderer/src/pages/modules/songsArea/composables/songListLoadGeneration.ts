export type SongListLoadTicket = Readonly<{
  generation: number
  songListUUID: string
}>

export const isSongListViewPending = (songListUUID: string, appliedSongListUUID: string) =>
  songListUUID !== '' && appliedSongListUUID !== songListUUID

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
