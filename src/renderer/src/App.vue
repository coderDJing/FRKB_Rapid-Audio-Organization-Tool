<script setup lang="ts">
import homePage from './pages/homePage.vue'
import titleComponent from './components/titleComponent.vue'
import TitleBarAudioVisualizer from '@renderer/components/TitleBarAudioVisualizer.vue'
import scanNewSongDialog from '@renderer/components/scanNewSongDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import bottomInfoArea from './pages/modules/bottomInfoArea.vue'
import manualAddSongFingerprintDialog from './components/manualAddSongFingerprintDialog.vue'
import globalSongSearchDialog from './components/globalSongSearchDialog.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import hotkeys from 'hotkeys-js'
import utils from './utils/utils'
import exportSongFingerprintDialog from './components/exportSongFingerprintDialog.vue'
import importSongFingerprintDialog from './components/importSongFingerprintDialog.vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import pkg from '../../../package.json'
import cloudSyncSettingsDialog from './components/cloudSyncSettingsDialog.vue'
import cloudSyncSyncDialog from './components/cloudSyncSyncDialog.vue'
import FileOpInterruptedDialog from './components/fileOpInterruptedDialog.vue'
import emitter from './utils/mitt'
import { replaceExternalPlaylistFromPaths } from '@renderer/utils/externalPlaylist'
import { createClickThroughGuard } from '@renderer/utils/clickThroughGuard'
import HorizontalBrowseModeShell from '@renderer/components/HorizontalBrowseModeShell.vue'
import AnalysisRuntimeDownloadOverlay from '@renderer/components/AnalysisRuntimeDownloadOverlay.vue'
import { useAnalysisRuntimeDownload } from '@renderer/composables/useAnalysisRuntimeDownload'
import settingDialog from '@renderer/components/settingDialog.vue'
import settingIconAsset from '@renderer/assets/setting.svg?asset'
import WindowVolumeDial from '@renderer/components/WindowVolumeDial.vue'
import {
  MAIN_WINDOW_VOLUME_CHANGED_EVENT,
  MAIN_WINDOW_VOLUME_SET_EVENT,
  MAIN_WINDOW_VOLUME_STORAGE_KEY,
  clampVolumeValue,
  readWindowVolume,
  writeWindowVolume
} from '@renderer/utils/windowVolume'

const runtime = useRuntimeStore()
const contextMenuClickThroughGuard = createClickThroughGuard()
const CONTEXT_MENU_SELECTOR = '[data-frkb-context-menu="true"]'
const normalizeMainWindowBrowseMode = (value: unknown): 'browser' | 'horizontal' =>
  value === 'horizontal' ? 'horizontal' : 'browser'
