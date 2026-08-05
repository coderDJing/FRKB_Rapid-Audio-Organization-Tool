import scanNewSongDialog from '@renderer/components/scanNewSongDialog'
import confirm from '@renderer/components/confirmDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'

export type NewSongsImportLibrary = 'FilterLibrary' | 'CuratedLibrary'
type NewSongsImportOptions = {
  openSongListAfterImport?: boolean
}

export const isNewSongsImportLibrary = (
  libraryName: string
): libraryName is NewSongsImportLibrary =>
  libraryName === 'FilterLibrary' || libraryName === 'CuratedLibrary'

export const openNewSongsImport = async (
  libraryName: NewSongsImportLibrary,
  options: NewSongsImportOptions = {}
) => {
  const runtime = useRuntimeStore()
  if (runtime.isProgressing) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }

  await scanNewSongDialog({
    libraryName,
    songListUuid: '',
    openSongListAfterImport: options.openSongListAfterImport === true
  })
}
