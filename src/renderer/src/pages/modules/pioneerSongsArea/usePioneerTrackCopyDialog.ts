import { ref, type ComputedRef } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import emitter from '@renderer/utils/mitt'
import libraryUtils from '@renderer/utils/libraryUtils'
import { copySongCueDefinitionsToTargets } from '@renderer/utils/songCueTransfer'
import { t } from '@renderer/utils/translate'
import type { ISongInfo } from '../../../../../types/globals'
import type { PioneerSongSnapshot } from './usePioneerSongsProjection'

export type PioneerTransferTarget = 'CuratedLibrary' | 'FilterLibrary' | 'MixtapeLibrary'

type ExistingOperationTracksResult = {
  missingTracks: ISongInfo[]
  existingTracks: ISongInfo[]
}

type MixtapeAppendItem = {
  filePath: string
  originPathSnapshot: string
  info: PioneerSongSnapshot
}

type UsePioneerTrackCopyDialogParams = {
  resolveTrackKey: (song: ISongInfo) => string
  resolveSelectedTracksByKeys: (keys: string[]) => ISongInfo[]
  resolveSelectedTracks: (fallback?: ISongInfo) => ISongInfo[]
  resolveExistingOperationTracks: (tracks: ISongInfo[]) => Promise<ExistingOperationTracksResult>
  showFileMissingHint: (missingTracks: ISongInfo[]) => Promise<void>
  normalizePath: (value: string) => string
  buildSongSnapshot: (filePath: string, song: ISongInfo) => PioneerSongSnapshot
  originPathSnapshot: ComputedRef<string>
}

export const usePioneerTrackCopyDialog = (params: UsePioneerTrackCopyDialogParams) => {
  const selectSongListDialogVisible = ref(false)
  const selectSongListDialogTargetLibraryName = ref<PioneerTransferTarget | ''>('')
  const selectSongListDialogTrackKeys = ref<string[]>([])

  const showErrorDialog = async (message: string) => {
    await confirm({
      title: t('common.error'),
      content: [message || t('common.unknownError')],
      confirmShow: false
    })
  }

  const openCopyTargetDialog = (libraryName: PioneerTransferTarget, tracks: ISongInfo[] = []) => {
    selectSongListDialogTrackKeys.value = tracks.map(params.resolveTrackKey).filter(Boolean)
    selectSongListDialogTargetLibraryName.value = libraryName
    selectSongListDialogVisible.value = true
  }

  const resetCopyTargetDialog = () => {
    selectSongListDialogVisible.value = false
    selectSongListDialogTargetLibraryName.value = ''
    selectSongListDialogTrackKeys.value = []
  }

  const handleSelectSongListDialogConfirm = async (targetSongListUUID: string) => {
    const targetLibraryName = selectSongListDialogTargetLibraryName.value
    const selectedTrackKeys = [...selectSongListDialogTrackKeys.value]
    resetCopyTargetDialog()
    const rawSelectedTracks = selectedTrackKeys.length
      ? params.resolveSelectedTracksByKeys(selectedTrackKeys)
      : params.resolveSelectedTracks()
    if (!rawSelectedTracks.length || !targetLibraryName) return

    const { missingTracks, existingTracks: selectedTracks } =
      await params.resolveExistingOperationTracks(rawSelectedTracks)
    if (!selectedTracks.length) {
      await params.showFileMissingHint(missingTracks)
      return
    }

    try {
      if (targetLibraryName === 'MixtapeLibrary') {
        const copiedTracks = (await window.electron.ipcRenderer.invoke(
          'mixtape:copy-files-to-vault',
          {
            filePaths: selectedTracks.map((item) => item.filePath)
          }
        )) as Array<{ sourcePath: string; targetPath: string }>

        const copiedPathMap = new Map(
          copiedTracks.map((item) => [params.normalizePath(item.sourcePath), item.targetPath])
        )
        const items = selectedTracks
          .map((track): MixtapeAppendItem | null => {
            const copiedPath = copiedPathMap.get(params.normalizePath(track.filePath))
            if (!copiedPath) return null
            return {
              filePath: copiedPath,
              originPathSnapshot: params.originPathSnapshot.value,
              info: params.buildSongSnapshot(copiedPath, track)
            }
          })
          .filter((item): item is MixtapeAppendItem => item !== null)

        if (!items.length) {
          throw new Error('MIXTAPE_COPY_TO_VAULT_FAILED')
        }

        await window.electron.ipcRenderer.invoke('mixtape:append', {
          playlistId: targetSongListUUID,
          items
        })
        emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
        emitter.emit('songsArea/clipboardHint', {
          message: t('mixtape.addedToMixtape', { count: items.length })
        })
        return
      }

      const targetDirPath = libraryUtils.findDirPathByUuid(targetSongListUUID)
      if (!targetDirPath) {
        await showErrorDialog(t('library.notExistOnDisk'))
        return
      }
      const copiedPaths = (await window.electron.ipcRenderer.invoke(
        'moveSongsToDir',
        selectedTracks.map((item) => item.filePath),
        targetDirPath,
        {
          mode: 'copy',
          curatedArtistNames: selectedTracks.map((item) => item.artist || '')
        }
      )) as string[]
      await copySongCueDefinitionsToTargets(
        copiedPaths.map((targetFilePath, index) => ({
          targetFilePath,
          sourceSong: selectedTracks[index]
        }))
      )
      emitter.emit('playlistContentChanged', { uuids: [targetSongListUUID] })
    } catch (error: unknown) {
      const messageCode = error instanceof Error ? error.message : String(error || '')
      if (messageCode === 'MIXTAPE_VAULT_UNAVAILABLE') {
        await showErrorDialog(t('pioneer.mixtapeVaultUnavailable'))
        return
      }
      if (messageCode === 'MIXTAPE_COPY_TO_VAULT_FAILED') {
        await showErrorDialog(t('pioneer.copyToMixtapeFailed'))
        return
      }
      if (messageCode === 'copySongsToDir failed') {
        await showErrorDialog(t('pioneer.copyTracksFailed'))
        return
      }
      await showErrorDialog(messageCode || t('common.unknownError'))
    }
  }

  return {
    selectSongListDialogVisible,
    selectSongListDialogTargetLibraryName,
    openCopyTargetDialog,
    handleSelectSongListDialogConfirm,
    handleSelectSongListDialogCancel: resetCopyTargetDialog
  }
}