// 运行期平台展示优先取持久化设置，避免依赖不稳定的 userAgent
{
  const p = runtime.setting?.platform
  runtime.platform = p === 'darwin' ? 'Mac' : p === 'win32' ? 'Windows' : 'Unknown'
}
runtime.mainWindowBrowseMode = normalizeMainWindowBrowseMode(runtime.setting?.mainWindowBrowseMode)
watch(
  () => runtime.mainWindowBrowseMode,
  (mode) => {
    const normalizedMode = normalizeMainWindowBrowseMode(mode)
    if (runtime.mainWindowBrowseMode !== normalizedMode) {
      runtime.mainWindowBrowseMode = normalizedMode
      return
    }
    if (runtime.setting?.mainWindowBrowseMode !== normalizedMode) {
      runtime.setting.mainWindowBrowseMode = normalizedMode
    }
    window.electron.ipcRenderer.send('main-window-browse-mode-updated', normalizedMode)
  },
  { immediate: true }
)
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
let songSearchWarmupTimer: ReturnType<typeof setTimeout> | null = null
const CTRL_DOUBLE_TAP_MS = 260
const mainWindowTopGapHeight = 41
const horizontalModeShellHeight = 372
const mainWindowBrowseModeMenuOpen = ref(false)
const mainWindowBrowseModeMenuRef = ref<HTMLElement | null>(null)
const mainWindowBrowseModeOptions = [
  { value: 'browser', labelKey: 'modeSwitcher.browser' },
  { value: 'horizontal', labelKey: 'modeSwitcher.horizontal' }
] as const
const showHorizontalModeShell = computed(() => runtime.mainWindowBrowseMode === 'horizontal')
const mainWindowTopGapStyle = computed(() => ({
  height: `${mainWindowTopGapHeight}px`,
  flex: `0 0 ${mainWindowTopGapHeight}px`,
  backgroundColor: 'var(--bg)',
  borderBottom: '1px solid var(--border)',
  boxSizing: 'border-box' as const,
  position: 'relative' as const,
  overflow: 'visible' as const,
  zIndex: 'var(--z-app-toolbar)'
}))
const horizontalModeShellStyle = computed(() => ({
  '--horizontal-browse-shell-height': `${horizontalModeShellHeight}px`,
  height: `${horizontalModeShellHeight}px`,
  flex: `0 0 ${horizontalModeShellHeight}px`,
  backgroundColor: 'var(--bg)',
  borderBottom: '1px solid var(--border)',
  boxSizing: 'border-box' as const,
  position: 'relative' as const,
  overflow: 'visible' as const,
  zIndex: 10
}))
const topToolbarSettingIconStyle = computed(() => ({
  '--top-toolbar-setting-icon-mask': `url("${settingIconAsset}")`
}))
const mainWindowVolume = ref(readWindowVolume(MAIN_WINDOW_VOLUME_STORAGE_KEY))
const currentMainWindowBrowseModeLabel = computed(() => {
  const currentMode =
    mainWindowBrowseModeOptions.find((item) => item.value === runtime.mainWindowBrowseMode) ||
    mainWindowBrowseModeOptions[0]
  return t(currentMode.labelKey)
})
const {
  analysisRuntimeDownloadVisible,
  analysisRuntimeDownloadPercent,
  analysisRuntimeDownloadTitle,
  analysisRuntimeDownloadText,
  refreshAnalysisRuntimeStatus,
  promptAnalysisRuntimeDownload,
  ensureAnalysisRuntimeForHorizontalMode,
  handleAnalysisRuntimeDownloadState
} = useAnalysisRuntimeDownload({
  runtime,
  t,
  confirmDialog: confirm
})

type CoreLibraryName = 'FilterLibrary' | 'CuratedLibrary' | 'MixtapeLibrary' | 'RecycleBin'
type SongsRemovedPayload = {
  listUUID?: string
  itemIds?: string[]
  paths?: string[]
}
type MixtapeItemsRemovedPayload = {
  playlistId?: string
  itemIds?: string[]
  removedPaths?: string[]
}
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

const handleSongsRemovedForGlobalSearch = (payload: SongsRemovedPayload | null) => {
  try {
    markSongSearchDirty('songs-removed')
    const itemIds: string[] = Array.isArray(payload?.itemIds) ? payload.itemIds : []
    const listUUID: string | undefined = payload?.listUUID
    if (itemIds.length > 0) {
      if (listUUID && listUUID !== runtime.playingData.playingSongListUUID) return
      const idSet = new Set(itemIds)

      runtime.playingData.playingSongListData = (
        runtime.playingData.playingSongListData || []
      ).filter((song) => !idSet.has(song?.mixtapeItemId || ''))

      if (
        runtime.playingData.playingSong &&
        idSet.has(runtime.playingData.playingSong.mixtapeItemId || '')
      ) {
        runtime.playingData.playingSong = null
      }

      return
    }

    const paths: string[] = Array.isArray(payload?.paths) ? payload.paths : []
    if (!paths.length) return
    if (listUUID && listUUID !== runtime.playingData.playingSongListUUID) return
    const normalizedSet = new Set(paths.map((p) => normalizePath(p)).filter(Boolean))

    runtime.playingData.playingSongListData = (
      runtime.playingData.playingSongListData || []
    ).filter((song) => !normalizedSet.has(normalizePath(song.filePath)))

    if (
      runtime.playingData.playingSong &&
      normalizedSet.has(normalizePath(runtime.playingData.playingSong.filePath))
    ) {
      runtime.playingData.playingSong = null
    }
  } catch {}
}
const handleMixtapeItemsRemoved = (_e: unknown, payload: MixtapeItemsRemovedPayload | null) => {
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
  window.electron.ipcRenderer.send('file-op-control', {
    batchId: fileOpBatchId.value,
    action
  })
}

