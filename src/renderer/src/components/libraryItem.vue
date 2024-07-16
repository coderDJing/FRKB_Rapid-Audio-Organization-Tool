<script setup>
import { ref, nextTick, watch } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu.vue'
import libraryItem from '@renderer/components/libraryItem.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirmDialog from '@renderer/components/confirmDialog.vue'
import listIcon from '@renderer/assets/listIcon.png'
import libraryUtils from '@renderer/utils/libraryUtils.js'
import { v4 as uuidv4 } from 'uuid'
import confirm from '@renderer/components/confirm.js'
import scanNewSongDialog from '@renderer/components/scanNewSongDialog.vue'

const props = defineProps({
  uuid: {
    type: String,
    required: true
  },
  libraryName: {
    type: String
  }
})
const runtime = useRuntimeStore()
let dirData = libraryUtils.getLibraryTreeByUUID(runtime.libraryTree, props.uuid)
let fatherDirData = libraryUtils.getFatherLibraryTreeByUUID(runtime.libraryTree, props.uuid)
const myInputHandleInput = (e) => {
  if (operationInputValue.value == '') {
    inputHintText.value = '必须提供歌单或文件夹名。'
    inputHintShow.value = true
  } else {
    let exists = fatherDirData.children.some((obj) => obj.dirName == operationInputValue.value)
    if (exists) {
      inputHintText.value =
        '此位置已存在歌单或文件夹' + operationInputValue.value + '。请选择其他名称'
      inputHintShow.value = true
    } else {
      inputHintShow.value = false
    }
  }
}

const inputKeyDownEnter = () => {
  if (operationInputValue.value == '') {
    inputHintText.value = '必须提供歌单或文件夹名。'
    inputHintShow.value = true
    return
  }
  if (inputHintShow.value) {
    return
  }
  myInput.value.blur()
}

const inputKeyDownEsc = () => {
  operationInputValue.value = ''
  inputBlurHandle()
}

const inputHintText = ref('')
const inputBlurHandle = async () => {
  if (inputHintShow.value || operationInputValue.value == '') {
    if (dirData.dirName == '') {
      if (fatherDirData.children[0]?.dirName == '') {
        fatherDirData.children.shift()
      }
    }
    operationInputValue.value = ''
    inputHintShow.value = false
    return
  }

  await window.electron.ipcRenderer.invoke(
    'mkDir',
    {
      uuid: dirData.uuid,
      type: dirData.type == 'dir' ? 'dir' : 'songList',
      dirName: operationInputValue.value,
      order: 1
    },
    libraryUtils.findDirPathByUuid(runtime.libraryTree, props.uuid)
  )

  for (let item of fatherDirData.children) {
    if (item.order) {
      item.order++
    }
  }
  dirData.dirName = operationInputValue.value
  dirData.order = 1
  dirData.children = []
  operationInputValue.value = ''
}
let operationInputValue = ref('')

const inputHintShow = ref(false)

const myInput = ref(null)
if (dirData.dirName == '') {
  nextTick(() => {
    myInput.value.focus()
  })
}
const importSongsDialogShow = ref(false)
const menuButtonClick = async (item, e) => {
  if (item.menuName == '新建歌单') {
    dirChildRendered.value = true
    dirChildShow.value = true

    dirData.children.unshift({
      uuid: uuidv4(),
      dirName: '',
      type: 'songList'
    })
  } else if (item.menuName == '新建文件夹') {
    dirChildRendered.value = true
    dirChildShow.value = true

    dirData.children.unshift({
      uuid: uuidv4(),
      dirName: '',
      type: 'dir'
    })
  } else if (item.menuName == '重命名') {
    renameDivShow.value = true
    renameDivValue.value = dirData.dirName
    await nextTick()
    myRenameInput.value.focus()
  } else if (item.menuName == '删除') {
    confirmDialogContent.value = [
      dirData.type == 'dir' ? '确认删除此文件夹吗？' : '确认删除此歌单吗？',
      dirData.type == 'dir' ? '文件夹中的内容将一并被删除' : '歌单中的曲目将一并被删除',
      '"' + dirData.dirName + '"'
    ]
    confirmDialogShow.value = true
  } else if (item.menuName == '导入曲目') {
    importSongsDialogShow.value = true
  }
}

const rightClickMenuShow = ref(false)
const clickEvent = ref({})
const menuArr = ref(
  dirData.type == 'dir'
    ? [
        [{ menuName: '新建歌单' }, { menuName: '新建文件夹' }],
        [{ menuName: '重命名' }, { menuName: '删除' }]
      ]
    : [[{ menuName: '导入曲目' }], [{ menuName: '重命名' }, { menuName: '删除' }]]
)
const contextmenuEvent = (event) => {
  clickEvent.value = event
  rightClickMenuShow.value = true
}

