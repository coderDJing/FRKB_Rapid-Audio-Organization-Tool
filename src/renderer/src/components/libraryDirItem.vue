<script setup>
import { ref, nextTick, watch } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu.vue';
import libraryDirItem from '@renderer/components/libraryDirItem.vue'
import librarySonglistItem from '@renderer/components/librarySonglistItem.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirmDialog from '@renderer/components/confirmDialog.vue';
const runtime = useRuntimeStore()
const props = defineProps({
  modelValue: {
    type: Object,
    required: true
  },
  parentArr: {
    type: Array,
    required: true
  }
})
const emits = defineEmits(['cancelMkDir', 'allItemOrderUpdate', 'update:modelValue'])

const getSongListArr = async () => {
  let songListArr = []
  if (props.modelValue.name) {
    songListArr = await window.electron.ipcRenderer.invoke('querySonglist', props.modelValue.path)
  }
  emits('update:modelValue', { ...props.modelValue, songListArr: songListArr })
}
getSongListArr()
const myInputHandleInput = (e) => {
  if (operationInputValue.value == '') {
    inputHintText.value = '必须提供歌单或文件夹名。'
    inputHintShow.value = true
  } else {
    let exists = props.parentArr.some(obj => obj.name == operationInputValue.value)
    if (exists) {
      inputHintText.value = '此位置已存在歌单或文件夹' + operationInputValue.value + '。请选择其他名称'
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
  myInput.value.blur();
}

const inputKeyDownEsc = () => {
  operationInputValue.value = ''
  inputBlurHandle()
}

const inputHintText = ref('')
const inputBlurHandle = async () => {
  if (inputHintShow.value || operationInputValue.value == '') {
    if (props.parentArr[0]?.name == '') {
      emits('cancelMkDir')
    }
    operationInputValue.value = ''
    inputHintShow.value = false
    return
  }
  await window.electron.ipcRenderer.invoke('mkDir', {
    "type": "dir",
    "name": operationInputValue.value,
    "path": props.modelValue.path + '/' + operationInputValue.value,
    "order": 1
  }, props.modelValue.path)
  let dirItemJson = {
    ...props.modelValue
  }
  emits('allItemOrderUpdate')

  dirItemJson.name = operationInputValue.value
  dirItemJson.path = dirItemJson.path + '/' + operationInputValue.value
  dirItemJson.order = 1
  operationInputValue.value = ''
  emits('update:modelValue', dirItemJson)

}
let operationInputValue = ref('')


const inputHintShow = ref(false)

const myInput = ref(null)
if (props.modelValue.name == '') {
  nextTick(() => {
    myInput.value.focus()
  })
}

const menuButtonClick = async (item, e) => {
  if (item.name == '新建歌单') {

  } else if (item.name == '新建文件夹') {
    dirChildRendered.value = true
    dirChildShow.value = true
    let songListArr = props.modelValue.songListArr
    songListArr.unshift({
      "type": "dir",
      "name": "",
      "path": props.modelValue.path
    })
    emits('update:modelValue', {
      ...props.modelValue, songListArr: songListArr
    })
  } else if (item.name == '重命名') {
    renameDivShow.value = true
    renameDivValue.value = props.modelValue.name
    await nextTick()
    myRenameInput.value.focus()
  } else if (item.name == "删除") {
    confirmDialogShow.value = true
  }
}

const rightClickMenuShow = ref(false)
const clickEvent = ref({})
const menuArr = ref([[{ name: '新建歌单' }, { name: '新建文件夹' }], [{ name: '重命名' }, { name: '删除' }]])
const contextmenuEvent = (event) => {
  clickEvent.value = event
  rightClickMenuShow.value = true
}

const allItemOrderUpdate = () => {
  let songListArr = props.modelValue.songListArr
  for (let item of songListArr) {
    if (item.order) {
      item.order++
    }
  }
  emits('update:modelValue', { ...props.modelValue, songListArr: songListArr })
}
const dirChildShow = ref(false)
const dirChildRendered = ref(false)
const dirHandleClick = async () => {
  dirChildRendered.value = true
  dirChildShow.value = !dirChildShow.value
}
watch(() => runtime.collapseAllDirClicked, () => {
  if (runtime.collapseAllDirClicked) {
    dirChildShow.value = false
    runtime.collapseAllDirClicked = false
  }
})
const cancelMkDir = () => {
  let songListArr = props.modelValue.songListArr
  songListArr.shift()
  emits('update:modelValue', {
    ...props.modelValue,
    songListArr: songListArr
  })
}
//----重命名功能--------------------------------------
const renameDivShow = ref(false)
const renameDivValue = ref('')
const myRenameInput = ref(null)
const renameInputHintShow = ref(false)
const renameInputHintText = ref('')
const renameInputBlurHandle = async () => {
  if (renameInputHintShow.value || renameDivValue.value == '' || renameDivValue.value == props.modelValue.name) {
    renameDivValue.value = ''
    renameDivShow.value = false
    return
  }
  await window.electron.ipcRenderer.invoke('renameDir', renameDivValue.value, props.modelValue.path)

  emits('update:modelValue', {
    ...props.modelValue,
    name: renameDivValue.value,
    path: props.modelValue.path.replace(/(\/[^\/]+)$/, `/${renameDivValue.value}`)
  })
  renameDivValue.value = ''

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
  myRenameInput.value.blur();
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
    let exists = props.parentArr.some(obj => obj.name == renameDivValue.value)
    if (exists) {
      renameInputHintText.value = '此位置已存在歌单或文件夹' + renameDivValue.value + '。请选择其他名称'
      renameInputHintShow.value = true
    } else {
      renameInputHintShow.value = false
    }
  }
}

//----------------------------------------
//------删除功能
const confirmDialogShow = ref(false)
//todo
//-----------
</script>
<template>
  <div style="display: flex;cursor: pointer;" @contextmenu.stop="contextmenuEvent" @click.stop="dirHandleClick()"
    :class="{ 'rightClickBorder': rightClickMenuShow }">
    <div class="prefixIcon">
      <svg v-show="!dirChildShow" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"
        fill="currentColor">
        <path fill-rule="evenodd" clip-rule="evenodd"
          d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z" />
      </svg>
      <svg v-show="dirChildShow" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"
        fill="currentColor">
        <path fill-rule="evenodd" clip-rule="evenodd"
          d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" />
      </svg>
    </div>
    <div style="height:23px;flex-grow: 1;">
      <div v-if="props.modelValue.name && !renameDivShow" style="line-height: 23px;font-size: 13px;">{{
        props.modelValue.name }}</div>
      <div v-if="!props.modelValue.name">
        <input ref="myInput" v-model="operationInputValue" class="myInput"
          :class="{ 'myInputRedBorder': inputHintShow }" @blur="inputBlurHandle" @keydown.enter="inputKeyDownEnter"
          @keydown.esc="inputKeyDownEsc" @click.stop="() => { }" @contextmenu.stop="() => { }"
          @input="myInputHandleInput" />
        <div v-show="inputHintShow" class="myInputHint">
          <div>{{ inputHintText }}</div>
        </div>
      </div>
      <div v-if="renameDivShow">
        <input ref="myRenameInput" v-model="renameDivValue" class="myInput"
          :class="{ 'myInputRedBorder': renameInputHintShow }" @blur="renameInputBlurHandle"
          @keydown.enter="renameInputKeyDownEnter" @keydown.esc="renameInputKeyDownEsc" @click.stop="() => { }"
          @contextmenu.stop="() => { }" @input="renameMyInputHandleInput" />
        <div v-show="renameInputHintShow" class="myInputHint">
          <div>{{ renameInputHintText }}</div>
        </div>
      </div>
    </div>
  </div>
  <div v-if="dirChildRendered" v-show="dirChildShow" style="padding-left: 5px;">
    <template v-for="(item, index) of props.modelValue.songListArr" :key="item.name">
      <libraryDirItem v-if="item.type == 'dir'" v-model="props.modelValue.songListArr[index]"
        :parentArr="props.modelValue.songListArr" @cancelMkDir="cancelMkDir" @allItemOrderUpdate="allItemOrderUpdate" />
      <librarySonglistItem v-if="item.type == 'songList'" />
    </template>
  </div>
  <rightClickMenu v-model="rightClickMenuShow" :menuArr="menuArr" :clickEvent="clickEvent"
    @menuButtonClick="menuButtonClick"></rightClickMenu>
  <confirmDialog v-if="confirmDialogShow" />
</template>
<style lang="scss" scoped>
.rightClickBorder {
  border: 1px solid #0078d4;
}

.myInput {
  width: calc(100% - 6px);
  height: 19px;
  background-color: #313131;
  border: 1px solid #086bb7;
  outline: none;
  color: #cccccc
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