const showDevSongListTraceDialog = async (content: string[]) => {
  await confirm({
    title: 'Trace 录制',
    content,
    confirmShow: false,
    canCopyText: true,
    innerHeight: 260
  })
}

const logDevSongListTraceInfo = (message: string, payload?: Record<string, unknown>) => {
  void message
  void payload
}

const logDevSongListTraceWarn = (message: string, payload?: Record<string, unknown>) => {
  void message
  void payload
}

const logDevSongListTraceError = (message: string, payload?: Record<string, unknown>) => {
  if (payload && Object.keys(payload).length > 0) {
    console.error('[dev-songlist-trace]', message, payload)
    return
  }
  console.error('[dev-songlist-trace]', message)
}

const startDevSongListTrace = async () => {
  try {
    logDevSongListTraceInfo('手动开始 trace 录制')
    const result = await window.electron.ipcRenderer.invoke('dev-songlist-trace:start')
    const message = String(result?.message || '').trim()
    logDevSongListTraceInfo(message || 'trace 录制状态已更新', {
      mode: result?.mode
    })
    if (!message) return
    await showDevSongListTraceDialog([message])
  } catch (error) {
    logDevSongListTraceError('手动开始 trace 录制失败', {
      error: error instanceof Error ? error.message : String(error)
    })
    await showDevSongListTraceDialog([
      `开始 Trace 录制失败：${error instanceof Error ? error.message : String(error)}`
    ])
  }
}

const stopDevSongListTrace = async () => {
  try {
    logDevSongListTraceInfo('手动结束 trace 录制并导出')
    const result = await window.electron.ipcRenderer.invoke('dev-songlist-trace:stop')
    const message = String(result?.message || '').trim()
    logDevSongListTraceInfo(message || 'trace 导出流程已触发', {
      mode: result?.mode,
      filePath: result?.filePath || ''
    })
    if (!message) return
    if (result?.ok !== true || !result?.filePath) {
      await showDevSongListTraceDialog([message])
    }
  } catch (error) {
    logDevSongListTraceError('手动结束 trace 录制失败', {
      error: error instanceof Error ? error.message : String(error)
    })
    await showDevSongListTraceDialog([
      `结束 Trace 录制失败：${error instanceof Error ? error.message : String(error)}`
    ])
  }
}

const handleDevSongListTraceState = (
  _event: unknown,
  payload?: {
    phase?: string
    message?: string
    playlistUuid?: string
    playlistName?: string
    playlistType?: string
    filePath?: string
    durationMs?: number
  }
) => {
  const phase = String(payload?.phase || '').trim()
  const message = String(payload?.message || '').trim()
  const meta = {
    phase,
    playlistUuid: String(payload?.playlistUuid || '').trim(),
    playlistName: String(payload?.playlistName || '').trim(),
    playlistType: String(payload?.playlistType || '').trim(),
    filePath: String(payload?.filePath || '').trim(),
    durationMs: Math.max(0, Number(payload?.durationMs) || 0)
  }
  const logMessage = message || `歌单 trace 状态变化：${phase || 'unknown'}`
  if (phase === 'error') {
    logDevSongListTraceError(logMessage, meta)
    return
  }
  if (phase === 'click-ignored-idle') {
    logDevSongListTraceWarn(logMessage, meta)
    return
  }
  if (phase === 'export-started' || phase === 'stop-requested' || phase === 'export-verifying') {
    logDevSongListTraceWarn(logMessage, meta)
    return
  }
  logDevSongListTraceInfo(logMessage, meta)
}

const handleDevSongListTraceExported = async (
  _event: unknown,
  payload?: {
    filePath?: string
    durationMs?: number
    startedPlaylistName?: string
    endedPlaylistName?: string
  }
) => {
  const filePath = String(payload?.filePath || '').trim()
  const durationMs = Math.max(0, Number(payload?.durationMs) || 0)
  const startedPlaylistName = String(payload?.startedPlaylistName || '').trim()
  const endedPlaylistName = String(payload?.endedPlaylistName || '').trim()
  const lines = [
    'Trace 已导出。',
    filePath ? `文件：${filePath}` : '',
    durationMs > 0 ? `录制时长：${durationMs} ms` : '',
    startedPlaylistName ? `开始歌单：${startedPlaylistName}` : '',
    endedPlaylistName ? `结束歌单：${endedPlaylistName}` : ''
  ].filter(Boolean)
  logDevSongListTraceInfo('歌单 trace 已导出，现在可以关闭窗口了', {
    filePath,
    durationMs,
    startedPlaylistName,
    endedPlaylistName
  })
  await showDevSongListTraceDialog(lines)
}