const dirChildShow = ref(false)
const dirChildRendered = ref(false)
const dirHandleClick = async () => {
  runtime.activeMenuUUID = ''
  if (dirData.type == 'songList') {
    runtime.selectedSongListUUID = props.uuid
  } else {
    dirChildRendered.value = true
    dirChildShow.value = !dirChildShow.value
  }
}

window.electron.ipcRenderer.on('collapseButtonHandleClick', (event, libraryName) => {
  if (libraryName == props.libraryName) {
    dirChildShow.value = false
  }
})
//----重命名功能--------------------------------------
const renameDivShow = ref(false)
const renameDivValue = ref('')
const myRenameInput = ref(null)
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
    libraryUtils.findDirPathByUuid(runtime.libraryTree, props.uuid)
  )
  dirData.dirName = renameDivValue.value
  renameDivValue.value = ''
  renameDivShow.value = false
}
const renameInputKeyDownEnter = () => {
  if (renameDivValue.value == '') {
    renameInputHintText.value = '必须提供歌单或文件夹名。'
    renameInputHintShow.value = true
    return
  }
  if (renameInputHintShow.value) {
    return
  }
  myRenameInput.value.blur()
}
const renameInputKeyDownEsc = () => {
  renameDivValue.value = ''
  renameInputBlurHandle()
}
const renameMyInputHandleInput = (e) => {
  if (renameDivValue.value == '') {
    renameInputHintText.value = '必须提供歌单或文件夹名。'
    renameInputHintShow.value = true
  } else {
    let exists = fatherDirData.children.some((obj) => obj.dirName == renameDivValue.value)
    if (exists) {
      renameInputHintText.value =
        '此位置已存在歌单或文件夹' + renameDivValue.value + '。请选择其他名称'
      renameInputHintShow.value = true
    } else {
      renameInputHintShow.value = false
    }
  }
}

//----------------------------------------
//------删除功能-------------------------
const confirmDialogShow = ref(false)
const confirmDialogContent = ref([])
const deleteConfirm = async () => {
  const path = libraryUtils.findDirPathByUuid(runtime.libraryTree, props.uuid)
  await window.electron.ipcRenderer.invoke('delDir', path)
  await window.electron.ipcRenderer.invoke(
    'updateOrderAfterNum',
    libraryUtils.findDirPathByUuid(runtime.libraryTree, fatherDirData.uuid),
    dirData.order
  )
  let deleteIndex = null
  for (let index in fatherDirData.children) {
    if (fatherDirData.children[index] == dirData) {
      deleteIndex = index
      continue
    }
    if (fatherDirData.children[index].order > dirData.order) {
      fatherDirData.children[index].order--
    }
  }
  fatherDirData.children.splice(deleteIndex, 1)
  deleteCancel()
}
const deleteCancel = () => {
  confirmDialogContent.value = []
  confirmDialogShow.value = false
}
//------------------------------------

const dragstart = (e) => {
  runtime.dragItemData = dirData
}
const dragApproach = ref('')
const dragover = (e) => {
  e.dataTransfer.dropEffect = 'move'
  if (runtime.dragItemData == dirData) {
    return
  }

  if (libraryUtils.isDragItemInDirChildren(runtime.dragItemData.children, dirData.uuid)) {
    return
  }
  if (dirData.type == 'songList') {
    if (e.offsetY <= 12) {
      dragApproach.value = 'top'
    } else {
      dragApproach.value = 'bottom'
    }
  } else {
    if (e.offsetY <= 8) {
      dragApproach.value = 'top'
    } else if (e.offsetY > 8 && e.offsetY < 16) {
      dragApproach.value = 'center'
    } else {
      dragApproach.value = 'bottom'
    }
  }
}
const dragenter = (e) => {
  e.dataTransfer.dropEffect = 'move'
  if (runtime.dragItemData == dirData) {
    return
  }
  if (libraryUtils.isDragItemInDirChildren(runtime.dragItemData.children, dirData.uuid)) {
    return
  }
  if (dirData.type == 'songList') {
    if (e.offsetY <= 12) {
      dragApproach.value = 'top'
    } else {
      dragApproach.value = 'bottom'
    }
  } else {
    if (e.offsetY <= 8) {
      dragApproach.value = 'top'
    } else if (e.offsetY > 8 && e.offsetY < 16) {
      dragApproach.value = 'center'
    } else {
      dragApproach.value = 'bottom'
    }
  }
}
const dragleave = (e) => {
  dragApproach.value = ''
}

