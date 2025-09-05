<script setup lang="ts">
import homePage from './pages/homePage.vue'
import titleComponent from './components/titleComponent.vue'
import scanNewSongDialog from '@renderer/components/scanNewSongDialog'
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
import FileOpInterruptedDialog from './components/fileOpInterruptedDialog.vue'

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
const fileOpDialogVisible = ref(false)
const fileOpContext = ref('')
const fileOpDone = ref(0)
const fileOpRunning = ref(0)
const fileOpPending = ref(0)
const fileOpBatchId = ref('')
const fileOpSuccessSoFar = ref(0)
const fileOpFailedSoFar = ref(0)

const sendFileOpControl = (action: 'resume' | 'cancel') => {
  fileOpDialogVisible.value = false
  ;(window as any).electron.ipcRenderer.send('file-op-control', {
    batchId: fileOpBatchId.value,
    action
  })
}

const openDialog = async (item: string) => {
  // 统一将中文项映射为 i18n 键，避免不同语言下判断不一致
  if (item === '关于') item = 'menu.about'
  if (item === '访问 GitHub') item = 'menu.visitGithub'
  if (item === '检查更新') item = 'menu.checkUpdate'
  if (item === '退出') item = 'menu.exit'
  if (item === '云同步设置') item = 'cloudSync.settings'
  if (item === '同步曲目指纹库') item = 'cloudSync.syncFingerprints'
  if (item === '手动添加曲目指纹') item = 'fingerprints.manualAdd'
  if (item === '导出曲目指纹库文件') item = 'fingerprints.exportDatabase'
  if (item === '导入曲目指纹库文件') item = 'fingerprints.importDatabase'

  if (item === 'menu.about') {
    await confirm({
      title: t('menu.about'),
      content: [
        t('update.currentVersion') + ' ' + (pkg as any).version,
        t('about.author'),
        t('about.contact', { email: 'jinlingwuyanzu@qq.com' })
      ],
      confirmShow: false,
      canCopyText: true
    })
  }
  if (item === 'menu.visitGithub') {
    window.electron.ipcRenderer.send(
      'openLocalBrowser',
      'https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool'
    )
  }
  if (item === 'menu.checkUpdate') {
    window.electron.ipcRenderer.send('checkForUpdates')
  }
  if (item === 'menu.exit') {
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
  if (item === 'cloudSync.settings') {
    activeDialog.value = item
    return
  }
  if (item === 'cloudSync.syncFingerprints') {
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
  // 通过 Tray 菜单触发
  window.electron.ipcRenderer.on('openDialogFromTray', async (_e, key: string) => {
    await openDialog(key)
  })
  window.electron.ipcRenderer.on('tray-action', async (_e, action: string) => {
    if (action === 'import-new-filter') {
      await scanNewSongDialog({ libraryName: 'FilterLibrary', songListUuid: '' })
      return
    }
    if (action === 'import-new-curated') {
      await scanNewSongDialog({ libraryName: 'CuratedLibrary', songListUuid: '' })
      return
    }
    if (action === 'exit') {
      if (runtime.isProgressing === true) {
        await confirm({
          title: t('common.exit'),
          content: [t('import.waitForTask')],
          confirmShow: false
        })
        return
      }
      window.electron.ipcRenderer.send('toggle-close')
      return
    }
  })
  // 不再显示“结束后的汇总提示”
  // 监听批处理被中断（等待用户选择 继续/取消）
  window.electron.ipcRenderer.on('file-op-interrupted', async (_e, payload) => {
    try {
      fileOpDialogVisible.value = true
      fileOpContext.value = payload?.context || ''
      fileOpSuccessSoFar.value = payload?.successSoFar || 0
      fileOpFailedSoFar.value = payload?.failedSoFar || 0
      fileOpDone.value = fileOpSuccessSoFar.value + fileOpFailedSoFar.value
      fileOpRunning.value = payload?.running || 0
      fileOpPending.value = payload?.pending || 0
      fileOpBatchId.value = payload?.batchId || ''
    } catch (_err) {}
  })
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
    ?.find((item) => item.dirName === 'RecycleBin')
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
    v-if="activeDialog == 'fingerprints.manualAdd'"
    @cancel="activeDialog = ''"
  />
  <exportSongFingerprintDialog
    v-if="activeDialog == 'fingerprints.exportDatabase'"
    @cancel="activeDialog = ''"
  />
  <importSongFingerprintDialog
    v-if="activeDialog == 'fingerprints.importDatabase'"
    @cancel="activeDialog = ''"
  />
  <cloudSyncSettingsDialog
    v-if="activeDialog == 'cloudSync.settings'"
    @cancel="activeDialog = ''"
  />
  <cloudSyncSyncDialog
    v-if="activeDialog == 'cloudSync.syncFingerprints'"
    @cancel="activeDialog = ''"
  />
  <FileOpInterruptedDialog
    :visible="fileOpDialogVisible"
    :context="fileOpContext"
    :done="fileOpDone"
    :running="fileOpRunning"
    :pending="fileOpPending"
    :success-so-far="fileOpSuccessSoFar"
    :failed-so-far="fileOpFailedSoFar"
    @resume="sendFileOpControl('resume')"
    @cancel="sendFileOpControl('cancel')"
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
