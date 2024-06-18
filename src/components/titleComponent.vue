<script setup>
import chromeClose from '@/assets/chrome-close.svg'
import chromeMaximize from '@/assets/chrome-maximize.svg'
import chromeRestore from '@/assets/chrome-restore.svg'
import chromeMiniimize from '@/assets/chrome-minimize.svg'
import { useRuntimeStore } from '@/stores/runtime'
import { ref } from 'vue';

const toggleMaximize = () => {
    window.electronAPI.send('toggle-maximize');
}
const runtime = useRuntimeStore()

window.electronAPI.receive('mainWin-max', (bool) => {
    runtime.isWindowMaximized = bool
})

const draggableDiv = ref(null);
let isDragging = false;
let XY = {}
const startDrag = () => {
    if(runtime.isWindowMaximized){
        return
    }
    isDragging = true;
    window.electronAPI.send('window-start')
};
window.electronAPI.receive('window-startRecive', (data) => {
    XY = data
})

const drag = (event) => {
    if (!isDragging) return;
    event.preventDefault();

    const params = {
        x: event.screenX - XY.x,
        y: event.screenY - XY.y,
    };

    window.electronAPI.send('window-move', params);
};

const stopDrag = () => {
    isDragging = false;
};

</script>
<template>
    <div class="title unselectable">Better Music Library</div>
    <div class="titleComponent unselectable">
        <div style="z-index: 1">
            123123123
        </div>

        <div ref="draggableDiv" style="flex-grow: 1;height:35px;z-index: 1;" @dblclick="toggleMaximize()"
            @mousedown="startDrag" @mousemove="drag" @mouseup="stopDrag" @mouseleave="stopDrag">
        </div>
        <div style="display: flex;z-index: 1;">
            <div class="rightIcon">
                <img :src="chromeMiniimize">
            </div>
            <div class="rightIcon" @click="toggleMaximize()">
                <img :src="runtime.isWindowMaximized ? chromeRestore : chromeMaximize">
            </div>
            <div class="rightIcon closeIcon">
                <img :src="chromeClose">
            </div>
        </div>
    </div>
</template>
<style lang="scss" scoped>
.title {
    position: absolute;
    width: 100%;
    height: 35px;
    display: flex;
    justify-content: center;
    align-items: center;
    background-color: #2a2a2a;
    z-index: 0;
    font-size: 13px;
}

.titleComponent {
    width: 100vw;
    height: 35px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
    box-sizing: border-box;

    .rightIcon {
        width: 47px;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 35px;
        transition: background-color 0.15s ease;

    }

    .rightIcon:hover {
        background-color: #373737;
    }

    .closeIcon:hover {
        background-color: #e81123;
    }
}
</style>