<script setup>
import homePage from "./pages/homePage.vue"
import titleComponent from './components/titleComponent.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import scanNewSongDialog from "./components/scanNewSongDialog.vue";
import { ref } from 'vue'

const runtime = useRuntimeStore()
window.electron.ipcRenderer.on('layoutConfigReaded', (event, layoutConfig) => {
  runtime.layoutConfig = layoutConfig
})

const activeDialog = ref('')
const openDialog = (item) => {
  activeDialog.value = item
}
const documentHandleClick = () => {
  runtime.activeMenuUUID = ''
}
document.addEventListener('click', documentHandleClick)
document.addEventListener('contextmenu', documentHandleClick)

</script>
<template>
  <div style="height: 100%;width: 100%;display: flex;flex-direction: column;">
    <div>
      <titleComponent @openDialog="openDialog" />
    </div>
    <div style="flex-grow: 1;">
      <homePage />
    </div>
  </div>
  <scanNewSongDialog v-if="activeDialog == '导入新歌曲'" @cancel="activeDialog = ''"></scanNewSongDialog>
</template>
<style lang="scss">
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: #cccccc;
  background-color: #1f1f1f;
  width: 100vw;
  height: 100vh;
}

body {
  margin: 0px;
  background-color: #1f1f1f;
}
</style>
