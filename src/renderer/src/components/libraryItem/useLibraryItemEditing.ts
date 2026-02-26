import { nextTick, ref, useTemplateRef, type Ref } from 'vue'
import { t } from '@renderer/utils/translate'
import libraryUtils from '@renderer/utils/libraryUtils'

interface UseLibraryItemEditingOptions {
  dirDataRef: Ref<any | null>
  fatherDirDataRef: Ref<any | null>
  runtime: any
  props: { uuid: string }
  emitter: { on: (event: string, handler: (...args: any[]) => void) => void }
}

export function useLibraryItemEditing({
  dirDataRef,
  fatherDirDataRef,
  runtime,
  props,
  emitter
}: UseLibraryItemEditingOptions) {
  const getDirData = () => dirDataRef.value
  const getFatherDirData = () => fatherDirDataRef.value

  const operationInputValue = ref('')
  const inputHintText = ref('')
  const inputHintShow = ref(false)
  const myInput = useTemplateRef<HTMLInputElement | null>('myInput')

  if (getDirData()?.dirName === '') {
    nextTick(() => {
      myInput.value?.focus()
    })
  }

  const myInputHandleInput = () => {
    const newName = operationInputValue.value
    const invalidCharsRegex = /[<>:"/\\|?*\u0000-\u001F]/
    let hintShouldShow = false
    let hintText = ''

    if (newName === '') {
      hintText = t('library.nameRequired')
      hintShouldShow = true
    } else if (invalidCharsRegex.test(newName)) {
      hintText = t('library.nameInvalidChars')
      hintShouldShow = true
    } else {
      const fatherDirData = getFatherDirData()
      const exists = fatherDirData?.children?.some((obj: any) => obj.dirName === newName)
      if (exists) {
        hintText = t('library.nameAlreadyExists', { name: newName })
        hintShouldShow = true
      }
    }

    inputHintText.value = hintText
    inputHintShow.value = hintShouldShow
  }

  const inputKeyDownEnter = () => {
    if (inputHintShow.value || operationInputValue.value === '') {
      if (!inputHintShow.value) {
        inputHintText.value = t('library.nameRequired')
        inputHintShow.value = true
      }
      return
    }
    myInput.value?.blur()
  }

  const resetDraftNode = () => {
    const dirData = getDirData()
    const fatherDirData = getFatherDirData()
    if (dirData?.dirName === '' && fatherDirData?.children?.[0]?.dirName === '') {
      fatherDirData.children.shift()
    }
    operationInputValue.value = ''
    inputHintShow.value = false
  }

  const inputKeyDownEsc = () => {
    resetDraftNode()
    inputBlurHandle()
  }

  const inputBlurHandle = async () => {
    const dirData = getDirData()
    const fatherDirData = getFatherDirData()
    if (!dirData || !fatherDirData) return
    if (!Array.isArray(fatherDirData.children)) {
      throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
    }
    if (inputHintShow.value || operationInputValue.value === '') {
      resetDraftNode()
      return
    }
    for (const item of fatherDirData.children) {
      if (item.order) {
        item.order++
      }
    }
    dirData.dirName = operationInputValue.value
    dirData.order = 1
    dirData.children = []
    operationInputValue.value = ''
    if (dirData.type === 'songList') {
      runtime.creatingSongListUUID = dirData.uuid
    }
    await libraryUtils.diffLibraryTreeExecuteFileOperation()
    if (dirData.type === 'songList') {
      runtime.songsArea.songListUUID = dirData.uuid
    }
    if (runtime.creatingSongListUUID === dirData.uuid) {
      runtime.creatingSongListUUID = ''
    }
  }

  const renameDivShow = ref(false)
  const renameDivValue = ref('')
  const myRenameInput = useTemplateRef<HTMLInputElement | null>('myRenameInput')
  const renameInputHintShow = ref(false)
  const renameInputHintText = ref('')

  const renameInputBlurHandle = async () => {
    const dirData = getDirData()
    if (!dirData) {
      renameDivValue.value = ''
      renameDivShow.value = false
      return
    }
    if (
      renameInputHintShow.value ||
      renameDivValue.value === '' ||
      renameDivValue.value === dirData.dirName
    ) {
      renameDivValue.value = ''
      renameDivShow.value = false
      return
    }
    const renamedUuid = dirData.uuid
    const wasCurrentSongList = renamedUuid === runtime.songsArea.songListUUID
    const wasPlayingSongList = renamedUuid === runtime.playingData.playingSongListUUID
    dirData.dirName = renameDivValue.value
    renameDivValue.value = ''
    renameDivShow.value = false
    const success = await libraryUtils.diffLibraryTreeExecuteFileOperation()
    if (!success) return
    if (wasPlayingSongList) {
      runtime.playingData.playingSongListUUID = ''
      runtime.playingData.playingSongListData = []
      runtime.playingData.playingSong = null
    }
    if (wasCurrentSongList) {
      runtime.songsArea.songListUUID = ''
      await nextTick()
      runtime.songsArea.songListUUID = renamedUuid
    }
  }

  const renameInputKeyDownEnter = () => {
    if (renameDivValue.value === '') {
      renameInputHintText.value = t('library.nameRequired')
      renameInputHintShow.value = true
      return
    }
    if (renameInputHintShow.value) {
      return
    }
    myRenameInput.value?.blur()
  }

  const renameInputKeyDownEsc = () => {
    renameDivValue.value = ''
    renameInputBlurHandle()
  }

  const renameMyInputHandleInput = () => {
    const fatherDirData = getFatherDirData()
    if (!fatherDirData) return
    const newName = renameDivValue.value
    const invalidCharsRegex = /[<>:"/\\|?*\u0000-\u001F]/
    let hintShouldShow = false
    let hintText = ''

    if (newName === '') {
      hintText = t('library.nameRequired')
      hintShouldShow = true
    } else if (invalidCharsRegex.test(newName)) {
      hintText = t('library.nameInvalidChars')
      hintShouldShow = true
    } else {
      const exists = fatherDirData.children?.some(
        (obj: any) => obj.dirName === newName && obj.uuid !== props.uuid
      )
      if (exists) {
        hintText = t('library.nameAlreadyExists', { name: newName })
        hintShouldShow = true
      }
    }

    renameInputHintText.value = hintText
    renameInputHintShow.value = hintShouldShow
  }

  const startRename = async () => {
    const dirData = getDirData()
    if (!dirData?.dirName) return
    renameDivShow.value = true
    renameDivValue.value = dirData.dirName
    await nextTick()
    myRenameInput.value?.focus()
  }

  emitter.on('libraryArea/trigger-rename', async (targetUuid: string) => {
    try {
      if (targetUuid !== props.uuid) return
      await startRename()
    } catch {}
  })

  return {
    operationInputValue,
    inputHintText,
    inputHintShow,
    myInput,
    myInputHandleInput,
    inputKeyDownEnter,
    inputKeyDownEsc,
    inputBlurHandle,
    renameDivShow,
    renameDivValue,
    myRenameInput,
    renameInputHintShow,
    renameInputHintText,
    renameInputBlurHandle,
    renameInputKeyDownEnter,
    renameInputKeyDownEsc,
    renameMyInputHandleInput,
    startRename
  }
}
