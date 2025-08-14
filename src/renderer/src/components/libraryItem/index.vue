<script setup lang="ts">
import { ref, nextTick, watch, useTemplateRef, computed } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import libraryItem from '@renderer/components/libraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import listIcon from '@renderer/assets/listIcon.png?asset'
import listIconBlue from '@renderer/assets/listIconBlue.png?asset'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import scanNewSongDialog from '@renderer/components/scanNewSongDialog'
import exportDialog from '@renderer/components/exportDialog'
import { t } from '@renderer/utils/translate'
import emitter from '../../utils/mitt'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import {
  handleDragStart,
  handleDragOver,
  handleDragEnter,
  handleDragLeave,
  handleDrop,
  type DragState
} from '../../utils/dragUtils'
import { reactive } from 'vue'
import { useDragSongs } from '@renderer/pages/modules/songsArea/composables/useDragSongs'
const props = defineProps({
  uuid: {
    type: String,
    required: true
  },
  libraryName: {
    type: String,
    required: true
  }
})
const runtime = useRuntimeStore()
const { handleDropToSongList } = useDragSongs()

let dirData = libraryUtils.getLibraryTreeByUUID(props.uuid)

if (dirData === null) {
  throw new Error(`dirData error: ${JSON.stringify(dirData)}`)
}
let fatherDirData = libraryUtils.getFatherLibraryTreeByUUID(props.uuid)

