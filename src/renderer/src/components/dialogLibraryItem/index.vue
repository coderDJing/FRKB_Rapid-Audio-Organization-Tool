<script setup lang="ts">
import { ref, nextTick, useTemplateRef } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import dialogLibraryItem from '@renderer/components/dialogLibraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import listIcon from '@renderer/assets/listIcon.png?asset'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import emitter from '../../utils/mitt'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import * as dragUtils from './dragUtils'
const props = defineProps({
  uuid: {
    type: String,
    required: true
  },
  libraryName: {
    type: String
  },
  needPaddingLeft: {
    type: Boolean,
    default: true
  }
})
const runtime = useRuntimeStore()
let dirData = libraryUtils.getLibraryTreeByUUID(props.uuid)
if (dirData === null) {
  throw new Error(`dirData error: ${JSON.stringify(dirData)}`)
}
let fatherDirData = libraryUtils.getFatherLibraryTreeByUUID(props.uuid)
const myInputHandleInput = () => {
  if (operationInputValue.value == '') {
    inputHintText.value = t('必须提供歌单或文件夹名。')
    inputHintShow.value = true
  } else {
    if (fatherDirData !== null && fatherDirData.children) {
      let exists = fatherDirData.children.some((obj) => obj.dirName == operationInputValue.value)
      if (exists) {
        inputHintText.value =
          t('此位置已存在歌单或文件夹') + operationInputValue.value + t('。请选择其他名称')
        inputHintShow.value = true
      } else {
        inputHintShow.value = false
      }
    }
  }
}

const inputKeyDownEnter = () => {
  if (operationInputValue.value == '') {
    inputHintText.value = t('必须提供歌单或文件夹名。')
    inputHintShow.value = true
    return
  }
  if (inputHintShow.value) {
    return
  }
  myInput.value?.blur()
}

const inputKeyDownEsc = () => {
  operationInputValue.value = ''
  inputBlurHandle()
}

const inputHintText = ref('')
const inputBlurHandle = async () => {
  if (inputHintShow.value || operationInputValue.value == '') {
    if (dirData && dirData.dirName == '') {
      if (fatherDirData && fatherDirData.children && fatherDirData.children[0]?.dirName == '') {
        fatherDirData.children.shift()
      }
    }
    operationInputValue.value = ''
    inputHintShow.value = false
    return
  }

  if (dirData) {
    await window.electron.ipcRenderer.invoke(
      'mkDir',
      {
        uuid: dirData.uuid,
        type: dirData.type == 'dir' ? 'dir' : 'songList',
        dirName: operationInputValue.value,
        order: 1
      },
      libraryUtils.findDirPathByUuid(props.uuid)
    )
  }
  if (fatherDirData?.children) {
    for (let item of fatherDirData.children) {
      if (item.order) {
        item.order++
      }
    }
  }
  if (dirData) {
    dirData.dirName = operationInputValue.value
    dirData.order = 1
    dirData.children = []
  }
  operationInputValue.value = ''
}
let operationInputValue = ref('')

const inputHintShow = ref(false)

const myInput = useTemplateRef('myInput')
if (dirData && dirData.dirName == '') {
  nextTick(() => {
    myInput.value?.focus()
  })
}

