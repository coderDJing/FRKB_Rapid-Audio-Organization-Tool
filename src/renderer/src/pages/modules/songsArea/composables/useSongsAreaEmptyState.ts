import { computed, type Ref } from 'vue'
import { t } from '@renderer/utils/translate'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'

type SongsAreaEmptyState = {
  songListUUID: string
  songInfoArr: ISongInfo[]
}

export function useSongsAreaEmptyState({
  isRequesting,
  songsAreaState,
  columnData
}: {
  isRequesting: Ref<boolean>
  songsAreaState: SongsAreaEmptyState
  columnData: Ref<ISongsAreaColumn[]>
}) {
  const hasActiveFilter = computed(() => columnData.value.some((c) => !!c.filterActive))
  const isRecycleBinView = computed(() => songsAreaState.songListUUID === RECYCLE_BIN_UUID)
  const isRecordingLibraryView = computed(
    () => songsAreaState.songListUUID === RECORDING_LIBRARY_UUID
  )
  const shouldShowEmptyState = computed(
    () => !isRequesting.value && songsAreaState.songListUUID && !songsAreaState.songInfoArr.length
  )
  const emptyTitleText = computed(() => {
    if (hasActiveFilter.value) return t('filters.noResults')
    if (isRecycleBinView.value) return t('recycleBin.noDeletionRecords')
    return t('tracks.noTracks')
  })
  const emptyHintText = computed(() => {
    if (hasActiveFilter.value) return t('filters.noResultsHint')
    if (isRecycleBinView.value || isRecordingLibraryView.value) return ''
    return t('tracks.noTracksHint')
  })

  return {
    shouldShowEmptyState,
    emptyTitleText,
    emptyHintText
  }
}