if (fatherDirData === null) {
  throw new Error(`fatherDirData error: ${JSON.stringify(fatherDirData)}`)
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
    const exists = fatherDirData.children?.some((obj) => obj.dirName === newName)
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

const inputKeyDownEsc = () => {
  operationInputValue.value = ''
  inputHintShow.value = false
  inputBlurHandle()
}

const inputHintText = ref('')
const inputBlurHandle = async () => {
  if (fatherDirData.children === undefined) {
    throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
  }
  if (inputHintShow.value || operationInputValue.value === '') {
    if (dirData.dirName === '') {
      if (fatherDirData.children[0]?.dirName === '') {
        fatherDirData.children.shift()
      }
    }
    operationInputValue.value = ''
    inputHintShow.value = false
    return
  }
  for (let item of fatherDirData.children) {
    if (item.order) {
      item.order++
    }
  }
  dirData.dirName = operationInputValue.value
  dirData.order = 1
  dirData.children = []
  operationInputValue.value = ''
  await libraryUtils.diffLibraryTreeExecuteFileOperation()
}
let operationInputValue = ref('')

const inputHintShow = ref(false)

const myInput = useTemplateRef('myInput')
if (dirData.dirName === '') {
  nextTick(() => {
    myInput.value?.focus()
  })
}

const rightClickMenuShow = ref(false)
const menuArr = ref(
  dirData.type === 'dir'
    ? [
        [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }],
        [{ menuName: 'common.rename' }, { menuName: 'common.delete' }]
      ]
    : [
        [{ menuName: 'tracks.importTracks' }, { menuName: 'tracks.exportTracks' }],
        [
          { menuName: 'common.rename' },
          { menuName: 'playlist.deletePlaylist' },
          { menuName: 'playlist.emptyPlaylist' }
        ],
        [{ menuName: 'tracks.showInFileExplorer' }]
      ]
)
const deleteDir = async () => {
  let libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
  if (libraryTree === null) {
    throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
  }
  let uuids = libraryUtils.getAllUuids(libraryTree)

  if (uuids.indexOf(runtime.songsArea.songListUUID) !== -1) {
    runtime.songsArea.songListUUID = ''
  }
  if (uuids.indexOf(runtime.playingData.playingSongListUUID) !== -1) {
    runtime.playingData.playingSongListUUID = ''
    runtime.playingData.playingSongListData = []
    runtime.playingData.playingSong = null
  }
  let deleteIndex
  if (fatherDirData.children === undefined) {
    throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
  }
  for (let index in fatherDirData.children) {
    if (fatherDirData.children[index] == dirData) {
      deleteIndex = index
      continue
    }
    if (fatherDirData.children[index].order && dirData.order) {
      if (fatherDirData.children[index].order > dirData.order) {
        fatherDirData.children[index].order--
      }
    }
  }
  fatherDirData.children.splice(Number(deleteIndex), 1)
  await libraryUtils.diffLibraryTreeExecuteFileOperation()
}
const contextmenuEvent = async (event: MouseEvent) => {
  let songListPath = libraryUtils.findDirPathByUuid(props.uuid)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    await confirm({
      title: t('common.error'),
      content: [t('library.notExistOnDisk')],
      confirmShow: false
    })
    deleteDir()
    return
  }
  if (runtime.libraryAreaSelected === '回收站') {
    menuArr.value = [[{ menuName: 'recycleBin.permanentlyDelete' }]]
  }
  rightClickMenuShow.value = true
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  rightClickMenuShow.value = false
  if (result !== 'cancel') {
    if (result.menuName === 'library.createPlaylist') {
      dirChildRendered.value = true
      dirChildShow.value = true

      dirData.children?.unshift({
        uuid: uuidV4(),
        dirName: '',
        type: 'songList'
      })
    } else if (result.menuName === 'library.createFolder') {
      dirChildRendered.value = true
      dirChildShow.value = true

      dirData.children?.unshift({
        uuid: uuidV4(),
        dirName: '',
        type: 'dir'
      })
    } else if (result.menuName === 'common.rename') {
      renameDivShow.value = true
      renameDivValue.value = dirData.dirName
      await nextTick()
      myRenameInput.value?.focus()
    } else if (
      result.menuName === 'common.delete' ||
      result.menuName === 'playlist.deletePlaylist'
    ) {
      deleteDir()
    } else if (result.menuName === 'playlist.emptyPlaylist') {
      let dirPath = libraryUtils.findDirPathByUuid(props.uuid)
      await window.electron.ipcRenderer.invoke('emptyDir', dirPath, getCurrentTimeDirName())
      if (runtime.songsArea.songListUUID === props.uuid) {
        // 清空播放相关数据
        runtime.playingData.playingSongListData = []
        runtime.playingData.playingSong = null

        // 清空歌曲列表界面数据
        runtime.songsArea.selectedSongFilePath.length = 0
        runtime.songsArea.songInfoArr.forEach((item) => {
          if (item.coverUrl) {
            URL.revokeObjectURL(item.coverUrl)
          }
        })
        runtime.songsArea.songInfoArr = []
      }
    } else if (result.menuName === 'tracks.importTracks') {
      if (runtime.isProgressing) {
        await confirm({
          title: t('dialog.hint'),
          content: [t('import.waitForTask')],
          confirmShow: false
        })
        return
      }
      await scanNewSongDialog({ libraryName: props.libraryName, songListUuid: props.uuid })
    } else if (result.menuName === 'tracks.exportTracks') {
      if (runtime.isProgressing) {
        await confirm({
          title: t('dialog.hint'),
          content: [t('import.waitForTask')],
          confirmShow: false
        })
        return
      }
      let result = await exportDialog({ title: 'tracks.title' })
      if (result !== 'cancel') {
        let folderPathVal = result.folderPathVal
        let deleteSongsAfterExport = result.deleteSongsAfterExport
        let dirPath = libraryUtils.findDirPathByUuid(props.uuid)
        await window.electron.ipcRenderer.invoke(
          'exportSongListToDir',
          folderPathVal,
          deleteSongsAfterExport,
          dirPath
        )
        if (deleteSongsAfterExport) {
          if (runtime.songsArea.songListUUID === props.uuid) {
            runtime.songsArea.songListUUID = ''
          }
          if (runtime.playingData.playingSongListUUID === props.uuid) {
            runtime.playingData.playingSongListUUID = ''
            runtime.playingData.playingSongListData = []
            runtime.playingData.playingSong = null
          }
        }
      }
    } else if (result.menuName === 'tracks.showInFileExplorer') {
      window.electron.ipcRenderer.send(
        'openFileExplorer',
        libraryUtils.findDirPathByUuid(props.uuid)
      )
    } else if (result.menuName === 'recycleBin.permanentlyDelete') {
      let res = await confirm({
        title: t('common.delete'),
        content: [t('tracks.confirmDelete'), t('tracks.deleteHint')]
      })
      if (res === 'confirm') {
        const recycleBin = runtime.libraryTree.children?.find((item) => item.dirName === '回收站')
        const index = recycleBin?.children?.findIndex((item) => item.uuid === props.uuid)
        if (index !== undefined && index !== -1 && recycleBin?.children) {
          recycleBin.children.splice(index, 1)
        }
        if (runtime.playingData.playingSongListUUID === props.uuid) {
          runtime.playingData.playingSongListUUID = ''
          runtime.playingData.playingSongListData = []
          runtime.playingData.playingSong = null
        }
        if (runtime.songsArea.songListUUID === props.uuid) {
          runtime.songsArea.selectedSongFilePath.length = 0
          runtime.songsArea.songInfoArr.forEach((item) => {
            if (item.coverUrl) {
              URL.revokeObjectURL(item.coverUrl)
            }
          })
          runtime.songsArea.songInfoArr = []
        }
        await libraryUtils.diffLibraryTreeExecuteFileOperation()
      }
    }
  }
}

