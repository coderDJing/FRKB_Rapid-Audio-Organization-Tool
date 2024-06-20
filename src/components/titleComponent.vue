<script setup>
import chromeMaximize from '@/assets/chrome-maximize.svg'
import chromeRestore from '@/assets/chrome-restore.svg'
import chromeMiniimize from '@/assets/chrome-minimize.svg'
import { useRuntimeStore } from '@/stores/runtime'
import { ref } from 'Vue'

const toggleMaximize = () => {
    window.electronAPI.send('toggle-maximize');
}

const toggleMinimize = () => {
    window.electronAPI.send('toggle-minimize');
}

const toggleClose = () => {
    window.electronAPI.send('toggle-close');
}
const runtime = useRuntimeStore()

window.electronAPI.receive('mainWin-max', (bool) => {
    runtime.isWindowMaximized = bool
})

const fillColor = ref('#9d9d9d')
</script>
<template>
    <div class="title unselectable">Better Music Library</div>
    <div class="titleComponent unselectable">
        <div style="z-index: 1">
            123123123
        </div>
        <div class="canDrag" style="flex-grow: 1;height:35px;z-index: 1;">
        </div>
        <div style="display: flex;z-index: 1;">
            <div class="rightIcon" @click="toggleMinimize()">
                <img :src="chromeMiniimize">
            </div>
            <div class="rightIcon" @click="toggleMaximize()">
                <img :src="runtime.isWindowMaximized ? chromeRestore : chromeMaximize">
            </div>
            <div class="rightIcon closeIcon" @mouseover="fillColor = '#ffffff'" @mouseout="fillColor = '#9d9d9d'"
                @click="toggleClose()">
                <svg width="15" height="15" viewBox="0 0 15 15" xmlns="http://www.w3.org/2000/svg" :fill="fillColor">
                    <path fill-rule="evenodd" clip-rule="evenodd"
                        d="M7.116 8l-4.558 4.558.884.884L8 8.884l4.558 4.558.884-.884L8.884 8l4.558-4.558-.884-.884L8 7.116 3.442 2.558l-.884.884L7.116 8z" />
                </svg>
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