const handleDevSongListTraceError = async (
  _event: unknown,
  payload?: { stage?: string; message?: string }
) => {
  const stage = String(payload?.stage || '').trim()
  const message = String(payload?.message || '').trim()
  logDevSongListTraceError('trace 录制失败', {
    stage,
    message
  })
  await showDevSongListTraceDialog(
    ['Trace 录制失败。', stage ? `阶段：${stage}` : '', message || '未知错误'].filter(Boolean)
  )
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
    const canEnterHorizontalMode = await ensureAnalysisRuntimeForHorizontalMode()
    if (!canEnterHorizontalMode) return
    runtime.mainWindowBrowseMode = 'horizontal'
    return
  }
  if (item === 'menu.downloadAnalysisRuntime') {
    await promptAnalysisRuntimeDownload('help')
    return
  }
  if (item === 'menu.about') {
    const version = String(pkg.version || '')
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
  if (item === 'menu.startSongListTrace') {
    await startDevSongListTrace()
    return
  }
  if (item === 'menu.stopSongListTrace') {
    await stopDevSongListTrace()
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

const closeMainWindowBrowseModeMenu = () => {
  mainWindowBrowseModeMenuOpen.value = false
}

const toggleMainWindowBrowseModeMenu = () => {
  mainWindowBrowseModeMenuOpen.value = !mainWindowBrowseModeMenuOpen.value
}

const selectMainWindowBrowseMode = async (mode: 'browser' | 'horizontal') => {
  closeMainWindowBrowseModeMenu()
  if (runtime.mainWindowBrowseMode === mode) return
  await openDialog(mode === 'browser' ? 'menu.fullBrowseMode' : 'menu.horizontalBrowseMode')
}

const openSettingsDialog = () => {
  activeDialog.value = 'settings'
}

const handleMainWindowVolumeChange = (value: number) => {
  const nextVolume = writeWindowVolume(MAIN_WINDOW_VOLUME_STORAGE_KEY, value)
  mainWindowVolume.value = nextVolume
  emitter.emit(MAIN_WINDOW_VOLUME_SET_EVENT, nextVolume)
}

const handleMainWindowVolumeSync = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  mainWindowVolume.value = clampVolumeValue(value)
}

const documentHandleClick = () => {
  runtime.activeMenuUUID = ''
}
document.addEventListener('click', documentHandleClick)
document.addEventListener('contextmenu', documentHandleClick)

const handleMainWindowBrowseModeMenuPointerDown = (event: PointerEvent) => {
  if (!mainWindowBrowseModeMenuOpen.value) return
  const target = event.target as Node | null
  if (
    !mainWindowBrowseModeMenuRef.value ||
    (target && mainWindowBrowseModeMenuRef.value.contains(target))
  )
    return
  closeMainWindowBrowseModeMenu()
}

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
  songSearchWarmupTimer = setTimeout(() => {
    songSearchWarmupTimer = null
    void window.electron.ipcRenderer.invoke('song-search:warmup').catch(() => {})
  }, 5000)
  emitter.on(MAIN_WINDOW_VOLUME_CHANGED_EVENT, handleMainWindowVolumeSync)
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
    closeMainWindowBrowseModeMenu()
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
  window.electron.ipcRenderer.on('analysis-runtime-download-state', (_e, payload) => {
    void handleAnalysisRuntimeDownloadState(payload)
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
  window.addEventListener('pointerdown', handleMainWindowBrowseModeMenuPointerDown, true)
  window.addEventListener('click', handleContextMenuClickCapture, true)
  window.addEventListener('keydown', handleCtrlDoubleTapKeyDown, true)
  window.addEventListener('keyup', handleCtrlDoubleTapKeyUp, true)

  window.electron.ipcRenderer.on('mixtape-items-removed', handleMixtapeItemsRemoved)
  window.electron.ipcRenderer.on('dev-songlist-trace:state', handleDevSongListTraceState)
  window.electron.ipcRenderer.on('dev-songlist-trace:exported', handleDevSongListTraceExported)
  window.electron.ipcRenderer.on('dev-songlist-trace:error', handleDevSongListTraceError)
  emitter.on('songsRemoved', handleSongsRemovedForGlobalSearch)
  emitter.on('metadataBatchUpdated', handleMetadataBatchUpdatedForGlobalSearch)
  emitter.on('songMetadataUpdated', handleSongMetadataUpdatedForGlobalSearch)
  void (async () => {
    await refreshAnalysisRuntimeStatus()
    await promptAnalysisRuntimeDownload('startup')
  })()
})

onBeforeUnmount(() => {
  if (songSearchWarmupTimer) {
    clearTimeout(songSearchWarmupTimer)
    songSearchWarmupTimer = null
  }
  emitter.off(MAIN_WINDOW_VOLUME_CHANGED_EVENT, handleMainWindowVolumeSync)
  window.removeEventListener('pointerdown', handleContextMenuPointerDownCapture, true)
  window.removeEventListener('pointerdown', handleMainWindowBrowseModeMenuPointerDown, true)
  window.removeEventListener('click', handleContextMenuClickCapture, true)
  window.removeEventListener('keydown', handleCtrlDoubleTapKeyDown, true)
  window.removeEventListener('keyup', handleCtrlDoubleTapKeyUp, true)
  window.electron.ipcRenderer.removeListener('mixtape-items-removed', handleMixtapeItemsRemoved)
  window.electron.ipcRenderer.removeListener(
    'dev-songlist-trace:state',
    handleDevSongListTraceState
  )
  window.electron.ipcRenderer.removeListener(
    'dev-songlist-trace:exported',
    handleDevSongListTraceExported
  )
  window.electron.ipcRenderer.removeListener(
    'dev-songlist-trace:error',
    handleDevSongListTraceError
  )
  window.electron.ipcRenderer.removeAllListeners('analysis-runtime-download-state')
  emitter.off('songsRemoved', handleSongsRemovedForGlobalSearch)
  emitter.off('metadataBatchUpdated', handleMetadataBatchUpdatedForGlobalSearch)
  emitter.off('songMetadataUpdated', handleSongMetadataUpdatedForGlobalSearch)
  contextMenuClickThroughGuard.clear()
}) // 清理全局事件监听与跨组件订阅
window.addEventListener('openDialogFromChild', (e: Event) => {
  const detail = (e as CustomEvent<string>).detail
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
  closeMainWindowBrowseModeMenu()
})
</script>
<template>
  <div style="height: 100%; max-height: 100%; width: 100%; display: flex; flex-direction: column">
    <div style="height: 35px; position: relative; z-index: var(--z-title-bar); overflow: visible">
      <titleComponent @open-dialog="openDialog">
        <template #rightExtra>
          <TitleBarAudioVisualizer target="mainWindow" />
        </template>
      </titleComponent>
    </div>
    <div :style="mainWindowTopGapStyle" class="mainWindowTopGap">
      <div ref="mainWindowBrowseModeMenuRef" class="topToolbarModeDropdown">
        <button
          class="topToolbarModeButton"
          :class="{ 'is-open': mainWindowBrowseModeMenuOpen }"
          :title="currentMainWindowBrowseModeLabel"
          :aria-expanded="mainWindowBrowseModeMenuOpen ? 'true' : 'false'"
          aria-haspopup="menu"
          type="button"
          @click.stop="toggleMainWindowBrowseModeMenu"
        >
          <span class="topToolbarModeButtonLabel">{{ currentMainWindowBrowseModeLabel }}</span>
          <svg
            class="topToolbarModeButtonCaret"
            viewBox="0 0 10 10"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M2 3.25 5 6.25 8 3.25"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <div
          v-if="mainWindowBrowseModeMenuOpen"
          class="topToolbarModeMenu"
          role="menu"
          @click.stop="() => {}"
        >
          <button
            v-for="item in mainWindowBrowseModeOptions"
            :key="item.value"
            class="topToolbarModeOption"
            :class="{ 'is-active': runtime.mainWindowBrowseMode === item.value }"
            type="button"
            role="menuitemradio"
            :aria-checked="runtime.mainWindowBrowseMode === item.value ? 'true' : 'false'"
            @click="void selectMainWindowBrowseMode(item.value)"
          >
            <span class="topToolbarModeOptionCheck">{{
              runtime.mainWindowBrowseMode === item.value ? '✓' : ''
            }}</span>
            <span class="topToolbarModeOptionLabel">{{ t(item.labelKey) }}</span>
          </button>
        </div>
      </div>
      <div class="topToolbarActions">
        <WindowVolumeDial
          :model-value="mainWindowVolume"
          :label="t('player.volumeControl')"
          :size="28"
          @update:model-value="handleMainWindowVolumeChange"
        />
        <button
          class="topToolbarSettingButton"
          :style="topToolbarSettingIconStyle"
          :title="t('common.setting')"
          :aria-label="t('common.setting')"
          type="button"
          @click="openSettingsDialog"
        >
          <span class="topToolbarSettingIcon"></span>
        </button>
      </div>
    </div>
    <div v-if="showHorizontalModeShell" :style="horizontalModeShellStyle">
      <HorizontalBrowseModeShell />
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
  <settingDialog v-if="activeDialog == 'settings'" @cancel="activeDialog = ''" />
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
  <AnalysisRuntimeDownloadOverlay
    :visible="analysisRuntimeDownloadVisible"
    :title="analysisRuntimeDownloadTitle"
    :text="analysisRuntimeDownloadText"
    :percent="analysisRuntimeDownloadPercent"
    :hint="t('analysisRuntime.downloadBlockingHint')"
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

.mainWindowTopGap {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-sizing: border-box;
  padding: 0 8px;
  gap: 12px;
}

.topToolbarModeDropdown {
  position: relative;
  flex: 0 0 auto;
}

.topToolbarModeButton {
  min-width: 128px;
  height: 24px;
  padding: 0 10px 0 12px;
  border: 1px solid color-mix(in srgb, var(--border) 90%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--bg-elev) 88%, var(--bg));
  color: var(--text);
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  box-sizing: border-box;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    box-shadow 0.15s ease;
}

