<script setup>
import chromeClose from '@/assets/chrome-close.svg'
import chromeMaximize from '@/assets/chrome-maximize.svg'
import chromeRestore from '@/assets/chrome-restore.svg'
import chromeMiniimize from '@/assets/chrome-minimize.svg'
// import { toggleMaximize } from '@/renderer.js'

// const dragArea = ref()
// toggleMaximize(dragArea)
//todo webpack换成vite
</script>
<template>
    <div class="title unselectable">Better Music Library</div>
    <div class="titleComponent unselectable">
        <div style="z-index: 1">
            123123123
        </div>
        <div ref="dragArea" class="canDrag" style="flex-grow: 1;height:35px"></div>
        <div style="display: flex;z-index: 1;">
            <div class="rightIcon">
                <img :src="chromeMiniimize">
            </div>
            <div class="rightIcon" v-show="false">
                <img :src="chromeRestore">
            </div>
            <div class="rightIcon">
                <img :src="chromeMaximize">
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