const dirChildShow = ref(false)
const dirChildRendered = ref(false)
const dirHandleClick = async () => {
  runtime.activeMenuUUID = ''
  let songListPath = libraryUtils.findDirPathByUuid(props.uuid)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    await confirm({
      title: t('common.error'),
      content: [t('library.notExistOnDisk')],
      confirmShow: false
    })
    deleteDir()
    return
  }
  if (dirData.type == 'songList') {
    if (runtime.songsArea.songListUUID === props.uuid) {
      runtime.songsArea.songListUUID = ''
      return
    }
    runtime.songsArea.songListUUID = props.uuid
  } else {
    dirChildRendered.value = true
    dirChildShow.value = !dirChildShow.value
  }
}

emitter.on('collapseButtonHandleClick', (libraryName) => {
  if (libraryName == props.libraryName) {
    dirChildShow.value = false
  }
})

//----重命名功能--------------------------------------
const renameDivShow = ref(false)
const renameDivValue = ref('')
const myRenameInput = useTemplateRef('myRenameInput')
const renameInputHintShow = ref(false)
const renameInputHintText = ref('')
const renameInputBlurHandle = async () => {
  if (
    renameInputHintShow.value ||
    renameDivValue.value == '' ||
    renameDivValue.value == dirData.dirName
  ) {
    renameDivValue.value = ''
    renameDivShow.value = false
    return
  }
  if (dirData.uuid === runtime.songsArea.songListUUID) {
    for (let item of runtime.songsArea.songInfoArr) {
      let arr = item.filePath.split('\\')
      arr[arr.length - 2] = renameDivValue.value
      item.filePath = arr.join('\\')
    }
    for (let index in runtime.songsArea.selectedSongFilePath) {
      let arr = runtime.songsArea.selectedSongFilePath[index].split('\\')
      arr[arr.length - 2] = renameDivValue.value
      runtime.songsArea.selectedSongFilePath[index] = arr.join('\\')
    }
  }
  if (dirData.uuid === runtime.playingData.playingSongListUUID && runtime.playingData.playingSong) {
    let arr = runtime.playingData.playingSong.filePath.split('\\')
    arr[arr.length - 2] = renameDivValue.value
    runtime.playingData.playingSong.filePath = arr.join('\\')
    for (let item of runtime.playingData.playingSongListData) {
      let arr = item.filePath.split('\\')
      arr[arr.length - 2] = renameDivValue.value
      item.filePath = arr.join('\\')
    }
  }
  dirData.dirName = renameDivValue.value
  renameDivValue.value = ''
  renameDivShow.value = false
  await libraryUtils.diffLibraryTreeExecuteFileOperation()
}
const renameInputKeyDownEnter = () => {
  if (renameDivValue.value == '') {
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
      (obj) => obj.dirName === newName && obj.uuid !== props.uuid
    )
    if (exists) {
      hintText = t('library.nameAlreadyExists', { name: newName })
      hintShouldShow = true
    }
  }

  renameInputHintText.value = hintText
  renameInputHintShow.value = hintShouldShow
}

//----------------------------------------

const dragApproach = ref('')
const dragState = reactive<DragState>({
  dragApproach: ''
})

watch(
  () => dragState.dragApproach,
  (newVal) => {
    dragApproach.value = newVal
  }
)

const dragstart = async (event: DragEvent) => {
  const shouldDelete = await handleDragStart(event, props.uuid)
  if (shouldDelete) {
    deleteDir()
  }
  event.target?.addEventListener(
    'dragend',
    () => {
      runtime.dragItemData = null
    },
    { once: true }
  )
}

const dragover = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === '回收站') {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'none'
    }
    return
  }

  // 检查是否是歌曲拖拽
  const isSongDrag = e.dataTransfer?.types?.includes('application/x-song-drag')

  // 如果是歌曲拖拽且目标是歌单，显示拖拽反馈
  if (isSongDrag && dirData.type === 'songList') {
    // 检查目标歌单是否在回收站中
    const isInRecycleBin = runtime.libraryTree.children
      ?.find((item) => item.dirName === '回收站')
      ?.children?.some((child) => child.uuid === props.uuid)

    if (isInRecycleBin) {
      // 如果目标歌单在回收站中，不允许拖拽
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      return
    }

    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move'
    }
    dragState.dragApproach = 'center'
    return
  }

  handleDragOver(e, dirData, dragState)
}

