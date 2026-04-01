<script setup lang="ts">
import homePage from './pages/homePage.vue'
import titleComponent from './components/titleComponent.vue'
import scanNewSongDialog from '@renderer/components/scanNewSongDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import bottomInfoArea from './pages/modules/bottomInfoArea.vue'
import manualAddSongFingerprintDialog from './components/manualAddSongFingerprintDialog.vue'
import globalSongSearchDialog from './components/globalSongSearchDialog.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
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
import { createClickThroughGuard } from '@renderer/utils/clickThroughGuard'

const runtime = useRuntimeStore()
const contextMenuClickThroughGuard = createClickThroughGuard()
const CONTEXT_MENU_SELECTOR = '[data-frkb-context-menu="true"]'
// 运行期平台展示优先取持久化设置，避免依赖不稳定的 userAgent
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
const CTRL_DOUBLE_TAP_MS = 260
const horizontalModeTopSpacerHeight = 180
const showHorizontalModeTopSpacer = computed(() => runtime.mainWindowBrowseMode === 'horizontal')
const horizontalModeTopSpacerStyle = computed(() => ({
  height: `${horizontalModeTopSpacerHeight}px`,
  flex: `0 0 ${horizontalModeTopSpacerHeight}px`,
  backgroundColor: 'var(--bg)',
  borderBottom: '1px solid var(--border)',
  boxSizing: 'border-box' as const
}))

type CoreLibraryName = 'FilterLibrary' | 'CuratedLibrary' | 'MixtapeLibrary' | 'RecycleBin'
type GlobalSongSearchItem = {
  id: string
  filePath: string
  fileName: string
  title: string
  artist: string
  album: string
  genre: string
  label: string
  duration: string
  keyText: string
  bpm?: number
  container: string
  songListUUID: string
  songListName: string
  songListPath: string
  libraryName: CoreLibraryName
  score: number
}

let ctrlTapAt = 0
let ctrlDown = false
let ctrlComboDirty = false

const normalizePath = (value: string) =>
  String(value || '')
    .replace(/\//g, '\\')
    .toLowerCase()
const markSongSearchDirty = (reason: string) => {
  void window.electron.ipcRenderer.invoke('song-search:mark-dirty', { reason }).catch(() => {})
}

const focusSongFromGlobalSearch = async (
  payload: GlobalSongSearchItem,
  autoPlay: boolean,
  flashLocate = false
) => {
  if (
    payload.libraryName === 'FilterLibrary' ||
    payload.libraryName === 'CuratedLibrary' ||
    payload.libraryName === 'MixtapeLibrary'
  ) {
    runtime.lastSongListUUIDByLibrary[payload.libraryName] = payload.songListUUID
  }
  runtime.libraryAreaSelected = payload.libraryName
  if (runtime.songsArea.songListUUID !== payload.songListUUID) {
    runtime.songsArea.songListUUID = payload.songListUUID
  }
  emitter.emit('songsArea/focus-song', {
    songListUUID: payload.songListUUID,
    filePath: payload.filePath,
    autoPlay,
    flash: flashLocate
  })
}

const isEditableElement = (target: EventTarget | null) => {
  const element = target as HTMLElement | null
  if (!element) return false
  const tagName = element.tagName?.toLowerCase() || ''
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true
  return Boolean(element.closest('[contenteditable="true"]'))
}

const handleCtrlDoubleTapKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Control') {
    if (event.repeat) return
    ctrlDown = true
    ctrlComboDirty = false
    return
  }
  if (ctrlDown) {
    ctrlComboDirty = true
  }
}

const handleCtrlDoubleTapKeyUp = (event: KeyboardEvent) => {
  if (event.key !== 'Control') return
  if (!ctrlDown) return
  ctrlDown = false
  if (ctrlComboDirty) {
    ctrlTapAt = 0
    ctrlComboDirty = false
    return
  }
  if (isEditableElement(event.target) || runtime.confirmShow) {
    ctrlTapAt = 0
    ctrlComboDirty = false
    return
  }
  const now = Date.now()
  if (now - ctrlTapAt <= CTRL_DOUBLE_TAP_MS) {
    ctrlTapAt = 0
    void openDialog('menu.globalSongSearch')
  } else {
    ctrlTapAt = now
  }
  ctrlComboDirty = false
}

