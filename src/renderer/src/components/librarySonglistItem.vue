<script setup>
import { ref, nextTick, watch } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu.vue';
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirmDialog from '@renderer/components/confirmDialog.vue';
import listIcon from '@renderer/assets/listIcon.png'
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
const emits = defineEmits(['cancelMkDir', 'allItemOrderUpdate', 'update:modelValue', 'dirDeleted'])

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
        "type": "songList",
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
    if (item.name == '重命名') {
        renameDivShow.value = true
        renameDivValue.value = props.modelValue.name
        await nextTick()
        myRenameInput.value.focus()
    } else if (item.name == "删除") {
        confirmDialogContent.value = ['确认删除此歌单吗？', '歌单中的歌曲将一并被删除', '"' + props.modelValue.name + '"']
        confirmDialogShow.value = true
    }
}

const rightClickMenuShow = ref(false)
const clickEvent = ref({})
const menuArr = ref([[{ name: '重命名' }, { name: '删除' }]])
const contextmenuEvent = (event) => {
    clickEvent.value = event
    rightClickMenuShow.value = true
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
//------删除功能-------------------------
const confirmDialogShow = ref(false)
const confirmDialogContent = ref([])
const deleteConfirm = async () => {
    const path = props.modelValue.path
    await window.electron.ipcRenderer.invoke('delDir', path)
    emits('dirDeleted', props.modelValue)
    deleteCancel()
}
const deleteCancel = () => {
    confirmDialogContent.value = []
    confirmDialogShow.value = false
}


//------------------------------------
</script>
<template>
    <div style="display: flex;cursor: pointer;" @contextmenu.stop="contextmenuEvent" @click.stop="dirHandleClick()"
        :class="{ 'rightClickBorder': rightClickMenuShow }">
        <div class="prefixIcon">
            <img style="width: 13px;height: 13px;" :src="listIcon" />
        </div>
        <div style="height:23px;flex-grow: 1;">
            <div v-if="props.modelValue.name && !renameDivShow" style="line-height: 23px;font-size: 13px;">{{
                props.modelValue.name }}</div>
            <div v-if="!props.modelValue.name">
                <input ref="myInput" v-model="operationInputValue" class="myInput"
                    :class="{ 'myInputRedBorder': inputHintShow }" @blur="inputBlurHandle"
                    @keydown.enter="inputKeyDownEnter" @keydown.esc="inputKeyDownEsc" @click.stop="() => { }"
                    @contextmenu.stop="() => { }" @input="myInputHandleInput" />
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

    <rightClickMenu v-model="rightClickMenuShow" :menuArr="menuArr" :clickEvent="clickEvent"
        @menuButtonClick="menuButtonClick"></rightClickMenu>
    <confirmDialog v-if="confirmDialogShow" title="删除" :content="confirmDialogContent" @confirm="deleteConfirm"
        @cancel="deleteCancel" />
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