const approachCenterEnd = () => {
  dirData.children.unshift({ ...runtime.dragItemData, order: 1 })
  let dragItemDataFather = libraryUtils.getFatherLibraryTreeByUUID(
    runtime.libraryTree,
    runtime.dragItemData.uuid
  )
  for (let item of dragItemDataFather.children) {
    if (item.order > runtime.dragItemData.order) {
      item.order--
    }
  }
  dragItemDataFather.children.splice(dragItemDataFather.children.indexOf(runtime.dragItemData), 1)
}
const drop = async (e) => {
  let approach = dragApproach.value
  dragApproach.value = ''
  if (runtime.dragItemData == dirData) {
    return
  }
  if (libraryUtils.isDragItemInDirChildren(runtime.dragItemData.children, dirData.uuid)) {
    return
  }
  if (approach == 'center') {
    if (
      libraryUtils.getFatherLibraryTreeByUUID(runtime.libraryTree, runtime.dragItemData.uuid)
        .uuid == dirData.uuid
    ) {
      let removedElement = dirData.children.splice(
        dirData.children.indexOf(runtime.dragItemData),
        1
      )[0]
      dirData.children.unshift(removedElement)
      libraryUtils.reOrderChildren(dirData.children)
      await window.electron.ipcRenderer.invoke(
        'reOrderSubDir',
        libraryUtils.findDirPathByUuid(runtime.libraryTree, dirData.uuid),
        JSON.stringify(dirData.children)
      )
      return
    }
    const existingItem = dirData.children.find((item) => {
      return (
        item.dirName === runtime.dragItemData.dirName && item.uuid !== runtime.dragItemData.uuid
      )
    })
    if (existingItem) {
      let res = await confirm({
        title: '移动',
        content: [
          '目标文件夹下已存在："' + runtime.dragItemData.dirName + '"',
          '是否继续执行替换',
          '（被替换的歌单或文件夹将被删除）'
        ]
      })
      if (res == 'confirm') {
        await window.electron.ipcRenderer.invoke(
          'moveInDir',
          libraryUtils.findDirPathByUuid(runtime.libraryTree, runtime.dragItemData.uuid),
          libraryUtils.findDirPathByUuid(runtime.libraryTree, dirData.uuid),
          true
        )
        let oldOrder = existingItem.order
        dirData.children.splice(dirData.children.indexOf(existingItem), 1)
        for (let item of dirData.children) {
          if (item.order < oldOrder) {
            item.order++
          } else {
            break
          }
        }
        approachCenterEnd()
      }
      return
    }
    let dragItemDataFather = libraryUtils.getFatherLibraryTreeByUUID(
      runtime.libraryTree,
      runtime.dragItemData.uuid
    )
    await window.electron.ipcRenderer.invoke(
      'moveToDirSample',
      libraryUtils.findDirPathByUuid(runtime.libraryTree, runtime.dragItemData.uuid),
      libraryUtils.findDirPathByUuid(runtime.libraryTree, dirData.uuid)
    )
    let removedElement = dragItemDataFather.children.splice(
      dragItemDataFather.children.indexOf(runtime.dragItemData),
      1
    )[0]
    libraryUtils.reOrderChildren(dragItemDataFather.children)
    await window.electron.ipcRenderer.invoke(
      'reOrderSubDir',
      libraryUtils.findDirPathByUuid(runtime.libraryTree, dragItemDataFather.uuid),
      JSON.stringify(dragItemDataFather.children)
    )
    dirData.children.unshift(removedElement)
    libraryUtils.reOrderChildren(dirData.children)
    await window.electron.ipcRenderer.invoke(
      'reOrderSubDir',
      libraryUtils.findDirPathByUuid(runtime.libraryTree, dirData.uuid),
      JSON.stringify(dirData.children)
    )
    return
  } else if (approach == 'top' || approach == 'bottom') {
    let dragItemDataFather = libraryUtils.getFatherLibraryTreeByUUID(
      runtime.libraryTree,
      runtime.dragItemData.uuid
    )
    if (dragItemDataFather == fatherDirData) {
      // 两个dir在同一目录下
      if (approach == 'top' && dirData.order - runtime.dragItemData.order == 1) {
        return
      }
      if (approach == 'bottom' && runtime.dragItemData.order - dirData.order == 1) {
        return
      }
      let removedElement = fatherDirData.children.splice(
        fatherDirData.children.indexOf(runtime.dragItemData),
        1
      )[0]
      fatherDirData.children.splice(
        approach == 'top'
          ? fatherDirData.children.indexOf(dirData)
          : fatherDirData.children.indexOf(dirData) + 1,
        0,
        removedElement
      )
      libraryUtils.reOrderChildren(fatherDirData.children)

      await window.electron.ipcRenderer.invoke(
        'reOrderSubDir',
        libraryUtils.findDirPathByUuid(runtime.libraryTree, fatherDirData.uuid),
        JSON.stringify(fatherDirData.children)
      )
      return
    } else {
      // 两个dir不在同一目录下
      const existingItem = fatherDirData.children.find((item) => {
        return (
          item.dirName === runtime.dragItemData.dirName && item.uuid !== runtime.dragItemData.uuid
        )
      })
      if (existingItem) {
        let res = await confirm({
          title: '移动',
          content: [
            '目标文件夹下已存在："' + runtime.dragItemData.dirName + '"',
            '是否继续执行替换',
            '（被替换的歌单或文件夹将被删除）'
          ]
        })
        if (res == 'confirm') {
          let targetPath = libraryUtils.findDirPathByUuid(runtime.libraryTree, existingItem.uuid)

          await window.electron.ipcRenderer.invoke('delDir', targetPath)
          fatherDirData.children.splice(
            approach == 'top'
              ? fatherDirData.children.indexOf(dirData)
              : fatherDirData.children.indexOf(dirData) + 1,
            0,
            runtime.dragItemData
          )
          fatherDirData.children.splice(fatherDirData.children.indexOf(existingItem), 1)
          libraryUtils.reOrderChildren(fatherDirData.children)
          await window.electron.ipcRenderer.invoke(
            'moveToDirSample',
            libraryUtils.findDirPathByUuid(runtime.libraryTree, runtime.dragItemData.uuid),
            libraryUtils.findDirPathByUuid(runtime.libraryTree, fatherDirData.uuid)
          )
          await window.electron.ipcRenderer.invoke(
            'reOrderSubDir',
            libraryUtils.findDirPathByUuid(runtime.libraryTree, fatherDirData.uuid),
            JSON.stringify(fatherDirData.children)
          )
          dragItemDataFather.children.splice(
            dragItemDataFather.children.indexOf(runtime.dragItemData),
            1
          )
          libraryUtils.reOrderChildren(dragItemDataFather.children)
          await window.electron.ipcRenderer.invoke(
            'reOrderSubDir',
            libraryUtils.findDirPathByUuid(runtime.libraryTree, dragItemDataFather.uuid),
            JSON.stringify(dragItemDataFather.children)
          )
        }
        return
      }
      await window.electron.ipcRenderer.invoke(
        'moveToDirSample',
        libraryUtils.findDirPathByUuid(runtime.libraryTree, runtime.dragItemData.uuid),
        libraryUtils.findDirPathByUuid(runtime.libraryTree, fatherDirData.uuid)
      )
      let removedElement = dragItemDataFather.children.splice(
        dragItemDataFather.children.indexOf(runtime.dragItemData),
        1
      )[0]
      fatherDirData.children.splice(
        approach == 'top'
          ? fatherDirData.children.indexOf(dirData)
          : fatherDirData.children.indexOf(dirData) + 1,
        0,
        removedElement
      )
      libraryUtils.reOrderChildren(dragItemDataFather.children)
      await window.electron.ipcRenderer.invoke(
        'reOrderSubDir',
        libraryUtils.findDirPathByUuid(runtime.libraryTree, dragItemDataFather.uuid),
        JSON.stringify(dragItemDataFather.children)
      )
      libraryUtils.reOrderChildren(fatherDirData.children)
      await window.electron.ipcRenderer.invoke(
        'reOrderSubDir',
        libraryUtils.findDirPathByUuid(runtime.libraryTree, fatherDirData.uuid),
        JSON.stringify(fatherDirData.children)
      )
      return
    }
  }
}
const indentWidth = ref(0)
indentWidth.value = (libraryUtils.getDepthByUuid(runtime.libraryTree, props.uuid) - 2) * 10
</script>
<template>
  <div
    class="mainBody"
    style="display: flex; cursor: pointer; box-sizing: border-box"
    :style="'padding-left:' + indentWidth + 'px'"
    @contextmenu.stop="contextmenuEvent"
    @click.stop="dirHandleClick()"
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
      selectedDir: props.uuid == runtime.selectedSongListUUID
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
      <libraryItem :uuid="item.uuid" :libraryName="props.libraryName" />
    </template>
  </div>
  <rightClickMenu
    v-model="rightClickMenuShow"
    :menuArr="menuArr"
    :clickEvent="clickEvent"
    @menuButtonClick="menuButtonClick"
  ></rightClickMenu>
  <confirmDialog
    v-if="confirmDialogShow"
    title="删除"
    :content="confirmDialogContent"
    @confirm="deleteConfirm"
    @cancel="deleteCancel"
  />
  <scanNewSongDialog
    v-if="importSongsDialogShow"
    @cancel="importSongsDialogShow = false"
    :songListUuid="props.uuid"
  >
  </scanNewSongDialog>
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
  border-top: 1px solid #0078d4;
}

.borderBottom {
  border-bottom: 1px solid #0078d4;
}

.borderCenter {
  border: 1px solid #0078d4;
}

.rightClickBorder {
  border: 1px solid #0078d4;
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