.topToolbarModeButton:hover,
.topToolbarModeButton.is-open {
  border-color: color-mix(in srgb, var(--accent) 36%, var(--border));
  background: color-mix(in srgb, var(--bg-elev) 92%, var(--bg));
}

.topToolbarModeButton.is-open {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent);
}

.topToolbarModeButtonLabel {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  min-width: 0;
  flex: 1 1 auto;
}

.topToolbarModeButtonCaret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 10px;
  transition: transform 0.15s ease;
  flex: 0 0 auto;
  opacity: 0.82;
}

.topToolbarModeButton.is-open .topToolbarModeButtonCaret {
  transform: rotate(180deg);
}

.topToolbarModeMenu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 144px;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--border) 92%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--bg-elev) 96%, var(--bg));
  box-shadow:
    0 10px 24px rgba(0, 0, 0, 0.12),
    0 1px 0 rgba(255, 255, 255, 0.04) inset;
  box-sizing: border-box;
  z-index: var(--z-app-toolbar-dropdown);
}

.topToolbarModeOption {
  width: 100%;
  min-height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.topToolbarModeOption:hover,
.topToolbarModeOption.is-active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.topToolbarModeOption.is-active {
  color: color-mix(in srgb, var(--accent) 74%, var(--text));
}

.topToolbarModeOptionCheck {
  width: 12px;
  flex: 0 0 12px;
  font-size: 12px;
  line-height: 1;
}

.topToolbarModeOptionLabel {
  font-size: 12px;
  line-height: 1.2;
}

.topToolbarActions {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-left: auto;
}

.topToolbarSettingButton {
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-weak);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    color 0.15s ease,
    opacity 0.15s ease,
    transform 0.15s ease;
}

.topToolbarSettingButton:hover {
  color: var(--text);
  opacity: 1;
}

.topToolbarSettingButton:active {
  transform: translateY(1px);
}

.topToolbarSettingIcon {
  width: 22px;
  height: 22px;
  display: inline-block;
  background-color: currentColor;
  opacity: 0.82;
  mask-image: var(--top-toolbar-setting-icon-mask);
  mask-repeat: no-repeat;
  mask-position: center;
  mask-size: contain;
  -webkit-mask-image: var(--top-toolbar-setting-icon-mask);
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  -webkit-mask-size: contain;
}

.topToolbarSettingButton:hover .topToolbarSettingIcon {
  opacity: 1;
}
</style>
