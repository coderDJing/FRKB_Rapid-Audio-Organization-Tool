<script setup>
import homePage from './pages/homePage.vue'
import titleComponent from './components/titleComponent.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import scanNewSongDialog from './components/scanNewSongDialog.vue'
import bottomInfoArea from './pages/modules/bottomInfoArea.vue'
import manualAddSongFingerprintDialog from './components/manualAddSongFingerprintDialog.vue'
import { onMounted, ref } from 'vue'
import hotkeys from 'hotkeys-js'
import utils from './utils/utils'
import exportSongFingerprintDialog from './components/exportSongFingerprintDialog.vue'
import importSongFingerprintDialog from './components/importSongFingerprintDialog.vue'
import confirm from '@renderer/components/confirmDialog.js'

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
const scanNewSongDialogLibraryName = ref('')
const activeDialog = ref('')

const openDialog = async (item) => {
  if (item === '筛选库 导入新曲目') {
    scanNewSongDialogLibraryName.value = '筛选库'
  } else if (item === '精选库 导入新曲目') {
    scanNewSongDialogLibraryName.value = '精选库'
  }
  if (item === '退出') {
    if (runtime.isProgressing === true) {
      await confirm({
        title: '退出',
        content: ['请等待当前任务执行结束'],
        confirmShow: false
      })
      return
    } else {
      window.electron.ipcRenderer.send('toggle-close')
    }
  }
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
onMounted(() => {
  hotkeys('alt+q', 'windowGlobal', () => {
    openDialog('筛选库 导入新曲目')
  })
  hotkeys('alt+e', 'windowGlobal', () => {
    openDialog('精选库 导入新曲目')
  })
  hotkeys('alt+F4', async () => {
    if (runtime.isProgressing === true) {
      await confirm({
        title: '退出',
        content: ['请等待当前任务执行结束'],
        confirmShow: false
      })
    } else {
      window.electron.ipcRenderer.send('toggle-close')
    }
    return false
  })
  hotkeys('esc', () => {
    runtime.activeMenuUUID = ''
  })
  utils.setHotkeysScpoe(runtime.hotkeysScopesHeap, 'windowGlobal')
})
window.electron.ipcRenderer.on('mainWindowBlur', async (event) => {
  runtime.activeMenuUUID = ''
})
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
    v-if="activeDialog == '筛选库 导入新曲目' || activeDialog == '精选库 导入新曲目'"
    @cancel="activeDialog = ''"
    :libraryName="scanNewSongDialogLibraryName"
  ></scanNewSongDialog>
  <manualAddSongFingerprintDialog
    v-if="activeDialog == '手动添加曲目指纹'"
    @cancel="activeDialog = ''"
  />
  <exportSongFingerprintDialog
    v-if="activeDialog == '导出曲目指纹库文件'"
    @cancel="activeDialog = ''"
  />
  <importSongFingerprintDialog
    v-if="activeDialog == '导入曲目指纹库文件'"
    @cancel="activeDialog = ''"
  />
  <!-- todo 导出迁移文件 -->
  <!-- todo 导入迁移文件 -->
  <!-- todo 使用说明 -->
  <!-- todo 关于 -->
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