const rightClickMenuShow = ref(false)
const menuArr = ref(
  dirData?.type == 'dir'
    ? [
        [{ menuName: '新建歌单' }, { menuName: '新建文件夹' }],
        [{ menuName: '重命名' }, { menuName: '删除' }]
      ]
    : [[{ menuName: '重命名' }, { menuName: '删除' }]]
)
const deleteDir = async () => {
  let libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
  if (fatherDirData === null || fatherDirData.children === undefined) {
    throw new Error(`fatherDirData error: ${JSON.stringify(fatherDirData)}`)
  }
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
  const path = libraryUtils.findDirPathByUuid(props.uuid)
  await window.electron.ipcRenderer.invoke('delDir', path, getCurrentTimeDirName())
  await window.electron.ipcRenderer.invoke(
    'updateOrderAfterNum',
    libraryUtils.findDirPathByUuid(fatherDirData.uuid),
    dirData.order
  )
  let deleteIndex = null
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
}
const contextmenuEvent = async (event: MouseEvent) => {
  let songListPath = libraryUtils.findDirPathByUuid(props.uuid)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    await confirm({
      title: '错误',
      content: [t('此歌单/文件夹在磁盘中不存在，可能已被手动删除')],
      confirmShow: false
    })
    deleteDir()
    return
  }
  rightClickMenuShow.value = true
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  rightClickMenuShow.value = false
  if (result !== 'cancel') {
    if (result.menuName == '新建歌单') {
      dirChildRendered.value = true
      dirChildShow.value = true
      if (dirData.children) {
        dirData.children.unshift({
          uuid: uuidV4(),
          dirName: '',
          type: 'songList'
        })
      }
    } else if (result.menuName == '新建文件夹') {
      dirChildRendered.value = true
      dirChildShow.value = true
      dirData.children?.unshift({
        uuid: uuidV4(),
        dirName: '',
        type: 'dir'
      })
    } else if (result.menuName == '重命名') {
      renameDivShow.value = true

      renameDivValue.value = dirData.dirName
      await nextTick()
      myRenameInput.value?.focus()
    } else if (result.menuName == '删除') {
      deleteDir()
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
      title: '错误',
      content: [t('此歌单/文件夹在磁盘中不存在，可能已被手动删除')],
      confirmShow: false
    })
    deleteDir()
    return
  }
  if (dirData.type == 'songList') {
    runtime.dialogSelectedSongListUUID = props.uuid
  } else {
    dirChildRendered.value = true
    dirChildShow.value = !dirChildShow.value
  }
}
const emits = defineEmits(['dblClickSongList'])
const dirHandleDblClick = () => {
  if (dirData.type == 'songList') {
    emits('dblClickSongList')
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
  await window.electron.ipcRenderer.invoke(
    'renameDir',
    renameDivValue.value,
    libraryUtils.findDirPathByUuid(props.uuid)
  )
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
  if (
    dirData.uuid === runtime.playingData.playingSongListUUID &&
    runtime.playingData.playingSong !== null
  ) {
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
}
const renameInputKeyDownEnter = () => {
  if (renameDivValue.value == '') {
    renameInputHintText.value = t('必须提供歌单或文件夹名。')
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
  if (renameDivValue.value == '') {
    renameInputHintText.value = t('必须提供歌单或文件夹名。')
    renameInputHintShow.value = true
  } else {
    if (fatherDirData === null || fatherDirData.children === undefined) {
      throw new Error(`fatherDirData error: ${JSON.stringify(fatherDirData)}`)
    }
    let exists = fatherDirData.children.some((obj) => obj.dirName == renameDivValue.value)
    if (exists) {
      renameInputHintText.value =
        t('此位置已存在歌单或文件夹') + renameDivValue.value + t('。请选择其他名称')
      renameInputHintShow.value = true
    } else {
      renameInputHintShow.value = false
    }
  }
}
//------------------------------------

const dragstart = async (event: DragEvent) => {
  const shouldDelete = await dragUtils.handleDragStart(event, dirData)
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

const dragApproach = ref('')
const dragover = (e: DragEvent) => {
  dragApproach.value = dragUtils.handleDragOver(e, dirData)
}

const dragenter = (e: DragEvent) => {
  dragApproach.value = dragUtils.handleDragEnter(e, dirData)
}

const dragleave = (e: DragEvent) => {
  dragApproach.value = dragUtils.handleDragLeave(e)
}

const drop = async (e: DragEvent) => {
  let songListPath = libraryUtils.findDirPathByUuid(props.uuid)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    e.preventDefault()
    runtime.dragItemData = null
    await confirm({
      title: '错误',
      content: [t('此歌单/文件夹在磁盘中不存在，可能已被手动删除')],
      confirmShow: false
    })
    deleteDir()
    return
  }
  await dragUtils.handleDrop(e, dirData, fatherDirData, dragApproach.value)
  dragApproach.value = ''
}

const indentWidth = ref(0)
let depth = libraryUtils.getDepthByUuid(props.uuid)
if (depth === undefined) {
  throw new Error(`depth error: ${JSON.stringify(depth)}`)
}
indentWidth.value = (depth - 2) * 10
</script>
<template>
  <div
    class="mainBody"
    style="display: flex; cursor: pointer; box-sizing: border-box"
    :style="'padding-left:' + (props.needPaddingLeft ? indentWidth : 0) + 'px'"
    @contextmenu.stop="contextmenuEvent"
    @click.stop="dirHandleClick()"
    @dblclick.stop="dirHandleDblClick()"
    @dragover.stop.prevent="dragover"
    @dragstart.stop="dragstart"
    @dragenter.stop.prevent="dragenter"
    @drop.stop="drop"
    @dragleave.stop="dragleave"
    :draggable="dirData.dirName && !renameDivShow ? true : false"
    :class="{
      rightClickBorder: rightClickMenuShow,
      borderTop: dragApproach == 'top',
      borderBottom: dragApproach == 'bottom',
      borderCenter: dragApproach == 'center',
      selectedDir: props.uuid == runtime.dialogSelectedSongListUUID
    }"
  >
    <div class="prefixIcon">
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
      <img v-if="dirData.type == 'songList'" style="width: 13px; height: 13px" :src="listIcon" />
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
      >
        {{ dirData.dirName }}
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
      <dialogLibraryItem
        :uuid="item.uuid"
        :libraryName="props.libraryName"
        @dblClickSongList="emits('dblClickSongList')"
      />
    </template>
  </div>
</template>
<style lang="scss" scoped>
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
