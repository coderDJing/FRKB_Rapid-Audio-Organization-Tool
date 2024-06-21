<script setup>
import librarySelectArea from './modules/librarySelectArea.vue';
import libraryArea from './modules/libraryArea.vue';
import { useRuntimeStore } from '@renderer/stores/runtime'
import { onUnmounted } from 'vue'
const runtime = useRuntimeStore()
let startX = 0;
let isResizing = false;

function startResize(e) {
    isResizing = true;
    startX = e.clientX;
    document.addEventListener('mousemove', resize);
    document.addEventListener('mouseup', stopResize);
}

function resize(e) {
    if (!isResizing) return;
    const deltaX = e.clientX - startX;
    const newWidth = Math.max(50, runtime.layoutConfig.libraryAreaWidth + deltaX); // 设置最小宽度
    if (newWidth != 50) {
        runtime.layoutConfig.libraryAreaWidth = newWidth;
        startX = e.clientX;
    }
}

function stopResize() {
    isResizing = false;
    document.removeEventListener('mousemove', resize);
    document.removeEventListener('mouseup', stopResize);
    window.electron.ipcRenderer.send('layoutConfigChanged', JSON.stringify(runtime.layoutConfig));
}

onUnmounted(() => {
    // 如果需要，可以在这里添加组件卸载时的清理逻辑
    document.removeEventListener('mousemove', resize);
    document.removeEventListener('mouseup', stopResize);
});
</script>
<template>
    <div style="display: flex;height: 100%">
        <librarySelectArea></librarySelectArea>

        <div style="width: 200px;border-right: 1px solid #2b2b2b;"
            :style="'width:' + runtime.layoutConfig.libraryAreaWidth + 'px'">
            <libraryArea></libraryArea>
        </div>
        <div style="width:4px;cursor:ew-resize;height: calc(100vh - 35px);" @mousedown="startResize"></div>
        <div style="flex-grow: 1;"></div>
    </div>
</template>