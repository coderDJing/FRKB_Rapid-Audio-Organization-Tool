<script setup>
import { watch, ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils.js'

const runtime = useRuntimeStore()
let songInfoArr = ref([])
watch(() => runtime.selectedSongListUUID, async() => {
  let songListPath = libraryUtils.findDirPathByUuid(runtime.libraryTree, runtime.selectedSongListUUID)
  songInfoArr.value = await window.electron.ipcRenderer.invoke('scanSongList', songListPath)
})
</script>
<template>
  <div style="height: 100%;width: 100%;overflow-y: auto;">
    123
  </div>
</template>