const dragenter = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === '回收站') {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'none'
    }
    return
  }

  // 检查是否是歌曲拖拽
  const isSongDrag = e.dataTransfer?.types?.includes('application/x-song-drag')

  // 如果是歌曲拖拽且目标是歌单，显示拖拽反馈
  if (isSongDrag && dirData.type === 'songList') {
    // 检查目标歌单是否在回收站中
    const isInRecycleBin = runtime.libraryTree.children
      ?.find((item) => item.dirName === '回收站')
      ?.children?.some((child) => child.uuid === props.uuid)

    if (isInRecycleBin) {
      // 如果目标歌单在回收站中，不允许拖拽
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      return
    }

    e.preventDefault()
    dragState.dragApproach = 'center'
    return
  }

  handleDragEnter(e, dirData, dragState)
}

const dragleave = () => {
  if (runtime.libraryAreaSelected === '回收站') {
    return
  }
  handleDragLeave(dragState)
}

const drop = async (e: DragEvent) => {
  if (runtime.libraryAreaSelected === '回收站') {
    return
  }

  // 检查是否是歌曲拖拽
  const isSongDrag = e.dataTransfer?.types?.includes('application/x-song-drag')

  if (isSongDrag && dirData.type === 'songList') {
    // 检查目标歌单是否在回收站中
    const isInRecycleBin = runtime.libraryTree.children
      ?.find((item) => item.dirName === '回收站')
      ?.children?.some((child) => child.uuid === props.uuid)

    if (isInRecycleBin) {
      // 如果目标歌单在回收站中，不允许拖拽，直接返回
      dragState.dragApproach = ''
      return
    }

    e.preventDefault()
    const movedSongPaths = await handleDropToSongList(props.uuid, runtime.libraryAreaSelected)
    dragState.dragApproach = ''

    // 如果有歌曲被移动，发送消息给 songsArea 更新数据
    if (movedSongPaths.length > 0) {
      // 通过 mitt 发送事件
      emitter.emit('songsMovedByDrag', movedSongPaths)
    }
    return
  }

  // 处理原有的目录/歌单拖拽逻辑
  const shouldDelete = await handleDrop(e, dirData, dragState, fatherDirData)
  if (shouldDelete) {
    deleteDir()
  }
}

const indentWidth = ref(0)
let depth = libraryUtils.getDepthByUuid(props.uuid)
if (depth === undefined) {
  throw new Error(`depth error: ${JSON.stringify(depth)}`)
}
indentWidth.value = (depth - 2) * 10

let isPlaying = ref(false)
watch(
  () => runtime.playingData.playingSongListUUID,
  () => {
    if (!runtime.playingData.playingSongListUUID) {
      isPlaying.value = false
      return
    }
    let libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
    if (libraryTree === null) {
      throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
    }
    let uuids = libraryUtils.getAllUuids(libraryTree)
    if (uuids.indexOf(runtime.playingData.playingSongListUUID) != -1) {
      isPlaying.value = true
    } else {
      isPlaying.value = false
    }
  }
)

