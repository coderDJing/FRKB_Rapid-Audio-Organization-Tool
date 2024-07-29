<script setup>
import homePage from './pages/homePage.vue'
import titleComponent from './components/titleComponent.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import scanNewSongDialog from './components/scanNewSongDialog.vue'
import bottomInfoArea from './pages/modules/bottomInfoArea.vue'
import manualAddSongFingerprintDialog from './components/manualAddSongFingerprintDialog.vue'
import { ref } from 'vue'

const runtime = useRuntimeStore()

const detectPlatform = () => {
  const userAgent = navigator.userAgent || navigator.vendor || window.opera
  if (/Mac/i.test(userAgent)) {
    return 'Mac'
  } else if (/Windows/i.test(userAgent)) {
    return 'Windows'
  } else if (/Linux/i.test(userAgent)) {
    return 'Linux'
  }
}
runtime.platform = detectPlatform()
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

const getLibrary = async () => {
  runtime.libraryTree = await window.electron.ipcRenderer.invoke('getLibrary')
}
getLibrary()
</script>
<template>
  <div style="height: 100%; max-height: 100%; width: 100%; display: flex; flex-direction: column">
    <div style="height: 35px">
      <titleComponent @openDialog="openDialog" />
    </div>
    <div style="height: calc(100% - 55px)">
      <homePage />
    </div>
    <div
      style="height: 20px; width: 100%; background-color: #181818; border-top: 1px solid #2b2b2b"
    >
      <bottomInfoArea />
    </div>
  </div>
  <scanNewSongDialog
    v-if="activeDialog == '导入新曲目'"
    @cancel="activeDialog = ''"
  ></scanNewSongDialog>
  <manualAddSongFingerprintDialog
    v-if="activeDialog == '手动添加曲目指纹'"
    @cancel="activeDialog = ''"
  />
</template>
<style lang="scss">
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: #cccccc;
  background-color: #181818;
  width: 100vw;
  height: 100vh;
}

body {
  margin: 0px;
  background-color: #1f1f1f;
}
</style>
