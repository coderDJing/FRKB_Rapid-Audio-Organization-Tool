<script setup lang="ts">
import homePage from './pages/homePage.vue'
import titleComponent from './components/titleComponent.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import bottomInfoArea from './pages/modules/bottomInfoArea.vue'
import manualAddSongFingerprintDialog from './components/manualAddSongFingerprintDialog.vue'
import { onMounted, ref } from 'vue'
import hotkeys from 'hotkeys-js'
import utils from './utils/utils'
import exportSongFingerprintDialog from './components/exportSongFingerprintDialog.vue'
import importSongFingerprintDialog from './components/importSongFingerprintDialog.vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import pkg from '../../../package.json?asset'
import cloudSyncSettingsDialog from './components/cloudSyncSettingsDialog.vue'
import cloudSyncSyncDialog from './components/cloudSyncSyncDialog.vue'

const runtime = useRuntimeStore()

const detectPlatform = () => {
  const userAgent = navigator.userAgent
  if (/Mac/i.test(userAgent)) {
    return 'Mac'
  } else if (/Windows/i.test(userAgent)) {
    return 'Windows'
  } else if (/Linux/i.test(userAgent)) {
    return 'Linux'
  } else {
    return 'Unknown'
  }
}
runtime.platform = detectPlatform()
window.electron.ipcRenderer.on('layoutConfigReaded', (event, layoutConfig) => {
  runtime.layoutConfig = layoutConfig
})
const activeDialog = ref('')

const openDialog = async (item: string) => {
  if (item === '关于' || item === 'menu.about') {
    await confirm({
      title: t('menu.about'),
      content: [
        t('update.currentVersion') + ' ' + (pkg as any).version,
        t('about.author'),
        t('about.contact')
      ],
      confirmShow: false,
      canCopyText: true
    })
  }
  if (item === '访问 GitHub' || item === 'menu.visitGithub') {
    window.electron.ipcRenderer.send(
      'openLocalBrowser',
      'https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool'
    )
  }
  if (item === '检查更新' || item === 'menu.checkUpdate') {
    window.electron.ipcRenderer.send('checkForUpdates')
  }
  if (item === '退出' || item === 'menu.exit') {
    if (runtime.isProgressing === true) {
      await confirm({
        title: t('common.exit'),
        content: [t('import.waitForTask')],
        confirmShow: false
      })
      return
    } else {
      window.electron.ipcRenderer.send('toggle-close')
    }
  }
  if (item === '云同步设置' || item === 'cloudSync.settings') {
    activeDialog.value = item
    return
  }
  if (item === '同步曲目指纹库' || item === 'cloudSync.syncFingerprints') {
    activeDialog.value = item
    return
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
  runtime.oldLibraryTree = JSON.parse(JSON.stringify(runtime.libraryTree))
}
getLibrary()
onMounted(() => {
  hotkeys('F1', 'windowGlobal', () => {
    openDialog('menu.visitGithub')
  })

  const handleAltF4 = async () => {
    if (runtime.isProgressing === true) {
      await confirm({
        title: t('common.exit'),
        content: [t('import.waitForTask')],
        confirmShow: false
      })
    } else {
      window.electron.ipcRenderer.send('toggle-close')
    }
  }
  hotkeys('command+q', () => {
    handleAltF4()
    return false
  })
  hotkeys('alt+F4', () => {
    handleAltF4()
    return false
  })
  hotkeys('esc', () => {
    runtime.activeMenuUUID = ''
  })
  utils.setHotkeysScpoe('windowGlobal')
})
// 供子组件触发打开对话框（例如同步面板引导打开设置）
window.addEventListener('openDialogFromChild', (e: any) => {
  const detail = e?.detail
  if (typeof detail === 'string') {
    openDialog(detail)
  }
})
// 云同步状态驱动全局进行中标记，禁用指纹库相关操作
window.electron.ipcRenderer.on('cloudSync/state', (_e, state) => {
  if (state === 'syncing') runtime.isProgressing = true
  if (state === 'success' || state === 'failed' || state === 'cancelled')
    runtime.isProgressing = false
})
window.electron.ipcRenderer.on('mainWindowBlur', async (_event) => {
  runtime.activeMenuUUID = ''
})
window.electron.ipcRenderer.on('delSongsSuccess', (_event, recycleBinNewDirDescriptionJson) => {
  runtime.libraryTree.children
    ?.find((item) => item.dirName === '回收站')
    ?.children?.push(recycleBinNewDirDescriptionJson)
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
  <cloudSyncSettingsDialog v-if="activeDialog == '云同步设置'" @cancel="activeDialog = ''" />
  <cloudSyncSyncDialog v-if="activeDialog == '同步曲目指纹库'" @cancel="activeDialog = ''" />
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
