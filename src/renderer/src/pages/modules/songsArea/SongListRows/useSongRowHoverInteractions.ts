import type { Ref } from 'vue'
import type { ISongInfo } from '../../../../../../types/globals'

interface CoverPreviewStateLike {
  anchorIndex: number
  displayIndex: number
}

interface UseSongRowHoverInteractionsOptions {
  hoveredCellKey: Ref<string | null>
  songs: Ref<ISongInfo[] | undefined>
  coverPreviewState: CoverPreviewStateLike
  closeCoverPreview: () => void
  emitSongContextmenu: (event: MouseEvent, song: ISongInfo) => void
  emitSongDblclick: (song: ISongInfo, event: MouseEvent) => void
  shouldSuppressPointerAction: (event?: MouseEvent) => boolean
}

export function useSongRowHoverInteractions({
  hoveredCellKey,
  songs,
  coverPreviewState,
  closeCoverPreview,
  emitSongContextmenu,
  emitSongDblclick,
  shouldSuppressPointerAction
}: UseSongRowHoverInteractionsOptions) {
  const resolvePreviewSong = () => {
    const idx =
      coverPreviewState.displayIndex >= 0
        ? coverPreviewState.displayIndex
        : coverPreviewState.anchorIndex
    return typeof idx === 'number' ? songs.value?.[idx] || null : null
  }

  const onRowsMouseOver = (event: MouseEvent) => {
    const cell = (event.target as HTMLElement)?.closest('.cell-title') as HTMLElement | null
    if (!cell) return
    const key = cell.dataset.key
    if (key) hoveredCellKey.value = key
  }

  const onRowsMouseLeave = (event: MouseEvent) => {
    const relatedTarget = (event.relatedTarget as HTMLElement | null) || null
    if (relatedTarget && typeof relatedTarget.closest === 'function') {
      if (
        relatedTarget.closest('.frkb-bubble') ||
        relatedTarget.closest('.cover-preview-overlay')
      ) {
        return
      }
    }
    hoveredCellKey.value = null
    closeCoverPreview()
  }

  const handleCoverDblclick = (song: ISongInfo, event: MouseEvent) => {
    if (shouldSuppressPointerAction(event)) return
    event.stopPropagation()
    event.preventDefault()
    closeCoverPreview()
    emitSongDblclick(song, event)
  }

  const handleCoverPreviewDblclick = (event: MouseEvent) => {
    if (shouldSuppressPointerAction(event)) return
    event.stopPropagation()
    event.preventDefault()
    const song = resolvePreviewSong()
    if (!song) return
    closeCoverPreview()
    emitSongDblclick(song, event)
  }

  const handleCoverPreviewContextmenu = (event: MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
    const song = resolvePreviewSong()
    if (song) {
      emitSongContextmenu(event, song)
    }
  }

  return {
    onRowsMouseOver,
    onRowsMouseLeave,
    handleCoverDblclick,
    handleCoverPreviewDblclick,
    handleCoverPreviewContextmenu
  }
}
