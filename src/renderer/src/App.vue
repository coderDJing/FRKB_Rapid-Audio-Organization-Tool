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
import emitter from './utils/mitt'
import { replaceExternalPlaylistFromPaths } from '@renderer/utils/externalPlaylist'

const runtime = useRuntimeStore()
// 使用全局设置中的平台标记进行映射，避免依赖 userAgent
{
  const p = runtime.setting?.platform
  runtime.platform = p === 'darwin' ? 'Mac' : p === 'win32' ? 'Windows' : 'Unknown'
}
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
  if (item === '第三方许可') item = 'menu.thirdPartyNotices'
  if (item === '访问 GitHub') item = 'menu.visitGithub'
  if (item === '访问官网') item = 'menu.visitWebsite'
  if (item === '检查更新') item = 'menu.checkUpdate'
  if (item === '更新日志') item = 'menu.whatsNew'
  if (item === '退出') item = 'menu.exit'
  if (item === '云同步设置') item = 'cloudSync.settings'
  if (item === '同步曲目指纹库') item = 'cloudSync.syncFingerprints'
  if (item === '手动添加曲目指纹') item = 'fingerprints.manualAdd'
  if (item === '导出曲目指纹库文件') item = 'fingerprints.exportDatabase'
  if (item === '导入曲目指纹库文件') item = 'fingerprints.importDatabase'

  if (item === 'menu.about') {
    const version = String((pkg as any).version || '')
    const isPrerelease = version.includes('-')
    const content: string[] = []
    content.push(t('update.currentVersion') + ' ' + version)
    if (isPrerelease) content.push(t('about.prereleaseHint'))
    content.push(t('about.author'))
    content.push(t('about.contact', { email: 'jinlingwuyanzu@qq.com' }))
    content.push(t('about.thirdPartyNoticesHint'))
    await confirm({
      title: t('menu.about'),
      content,
      confirmShow: false,
      canCopyText: true,
      innerHeight: 320
    })
  }
  if (item === 'menu.thirdPartyNotices') {
    window.electron.ipcRenderer.send(
      'openLocalBrowser',
      'https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/blob/main/THIRD_PARTY_NOTICES.md'
    )
    return
  }
  if (item === 'menu.visitGithub') {
    window.electron.ipcRenderer.send(
      'openLocalBrowser',
      'https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool'
    )
  }
  if (item === 'menu.visitWebsite') {
    window.electron.ipcRenderer.send(
      'openLocalBrowser',
      'https://coderDJing.github.io/FRKB_Rapid-Audio-Organization-Tool/'
    )
  }
  if (item === 'menu.checkUpdate') {
    window.electron.ipcRenderer.send('checkForUpdates')
    return
  }
  if (item === 'menu.whatsNew') {
    window.electron.ipcRenderer.send('showWhatsNew')
    return
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
  // F2/Enter 触发重命名（Windows: F2；Mac: Enter）
  const triggerRename = () => {
    try {
      if (runtime.selectSongListDialogShow) {
        const uuid = runtime.dialogSelectedSongListUUID
        if (uuid) emitter.emit('dialog/trigger-rename', uuid)
        return
      }
      const uuid = runtime.songsArea.songListUUID
      if (uuid) emitter.emit('libraryArea/trigger-rename', uuid)
    } catch {}
  }
  if (runtime.platform === 'Mac') {
    hotkeys('enter', 'windowGlobal', (e) => {
      e.preventDefault()
      triggerRename()
      return false
    })
  } else {
    hotkeys('f2', 'windowGlobal', (e) => {
      e.preventDefault()
      triggerRename()
      return false
    })
  }
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
  window.electron.ipcRenderer.on('external-open/imported', async (_e, payload) => {
    try {
      const rawPaths = Array.isArray(payload?.paths) ? payload.paths : []
      const songs = await replaceExternalPlaylistFromPaths(rawPaths)
      if (songs.length) {
        emitter.emit('external-open/play', { songs, startIndex: 0 })
      }
    } catch (error) {
      console.error('[external-open] failed to prepare playlist', error)
    }
  })
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
  window.electron.ipcRenderer.on('library-tree-updated', async (_e, tree) => {
    try {
      if (tree) {
        runtime.libraryTree = tree
        runtime.oldLibraryTree = JSON.parse(JSON.stringify(tree))
        return
      }
      await getLibrary()
    } catch (_err) {}
  })

  // 全局同步：当有 songsRemoved 事件触发时，若针对当前播放歌单，则同步清理播放列表快照
  emitter.on('songsRemoved', (payload: any) => {
    try {
      const paths: string[] = Array.isArray(payload?.paths) ? payload.paths : []
      const listUUID: string | undefined = payload?.listUUID
      if (!paths.length) return
      if (listUUID && listUUID !== runtime.playingData.playingSongListUUID) return

      // 过滤当前播放列表数据中的已删除项
      runtime.playingData.playingSongListData = (
        runtime.playingData.playingSongListData || []
      ).filter((s: any) => !paths.includes(s.filePath))

      // 若当前播放的歌曲被删除，清空当前播放
      if (
        runtime.playingData.playingSong &&
        paths.includes(runtime.playingData.playingSong.filePath)
      ) {
        runtime.playingData.playingSong = null
      }
    } catch {}
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
</script>
<template>
  <div style="height: 100%; max-height: 100%; width: 100%; display: flex; flex-direction: column">
    <div style="height: 35px">
      <titleComponent @open-dialog="openDialog" />
    </div>
    <div style="flex: 1 1 auto; min-height: 0">
      <homePage />
    </div>
    <div
      style="
        width: 100%;
        background-color: var(--bg);
        border-top: 1px solid var(--border);
        box-sizing: border-box;
      "
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
  color: var(--text);
  background-color: var(--bg);
  width: 100%;
  height: 100vh;
  overflow: hidden;
}

body {
  margin: 0px;
  background-color: var(--bg-elev);
  overflow: hidden;
}
</style>
