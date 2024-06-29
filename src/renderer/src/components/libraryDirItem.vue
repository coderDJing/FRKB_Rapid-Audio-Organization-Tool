<script setup>
import { ref, nextTick } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu.vue';
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

let inputHintText = ref('')
const inputBlurHandle = async () => {
    if (inputHintShow.value || (operationInputValue.value == '')) {
        emits('cancelMkDir')

        operationInputValue.value = ''
        inputHintShow.value = false
        return
    }
    inputHintShow.value = false
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
    if (item.name == '新建文件夹') {
        //新建文件夹之前肯定得先知道文件夹下的结构情况
        console.log(9999)
    }
}

const rightClickMenuShow = ref(false)
const clickEvent = ref({})
const menuArr = ref([[{ name: '新建歌单' }, { name: '新建文件夹' }], [{ name: '重命名' }, { name: '删除' }]])
const contextmenuEvent = (event) => {
    clickEvent.value = event
    rightClickMenuShow.value = true
}
</script>
<template>
    <div style="display: flex;cursor: pointer;" @contextmenu.stop="contextmenuEvent">
        <div class="prefixIcon">
            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                <path fill-rule="evenodd" clip-rule="evenodd"
                    d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z" />
            </svg>
            <!-- <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                                    <path fill-rule="evenodd" clip-rule="evenodd"
                                        d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" />
                                </svg> -->
        </div>
        <div style="height:23px;flex-grow: 1;">
            <div v-if="props.modelValue.name" style="line-height: 23px;font-size: 13px;">{{ props.modelValue.name }}</div>
            <div v-else>
                <input ref="myInput" v-model="operationInputValue" class="myInput"
                    :class="{ 'myInputRedBorder': inputHintShow }" @blur="inputBlurHandle"
                    @keydown.enter="inputKeyDownEnter" @keydown.esc="inputKeyDownEsc" @click.stop="() => { }"
                    @contextmenu.stop="() => { }" @input="myInputHandleInput" />
                <div v-show="inputHintShow" class="myInputHint">
                    <div>{{ inputHintText }}</div>
                </div>
            </div>
        </div>
    </div>
    <rightClickMenu v-model="rightClickMenuShow" :menuArr="menuArr" :clickEvent="clickEvent"
        @menuButtonClick="menuButtonClick"></rightClickMenu>
</template>
<style lang="scss" scoped>
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