const handleSongsRemovedForGlobalSearch = (payload: any) => {
  try {
    const itemIds: string[] = Array.isArray(payload?.itemIds) ? payload.itemIds : []
    const listUUID: string | undefined = payload?.listUUID
    if (itemIds.length > 0) {
      if (listUUID && listUUID !== runtime.playingData.playingSongListUUID) return
      const idSet = new Set(itemIds)

      runtime.playingData.playingSongListData = (
        runtime.playingData.playingSongListData || []
      ).filter((song: any) => !idSet.has(song?.mixtapeItemId || ''))

      if (
        runtime.playingData.playingSong &&
        idSet.has(runtime.playingData.playingSong.mixtapeItemId || '')
      ) {
        runtime.playingData.playingSong = null
      }

      markSongSearchDirty('mixtape-items-removed')
      return
    }

    const paths: string[] = Array.isArray(payload?.paths) ? payload.paths : []
    if (!paths.length) return
    if (listUUID && listUUID !== runtime.playingData.playingSongListUUID) return
    const normalizedSet = new Set(paths.map((p) => normalizePath(p)).filter(Boolean))

    runtime.playingData.playingSongListData = (
      runtime.playingData.playingSongListData || []
    ).filter((song: any) => !normalizedSet.has(normalizePath(song.filePath)))

    if (
      runtime.playingData.playingSong &&
      normalizedSet.has(normalizePath(runtime.playingData.playingSong.filePath))
    ) {
      runtime.playingData.playingSong = null
    }

    markSongSearchDirty('songs-removed')
  } catch {}
}
const handleMixtapeItemsRemoved = (_e: unknown, payload: any) => {
  const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId.trim() : ''
  const itemIds = Array.isArray(payload?.itemIds) ? payload.itemIds : []
  const removedPaths = Array.isArray(payload?.removedPaths) ? payload.removedPaths : []
  if (!playlistId || (!itemIds.length && !removedPaths.length)) return
  emitter.emit('playlistContentChanged', { uuids: [playlistId] })
  emitter.emit('songsRemoved', {
    listUUID: playlistId,
    itemIds,
    paths: removedPaths
  })
}

const handleMetadataBatchUpdatedForGlobalSearch = () => {
  markSongSearchDirty('metadata-batch-updated')
}

const handleSongMetadataUpdatedForGlobalSearch = () => {
  markSongSearchDirty('song-metadata-updated')
}

const sendFileOpControl = (action: 'resume' | 'cancel') => {
  fileOpDialogVisible.value = false
  ;(window as any).electron.ipcRenderer.send('file-op-control', {
    batchId: fileOpBatchId.value,
    action
  })
}