const displayDirName = computed(() => {
  if (runtime.libraryAreaSelected === '回收站' && dirData.dirName) {
    // 匹配形如 2025-04-01_15-03-45 的格式
    const match = dirData.dirName.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/)
    if (match) {
      return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`
    }
  }
  return dirData.dirName
})
</script>
<template>
  <div
    class="mainBody"
    style="display: flex; box-sizing: border-box"
    :style="'padding-left:' + indentWidth + 'px'"
    @contextmenu.stop="contextmenuEvent"
    @click.stop="dirHandleClick()"
    @dragover.stop.prevent="dragover"
    @dragstart.stop="dragstart"
    @dragenter.stop.prevent="dragenter"
    @drop.stop.prevent="drop"
    @dragleave.stop="dragleave"
    :draggable="
      dirData.dirName && !renameDivShow && runtime.libraryAreaSelected !== '回收站' ? true : false
    "
    :class="{
      rightClickBorder: rightClickMenuShow,
      borderTop: dragApproach == 'top',
      borderBottom: dragApproach == 'bottom',
      borderCenter: dragApproach == 'center',
      selectedDir: props.uuid == runtime.songsArea.songListUUID
    }"
  >
    <div class="prefixIcon" :class="{ isPlaying: isPlaying }">
      <svg
        v-if="dirData.type == 'dir'"
        v-show="!dirChildShow"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          clip-rule="evenodd"
          d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z"
        />
      </svg>
      <svg
        v-if="dirData.type == 'dir'"
        v-show="dirChildShow"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          clip-rule="evenodd"
          d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"
        />
      </svg>
      <img
        v-if="dirData.type == 'songList' && runtime.importingSongListUUID != props.uuid"
        style="width: 13px; height: 13px"
        :src="isPlaying ? listIconBlue : listIcon"
      />
      <div
        v-if="dirData.type == 'songList' && runtime.importingSongListUUID == props.uuid"
        class="loading"
        :class="{ isPlayingLoading: isPlaying }"
      ></div>
    </div>
    <div style="height: 23px; width: calc(100% - 20px)">
      <div
        v-if="dirData.dirName && !renameDivShow"
        style="
          line-height: 23px;
          font-size: 13px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        "
        :class="{ isPlaying: isPlaying }"
      >
        {{ displayDirName }}
      </div>
      <div v-if="!dirData.dirName">
        <input
          ref="myInput"
          v-model="operationInputValue"
          class="myInput"
          :class="{ myInputRedBorder: inputHintShow }"
          @blur="inputBlurHandle"
          @keydown.enter="inputKeyDownEnter"
          @keydown.esc="inputKeyDownEsc"
          @click.stop="() => {}"
          @contextmenu.stop="() => {}"
          @input="myInputHandleInput"
        />
        <div v-show="inputHintShow" class="myInputHint">
          <div>{{ inputHintText }}</div>
        </div>
      </div>
      <div v-if="renameDivShow">
        <input
          ref="myRenameInput"
          v-model="renameDivValue"
          class="myInput"
          :class="{ myInputRedBorder: renameInputHintShow }"
          @blur="renameInputBlurHandle"
          @keydown.enter="renameInputKeyDownEnter"
          @keydown.esc="renameInputKeyDownEsc"
          @click.stop="() => {}"
          @contextmenu.stop="() => {}"
          @input="renameMyInputHandleInput"
        />
        <div v-show="renameInputHintShow" class="myInputHint">
          <div>{{ renameInputHintText }}</div>
        </div>
      </div>
    </div>
  </div>
  <div
    v-if="dirData.type == 'dir' && dirChildRendered"
    v-show="dirChildShow"
    style="width: 100%; box-sizing: border-box"
  >
    <template v-for="item of dirData.children" :key="item.uuid">
      <libraryItem :uuid="item.uuid" :libraryName="props.libraryName" />
    </template>
  </div>
</template>
<style lang="scss" scoped>
.isPlaying {
  color: #0078d4 !important;
}

.isPlayingLoading {
  border: 2px solid #0078d4 !important;
}

.loading {
  width: 8px;
  height: 8px;
  border: 2px solid #cccccc;
  border-top-color: transparent;
  border-radius: 100%;
  animation: circle infinite 0.75s linear;
}

// 转转转动画
@keyframes circle {
  0% {
    transform: rotate(0);
  }

  100% {
    transform: rotate(360deg);
  }
}

.selectedDir {
  background-color: #37373d;

  &:hover {
    background-color: #37373d !important;
  }
}

.mainBody {
  &:hover {
    background-color: #2a2d2e;
  }
}

.borderTop {
  box-shadow: inset 0 1px 0 0 #0078d4;
}

.borderBottom {
  box-shadow: inset 0 -1px 0 0 #0078d4;
}

.borderCenter {
  box-shadow: inset 0 0 0 1px #0078d4;
}

.rightClickBorder {
  box-shadow: inset 0 0 0 1px #0078d4;
}

.myInput {
  width: calc(100% - 6px);
  height: 19px;
  background-color: #313131;
  border: 1px solid #086bb7;
  outline: none;
  color: #cccccc;
}

.myInputRedBorder {
  border: 1px solid #be1100;
}

.myInputHint {
  div {
    width: calc(100% - 7px);
    min-height: 25px;
    line-height: 25px;
    background-color: #5a1d1d;
    border-right: 1px solid #be1100;
    border-left: 1px solid #be1100;
    border-bottom: 1px solid #be1100;
    font-size: 12px;
    padding-left: 5px;
    position: relative;
    z-index: 100;
  }
}

.prefixIcon {
  color: #cccccc;
  width: 20px;
  min-width: 20px;
  height: 23px;
  display: flex;
  justify-content: center;
  align-items: center;
}
</style>