const openDialog = async (item: string) => {
  // 兼容旧的中文菜单文案，统一映射到 i18n key
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
  if (item === '全局搜歌') item = 'menu.globalSongSearch'

  if (item === 'menu.fullBrowseMode') {
    runtime.mainWindowBrowseMode = 'browser'
    return
  }
  if (item === 'menu.horizontalBrowseMode') {
    runtime.mainWindowBrowseMode = 'horizontal'
    return
  }
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
  if (item === 'menu.globalSongSearch') {
    activeDialog.value = 'search.globalSong'
    await nextTick()
    return
  }
  if (item === 'menu.formatConversionTool') {
    const { default: openConvertDialog } = await import('@renderer/components/audioConvertDialog')
    const dialogResult = await openConvertDialog({ standaloneMode: true })
    if (
      dialogResult &&
      dialogResult !== 'cancel' &&
      'files' in dialogResult &&
      'options' in dialogResult
    ) {
      try {
        await window.electron.ipcRenderer.invoke('audio:convert:start', {
          files: dialogResult.files,
          options: dialogResult.options
        })
      } catch {}
    }
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

const handleGlobalSongSearchLocate = async (item: GlobalSongSearchItem) => {
  activeDialog.value = ''
  await focusSongFromGlobalSearch(item, false, true)
}

const handleGlobalSongSearchPlay = async (item: GlobalSongSearchItem) => {
  activeDialog.value = ''
  await focusSongFromGlobalSearch(item, true)
}

const documentHandleClick = () => {
  runtime.activeMenuUUID = ''
}
document.addEventListener('click', documentHandleClick)
document.addEventListener('contextmenu', documentHandleClick)

const hasOpenContextMenu = () => {
  return !!document.querySelector(CONTEXT_MENU_SELECTOR)
}

const isInsideContextMenu = (target: EventTarget | null) => {
  const element = target as Element | null
  if (!element) return false
  return !!element.closest(CONTEXT_MENU_SELECTOR)
}

const handleContextMenuPointerDownCapture = (event: PointerEvent) => {
  if (event.button !== 0) return
  if (!hasOpenContextMenu()) return
  if (isInsideContextMenu(event.target)) return
  contextMenuClickThroughGuard.markFromPointer(event)
  event.preventDefault()
  event.stopPropagation()
}

const handleContextMenuClickCapture = (event: MouseEvent) => {
  contextMenuClickThroughGuard.suppressClickIfNeeded(event)
}

const getLibrary = async () => {
  runtime.libraryTree = await window.electron.ipcRenderer.invoke('getLibrary')
  runtime.oldLibraryTree = JSON.parse(JSON.stringify(runtime.libraryTree))
}
getLibrary()
onMounted(() => {
  void window.electron.ipcRenderer.invoke('song-search:warmup').catch(() => {})
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
  // F2/Enter 重命名快捷键：Windows 用 F2，Mac 用 Enter
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
  // 初始化全局窗口快捷键作用域
  utils.setHotkeysScpoe('windowGlobal')
  window.electron.ipcRenderer.on('openDialogFromTray', async (_e, key: string) => {
    await openDialog(key)
  })
  window.electron.ipcRenderer.on('open-global-song-search', async () => {
    await openDialog('menu.globalSongSearch')
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
  window.electron.ipcRenderer.on('external-open/imported', async (_e, payload) => {
    try {
      const rawPaths = Array.isArray(payload?.paths) ? payload.paths : []
      const songs = await replaceExternalPlaylistFromPaths(rawPaths)
      if (songs.length) {
        emitter.emit('external-open/play', { songs, startIndex: 0 })
      }
      markSongSearchDirty('external-open-imported')
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
        markSongSearchDirty('library-tree-updated')
        return
      }
      await getLibrary()
      markSongSearchDirty('library-tree-reloaded')
    } catch (_err) {}
  })

  window.addEventListener('pointerdown', handleContextMenuPointerDownCapture, true)
  window.addEventListener('click', handleContextMenuClickCapture, true)
  window.addEventListener('keydown', handleCtrlDoubleTapKeyDown, true)
  window.addEventListener('keyup', handleCtrlDoubleTapKeyUp, true)

  window.electron.ipcRenderer.on('mixtape-items-removed', handleMixtapeItemsRemoved)
  emitter.on('songsRemoved', handleSongsRemovedForGlobalSearch)
  emitter.on('metadataBatchUpdated', handleMetadataBatchUpdatedForGlobalSearch)
  emitter.on('songMetadataUpdated', handleSongMetadataUpdatedForGlobalSearch)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', handleContextMenuPointerDownCapture, true)
  window.removeEventListener('click', handleContextMenuClickCapture, true)
  window.removeEventListener('keydown', handleCtrlDoubleTapKeyDown, true)
  window.removeEventListener('keyup', handleCtrlDoubleTapKeyUp, true)
  window.electron.ipcRenderer.removeListener('mixtape-items-removed', handleMixtapeItemsRemoved)
  emitter.off('songsRemoved', handleSongsRemovedForGlobalSearch)
  emitter.off('metadataBatchUpdated', handleMetadataBatchUpdatedForGlobalSearch)
  emitter.off('songMetadataUpdated', handleSongMetadataUpdatedForGlobalSearch)
  contextMenuClickThroughGuard.clear()
}) // 清理全局事件监听与跨组件订阅
window.addEventListener('openDialogFromChild', (e: any) => {
  const detail = e?.detail
  if (typeof detail === 'string') {
    openDialog(detail)
  }
}) // 响应子窗口发起的对话框打开请求
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
      <titleComponent :hide-logo="showHorizontalModeTopSpacer" @open-dialog="openDialog" />
    </div>
    <div v-if="showHorizontalModeTopSpacer" :style="horizontalModeTopSpacerStyle"></div>
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
  <globalSongSearchDialog
    v-if="activeDialog == 'search.globalSong'"
    @cancel="activeDialog = ''"
    @locate="handleGlobalSongSearchLocate"
    @play="handleGlobalSongSearchPlay"
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
