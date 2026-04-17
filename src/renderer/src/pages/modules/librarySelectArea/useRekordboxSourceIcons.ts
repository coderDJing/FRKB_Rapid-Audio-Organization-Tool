import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import rightClickMenu from '@renderer/components/rightClickMenu'
import {
  buildRekordboxSourceCacheKey,
  clearRekordboxSourceCache,
  clearRekordboxSourceCachesByKind,
  getCachedRekordboxSourceTree,
  getRememberedRekordboxSourceSelectedPlaylist,
  setCachedRekordboxSourceTree,
  shouldRefreshRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import { t } from '@renderer/utils/translate'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type {
  IPioneerDeviceLibraryKind,
  IPioneerPlaylistTreeNode,
  IRekordboxLibraryBrowserState,
  IRekordboxSourceKind,
  IRekordboxSourceLibraryType
} from '../../../../../types/globals'

type HoverableIcon = {
  name: string
  grey: string
  white: string
  src: string
  showAlt: boolean
  i18nKey?: string
}

type PioneerDriveEntry = {
  id: string
  name: string
  path: string
  volumeName: string
  fileSystem: string
  isUsb: boolean
  isPioneerDeviceLibrary: boolean
  supportedLibraryTypes?: IPioneerDeviceLibraryKind[]
}

type PioneerDriveEjectResult = {
  success: boolean
  path: string
  code?: 'INVALID_PATH' | 'EJECT_COMMAND_FAILED' | 'EJECT_TIMEOUT' | 'UNSUPPORTED_PLATFORM'
  detail?: string
}

type RekordboxSourceTreeLoadResult = {
  treeNodes?: IPioneerPlaylistTreeNode[]
  driveName?: string
  sourceRootPath?: string
}

export type PioneerDriveIcon = HoverableIcon & {
  key: string
  tooltip: string
  path: string
  libraryType: IPioneerDeviceLibraryKind
}

export type PioneerDriveGroup = {
  key: string
  path: string
  icons: PioneerDriveIcon[]
}

export type RekordboxDesktopIcon = HoverableIcon & {
  key: string
  tooltip: string
  rootPath: string
}

type UseRekordboxSourceIconsOptions = {
  runtime: ReturnType<typeof useRuntimeStore>
  usbDriveIconAsset: string
  rekordboxDesktopIconAsset: string
  updateSelectedIcon: (item: HoverableIcon | undefined) => void
  waitForUiIdle: (ms: number) => Promise<unknown>
  emitLibrarySelectedChange: (payload: { name: string }) => void
}

const SOURCE_ICON_AUTO_REFRESH_INTERVAL_MS = 8_000

export function useRekordboxSourceIcons(options: UseRekordboxSourceIconsOptions) {
  const {
    runtime,
    usbDriveIconAsset,
    rekordboxDesktopIconAsset,
    updateSelectedIcon,
    waitForUiIdle,
    emitLibrarySelectedChange
  } = options

  const pioneerDriveIcons = ref<PioneerDriveIcon[]>([])
  const desktopLibraryIcon = ref<RekordboxDesktopIcon | null>(null)
  const ejectingDriveKeys = ref<string[]>([])
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  let sourceTreeRequestToken = 0
  let refreshInFlight: Promise<void> | null = null

  const pioneerDriveTypeOrder: Record<IPioneerDeviceLibraryKind, number> = {
    deviceLibrary: 0,
    oneLibrary: 1
  }

  const pioneerDriveGroups = computed<PioneerDriveGroup[]>(() => {
    const groupMap = new Map<string, PioneerDriveGroup>()
    for (const icon of pioneerDriveIcons.value) {
      const groupKey = `pioneer-group:${icon.path || icon.key}`
      const existing = groupMap.get(groupKey)
      if (existing) {
        existing.icons.push(icon)
        continue
      }
      groupMap.set(groupKey, {
        key: groupKey,
        path: icon.path,
        icons: [icon]
      })
    }
    return Array.from(groupMap.values()).map((group) => ({
      ...group,
      icons: [...group.icons].sort(
        (left, right) =>
          pioneerDriveTypeOrder[left.libraryType] - pioneerDriveTypeOrder[right.libraryType]
      )
    }))
  })

  const getPioneerLibraryTypeLabel = (libraryType: IPioneerDeviceLibraryKind) =>
    libraryType === 'oneLibrary' ? t('pioneer.oneLibraryLabel') : t('pioneer.deviceLibraryLabel')

  const snapshotSelection = (): IRekordboxLibraryBrowserState => ({
    selectedSourceKey: runtime.pioneerDeviceLibrary.selectedSourceKey,
    selectedSourceName: runtime.pioneerDeviceLibrary.selectedSourceName,
    selectedSourceRootPath: runtime.pioneerDeviceLibrary.selectedSourceRootPath,
    selectedSourceKind: runtime.pioneerDeviceLibrary.selectedSourceKind,
    selectedLibraryType: runtime.pioneerDeviceLibrary.selectedLibraryType,
    selectedPlaylistId: runtime.pioneerDeviceLibrary.selectedPlaylistId,
    loading: runtime.pioneerDeviceLibrary.loading,
    treeNodes: Array.isArray(runtime.pioneerDeviceLibrary.treeNodes)
      ? [...runtime.pioneerDeviceLibrary.treeNodes]
      : []
  })

  const restoreSelection = (snapshot: IRekordboxLibraryBrowserState) => {
    runtime.pioneerDeviceLibrary.selectedSourceKey = snapshot.selectedSourceKey
    runtime.pioneerDeviceLibrary.selectedSourceName = snapshot.selectedSourceName
    runtime.pioneerDeviceLibrary.selectedSourceRootPath = snapshot.selectedSourceRootPath
    runtime.pioneerDeviceLibrary.selectedSourceKind = snapshot.selectedSourceKind
    runtime.pioneerDeviceLibrary.selectedLibraryType = snapshot.selectedLibraryType
    runtime.pioneerDeviceLibrary.selectedPlaylistId = snapshot.selectedPlaylistId
    runtime.pioneerDeviceLibrary.loading = snapshot.loading
    runtime.pioneerDeviceLibrary.treeNodes = Array.isArray(snapshot.treeNodes)
      ? [...snapshot.treeNodes]
      : []
  }

  const clearSelection = () => {
    runtime.pioneerDeviceLibrary.selectedSourceKey = ''
    runtime.pioneerDeviceLibrary.selectedSourceName = ''
    runtime.pioneerDeviceLibrary.selectedSourceRootPath = ''
    runtime.pioneerDeviceLibrary.selectedSourceKind = ''
    runtime.pioneerDeviceLibrary.selectedLibraryType = ''
    runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
    runtime.pioneerDeviceLibrary.loading = false
    runtime.pioneerDeviceLibrary.treeNodes = []
  }

  const switchBackToFilterLibraryAfterExit = () => {
    if (runtime.libraryAreaSelected !== 'PioneerDeviceLibrary') return
    runtime.libraryAreaSelected = 'FilterLibrary'
  }

  const buildPioneerDriveTooltip = (
    drive: PioneerDriveEntry,
    libraryType: IPioneerDeviceLibraryKind
  ) => {
    const title = String(drive.volumeName || drive.name || '').trim()
    const base = title || String(drive.path || '').trim() || 'Pioneer USB'
    return `${base} · ${getPioneerLibraryTypeLabel(libraryType)}`
  }

  const resolvePioneerDriveSourceCacheKey = (item: {
    key: string
    path: string
    libraryType: IPioneerDeviceLibraryKind
  }) =>
    buildRekordboxSourceCacheKey({
      sourceKind: 'usb',
      sourceKey: item.key,
      rootPath: item.path,
      libraryType: item.libraryType
    })

  const resolveDesktopLibrarySourceCacheKey = (
    icon: Pick<RekordboxDesktopIcon, 'key' | 'rootPath'> | null | undefined
  ) =>
    buildRekordboxSourceCacheKey({
      sourceKind: 'desktop',
      sourceKey: icon?.key,
      rootPath: icon?.rootPath,
      libraryType: 'masterDb'
    })

  const hasPlaylistInTree = (
    treeNodes: IPioneerPlaylistTreeNode[],
    playlistId: number
  ): boolean => {
    if (!playlistId) return false
    const walk = (nodes: IPioneerPlaylistTreeNode[]): boolean => {
      for (const node of nodes) {
        if (!node.isFolder && node.id === playlistId) return true
        if (Array.isArray(node.children) && node.children.length > 0 && walk(node.children)) {
          return true
        }
      }
      return false
    }
    return walk(Array.isArray(treeNodes) ? treeNodes : [])
  }

  const resolvePlaylistIdForTree = (
    treeNodes: IPioneerPlaylistTreeNode[],
    preferredPlaylistId: number
  ) => {
    const safePlaylistId = Number(preferredPlaylistId) || 0
    if (safePlaylistId <= 0) return 0
    return hasPlaylistInTree(treeNodes, safePlaylistId) ? safePlaylistId : 0
  }

  const isCurrentSelectedSource = (
    sourceKind: IRekordboxSourceKind,
    sourceKey: string,
    libraryType: IRekordboxSourceLibraryType
  ) =>
    runtime.pioneerDeviceLibrary.selectedSourceKind === sourceKind &&
    runtime.pioneerDeviceLibrary.selectedSourceKey === sourceKey &&
    runtime.pioneerDeviceLibrary.selectedLibraryType === libraryType

  const getErrorMessage = (error: unknown, fallbackMessage: string) => {
    if (error instanceof Error) {
      const message = String(error.message || '').trim()
      return message || fallbackMessage
    }
    return String(error || fallbackMessage)
  }

  const loadSourceTree = async (params: {
    sourceKind: IRekordboxSourceKind
    sourceKey: string
    sourceCacheKey: string
    rootPath: string
    libraryType: IRekordboxSourceLibraryType
    preferredPlaylistId: number
    hasCachedTree: boolean
    fallbackSourceName: string
    loadTree: () => Promise<RekordboxSourceTreeLoadResult>
    loadTreeFailedMessage: string
    resolveSourceName?: (result: RekordboxSourceTreeLoadResult) => string
    resolveRootPath?: (result: RekordboxSourceTreeLoadResult) => string
  }) => {
    const requestToken = ++sourceTreeRequestToken
    const {
      sourceKind,
      sourceKey,
      sourceCacheKey,
      rootPath,
      libraryType,
      preferredPlaylistId,
      hasCachedTree,
      fallbackSourceName,
      loadTree,
      loadTreeFailedMessage,
      resolveSourceName,
      resolveRootPath
    } = params

    try {
      const result = await loadTree()
      const treeNodes = Array.isArray(result?.treeNodes) ? result.treeNodes : []
      const currentSelectedPlaylistId = isCurrentSelectedSource(sourceKind, sourceKey, libraryType)
        ? Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
        : 0
      const resolvedPlaylistId = resolvePlaylistIdForTree(
        treeNodes,
        currentSelectedPlaylistId > 0
          ? currentSelectedPlaylistId
          : hasCachedTree
            ? 0
            : preferredPlaylistId
      )

      setCachedRekordboxSourceTree(sourceCacheKey, treeNodes, {
        selectedPlaylistId: resolvedPlaylistId
      })

      if (!isCurrentSelectedSource(sourceKind, sourceKey, libraryType)) return
      if (requestToken !== sourceTreeRequestToken) return

      runtime.pioneerDeviceLibrary.treeNodes = treeNodes
      runtime.pioneerDeviceLibrary.selectedPlaylistId = resolvedPlaylistId
      runtime.pioneerDeviceLibrary.selectedSourceName =
        resolveSourceName?.(result) || fallbackSourceName
      runtime.pioneerDeviceLibrary.selectedSourceRootPath = resolveRootPath?.(result) || rootPath
    } catch (error) {
      if (!isCurrentSelectedSource(sourceKind, sourceKey, libraryType)) return
      if (requestToken !== sourceTreeRequestToken) return

      if (!hasCachedTree) {
        runtime.pioneerDeviceLibrary.treeNodes = []
        runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
        await confirm({
          title: t('common.error'),
          content: [getErrorMessage(error, loadTreeFailedMessage)],
          confirmShow: false
        })
        return
      }
    } finally {
      if (!isCurrentSelectedSource(sourceKind, sourceKey, libraryType)) return
      if (requestToken !== sourceTreeRequestToken) return
      runtime.pioneerDeviceLibrary.loading = false
    }
  }

  const refreshPioneerDriveIcons = async () => {
    try {
      const previousIcons = [...pioneerDriveIcons.value]
      const result = await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('usb', 'list-removable-drives')
      )
      const drives = Array.isArray(result) ? (result as PioneerDriveEntry[]) : []
      const nextIcons = drives
        .filter((item) => item && item.isPioneerDeviceLibrary)
        .flatMap((item) => {
          const libraryTypes = Array.isArray(item.supportedLibraryTypes)
            ? item.supportedLibraryTypes
            : []
          return libraryTypes.map((libraryType) => {
            const tooltip = buildPioneerDriveTooltip(item, libraryType)
            return {
              key: `pioneer-drive:${item.id || item.path}:${libraryType}`,
              name: tooltip,
              grey: usbDriveIconAsset,
              white: usbDriveIconAsset,
              src: usbDriveIconAsset,
              showAlt: false,
              tooltip,
              path: item.path,
              libraryType
            } satisfies PioneerDriveIcon
          })
        })
      pioneerDriveIcons.value = nextIcons

      const nextCacheKeys = new Set(
        nextIcons.map((icon) => resolvePioneerDriveSourceCacheKey(icon)).filter(Boolean)
      )
      for (const icon of previousIcons) {
        const cacheKey = resolvePioneerDriveSourceCacheKey(icon)
        if (!cacheKey || nextCacheKeys.has(cacheKey)) continue
        clearRekordboxSourceCache(cacheKey)
      }

      if (runtime.pioneerDeviceLibrary.selectedSourceKind !== 'usb') return
      if (!runtime.pioneerDeviceLibrary.selectedSourceKey) return
      const target = pioneerDriveIcons.value.find(
        (icon) => icon.key === runtime.pioneerDeviceLibrary.selectedSourceKey
      )
      if (!target) {
        clearSelection()
        switchBackToFilterLibraryAfterExit()
        return
      }
      if (runtime.libraryAreaSelected === 'PioneerDeviceLibrary') {
        updateSelectedIcon(target)
      }
    } catch (error) {
      console.error('[librarySelectArea] refresh pioneer drives failed', error)
      pioneerDriveIcons.value = []
    }
  }

  const refreshDesktopLibraryIcon = async () => {
    try {
      const previousIcon = desktopLibraryIcon.value
      const probe = await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('desktop', 'probe')
      )
      if (!probe?.available || !probe?.sourceRootPath) {
        clearRekordboxSourceCachesByKind('desktop')
        desktopLibraryIcon.value = null
        if (runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop') {
          clearSelection()
          switchBackToFilterLibraryAfterExit()
        }
        return
      }

      const desktopLabel = t('library.rekordboxDesktopLibrary')
      desktopLibraryIcon.value = {
        key: String(probe.sourceKey || 'rekordbox-desktop').trim(),
        name: desktopLabel,
        grey: rekordboxDesktopIconAsset,
        white: rekordboxDesktopIconAsset,
        src: rekordboxDesktopIconAsset,
        showAlt: false,
        tooltip: desktopLabel,
        rootPath: String(probe.sourceRootPath || '').trim(),
        i18nKey: 'library.rekordboxDesktopLibrary'
      }

      const previousCacheKey = resolveDesktopLibrarySourceCacheKey(previousIcon)
      const nextCacheKey = resolveDesktopLibrarySourceCacheKey(desktopLibraryIcon.value)
      if (previousCacheKey && nextCacheKey && previousCacheKey !== nextCacheKey) {
        clearRekordboxSourceCache(previousCacheKey)
      }

      if (
        runtime.libraryAreaSelected === 'PioneerDeviceLibrary' &&
        runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop' &&
        runtime.pioneerDeviceLibrary.selectedSourceKey === desktopLibraryIcon.value.key
      ) {
        updateSelectedIcon(desktopLibraryIcon.value)
      }
    } catch (error) {
      console.error('[librarySelectArea] refresh desktop rekordbox failed', error)
      desktopLibraryIcon.value = null
    }
  }

  const shouldAutoRefreshSources = () => {
    if (typeof document === 'undefined') return true
    if (document.visibilityState !== 'visible') return false
    try {
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
        return false
      }
    } catch {}
    return true
  }

  const refreshRekordboxSourceIcons = async (options: { force?: boolean } = {}) => {
    if (!options.force && !shouldAutoRefreshSources()) return
    if (refreshInFlight) {
      await refreshInFlight
      return
    }

    const task = (async () => {
      await Promise.all([refreshPioneerDriveIcons(), refreshDesktopLibraryIcon()])
    })()
    refreshInFlight = task
    try {
      await task
    } finally {
      if (refreshInFlight === task) {
        refreshInFlight = null
      }
    }
  }

  const clickPioneerDriveIcon = async (item: PioneerDriveIcon) => {
    if (!item.path) return
    const sourceCacheKey = resolvePioneerDriveSourceCacheKey(item)
    const cachedTree = getCachedRekordboxSourceTree(sourceCacheKey)
    const preferredPlaylistId =
      runtime.pioneerDeviceLibrary.selectedSourceKind === 'usb' &&
      runtime.pioneerDeviceLibrary.selectedSourceKey === item.key &&
      runtime.pioneerDeviceLibrary.selectedLibraryType === item.libraryType
        ? Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
        : getRememberedRekordboxSourceSelectedPlaylist(sourceCacheKey)
    const restoredPlaylistId = cachedTree
      ? resolvePlaylistIdForTree(cachedTree.treeNodes, preferredPlaylistId)
      : 0

    runtime.pioneerDeviceLibrary.selectedSourceKey = item.key
    runtime.pioneerDeviceLibrary.selectedSourceName = item.tooltip
    runtime.pioneerDeviceLibrary.selectedSourceRootPath = item.path
    runtime.pioneerDeviceLibrary.selectedSourceKind = 'usb'
    runtime.pioneerDeviceLibrary.selectedLibraryType = item.libraryType
    runtime.pioneerDeviceLibrary.selectedPlaylistId = restoredPlaylistId
    runtime.pioneerDeviceLibrary.loading = !cachedTree
    runtime.pioneerDeviceLibrary.treeNodes = cachedTree ? cachedTree.treeNodes : []
    runtime.songsArea.songListUUID = ''
    updateSelectedIcon(item)
    runtime.libraryAreaSelected = 'PioneerDeviceLibrary'
    emitLibrarySelectedChange({ name: 'PioneerDeviceLibrary' })

    if (cachedTree && !shouldRefreshRekordboxSourceTree(sourceCacheKey)) return

    const task = loadSourceTree({
      sourceKind: 'usb',
      sourceKey: item.key,
      sourceCacheKey,
      rootPath: item.path,
      libraryType: item.libraryType,
      preferredPlaylistId,
      hasCachedTree: Boolean(cachedTree),
      fallbackSourceName: item.tooltip,
      loadTree: () =>
        window.electron.ipcRenderer.invoke(
          buildRekordboxSourceChannel('usb', 'load-tree'),
          item.path,
          item.libraryType
        ) as Promise<RekordboxSourceTreeLoadResult>,
      loadTreeFailedMessage: t('pioneer.loadTreeFailed'),
      resolveSourceName: (result) => String(result?.driveName || '').trim() || item.tooltip,
      resolveRootPath: () => item.path
    })
    if (!cachedTree) {
      await task
    } else {
      void task
    }
  }

  const clickDesktopLibraryIcon = async () => {
    const icon = desktopLibraryIcon.value
    if (!icon?.rootPath) return
    const sourceCacheKey = resolveDesktopLibrarySourceCacheKey(icon)
    const cachedTree = getCachedRekordboxSourceTree(sourceCacheKey)
    const preferredPlaylistId =
      runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop' &&
      runtime.pioneerDeviceLibrary.selectedSourceKey === icon.key
        ? Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
        : getRememberedRekordboxSourceSelectedPlaylist(sourceCacheKey)
    const restoredPlaylistId = cachedTree
      ? resolvePlaylistIdForTree(cachedTree.treeNodes, preferredPlaylistId)
      : 0

    runtime.pioneerDeviceLibrary.selectedSourceKey = icon.key
    runtime.pioneerDeviceLibrary.selectedSourceName = t('library.rekordboxDesktopLibrary')
    runtime.pioneerDeviceLibrary.selectedSourceRootPath = icon.rootPath
    runtime.pioneerDeviceLibrary.selectedSourceKind = 'desktop'
    runtime.pioneerDeviceLibrary.selectedLibraryType = 'masterDb'
    runtime.pioneerDeviceLibrary.selectedPlaylistId = restoredPlaylistId
    runtime.pioneerDeviceLibrary.loading = !cachedTree
    runtime.pioneerDeviceLibrary.treeNodes = cachedTree ? cachedTree.treeNodes : []
    runtime.songsArea.songListUUID = ''
    updateSelectedIcon(icon)
    runtime.libraryAreaSelected = 'PioneerDeviceLibrary'
    emitLibrarySelectedChange({ name: 'PioneerDeviceLibrary' })

    if (cachedTree && !shouldRefreshRekordboxSourceTree(sourceCacheKey)) return

    const task = loadSourceTree({
      sourceKind: 'desktop',
      sourceKey: icon.key,
      sourceCacheKey,
      rootPath: icon.rootPath,
      libraryType: 'masterDb',
      preferredPlaylistId,
      hasCachedTree: Boolean(cachedTree),
      fallbackSourceName: t('library.rekordboxDesktopLibrary'),
      loadTree: () =>
        window.electron.ipcRenderer.invoke(
          buildRekordboxSourceChannel('desktop', 'load-tree')
        ) as Promise<RekordboxSourceTreeLoadResult>,
      loadTreeFailedMessage: t('rekordboxDesktop.loadTreeFailed'),
      resolveSourceName: () => t('library.rekordboxDesktopLibrary'),
      resolveRootPath: (result) => String(result?.sourceRootPath || '').trim() || icon.rootPath
    })
    if (!cachedTree) {
      await task
    } else {
      void task
    }
  }

  const isEjectingPioneerDriveIcon = (item: PioneerDriveIcon) =>
    ejectingDriveKeys.value.includes(item.key)

  const suspendSelectedPioneerDriveBeforeEject = async (item: PioneerDriveIcon) => {
    if (runtime.pioneerDeviceLibrary.selectedSourceKey !== item.key) return null

    const snapshot = snapshotSelection()
    clearSelection()
    if (runtime.libraryAreaSelected === 'PioneerDeviceLibrary') {
      runtime.songsArea.songListUUID = ''
    }

    await nextTick()
    await waitForUiIdle(250)
    return snapshot
  }

  const buildPioneerDriveEjectErrorContent = (result?: PioneerDriveEjectResult) => {
    if (result?.code === 'INVALID_PATH') {
      return [t('library.ejectUsbDriveInvalidPath')]
    }

    const content = [t('library.ejectUsbDriveFailed')]
    const detail = String(result?.detail || '').trim()
    if (detail) {
      content.push(detail)
    }
    if (result?.code === 'EJECT_TIMEOUT' || result?.code === 'EJECT_COMMAND_FAILED') {
      content.push(t('library.ejectUsbDriveFailedHint'))
    }
    return content
  }

  const ejectPioneerDriveIcon = async (item: PioneerDriveIcon) => {
    if (isEjectingPioneerDriveIcon(item)) return
    ejectingDriveKeys.value = [...ejectingDriveKeys.value, item.key]
    const suspendedSelection = await suspendSelectedPioneerDriveBeforeEject(item)
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('usb', 'eject-drive'),
        item.path
      )) as PioneerDriveEjectResult

      if (!result?.success) {
        await confirm({
          title: t('common.error'),
          content: buildPioneerDriveEjectErrorContent(result),
          confirmShow: false,
          innerHeight: 0,
          canCopyText: true
        })
        if (suspendedSelection) {
          restoreSelection(suspendedSelection)
        }
        return
      }

      if (suspendedSelection || runtime.pioneerDeviceLibrary.selectedSourceKey === item.key) {
        clearSelection()
        switchBackToFilterLibraryAfterExit()
      }
      clearRekordboxSourceCache(resolvePioneerDriveSourceCacheKey(item))
      pioneerDriveIcons.value = pioneerDriveIcons.value.filter((icon) => icon.key !== item.key)
      await refreshPioneerDriveIcons()
    } catch (error) {
      if (suspendedSelection) {
        restoreSelection(suspendedSelection)
      }
      await confirm({
        title: t('common.error'),
        content: buildPioneerDriveEjectErrorContent({
          success: false,
          path: item.path,
          code: 'EJECT_COMMAND_FAILED',
          detail: getErrorMessage(error, '')
        }),
        confirmShow: false,
        innerHeight: 0,
        canCopyText: true
      })
    } finally {
      ejectingDriveKeys.value = ejectingDriveKeys.value.filter((key) => key !== item.key)
    }
  }

  const handlePioneerDriveContextmenu = async (event: MouseEvent, item: PioneerDriveIcon) => {
    if (isEjectingPioneerDriveIcon(item)) return
    event.preventDefault()
    const result = await rightClickMenu({
      menuArr: [[{ menuName: 'library.ejectUsbDrive' }]],
      clickEvent: event
    })
    if (result === 'cancel') return
    if (result.menuName === 'library.ejectUsbDrive') {
      await ejectPioneerDriveIcon(item)
    }
  }

  const isSelectedPioneerDriveIcon = (item: PioneerDriveIcon) =>
    runtime.libraryAreaSelected === 'PioneerDeviceLibrary' &&
    runtime.pioneerDeviceLibrary.selectedSourceKind === 'usb' &&
    runtime.pioneerDeviceLibrary.selectedSourceKey === item.key

  const isSelectedDesktopLibraryIcon = computed(
    () =>
      runtime.libraryAreaSelected === 'PioneerDeviceLibrary' &&
      runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop' &&
      runtime.pioneerDeviceLibrary.selectedSourceKey === desktopLibraryIcon.value?.key
  )

  const handleWindowFocus = () => {
    void refreshRekordboxSourceIcons()
  }

  const handleDocumentVisibilityChange = () => {
    if (typeof document === 'undefined') return
    if (document.visibilityState !== 'visible') return
    void refreshRekordboxSourceIcons()
  }

  onMounted(() => {
    void refreshRekordboxSourceIcons({ force: true })
    refreshTimer = setInterval(() => {
      void refreshRekordboxSourceIcons()
    }, SOURCE_ICON_AUTO_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', handleWindowFocus)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleDocumentVisibilityChange)
    }
  })

  onUnmounted(() => {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
    window.removeEventListener('focus', handleWindowFocus)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleDocumentVisibilityChange)
    }
  })

  watch(
    () => runtime.libraryAreaSelected,
    (next) => {
      if (next !== 'PioneerDeviceLibrary') return
      void refreshRekordboxSourceIcons({ force: true })
    }
  )

  return {
    pioneerDriveIcons,
    pioneerDriveGroups,
    desktopLibraryIcon,
    refreshRekordboxSourceIcons,
    clickPioneerDriveIcon,
    clickDesktopLibraryIcon,
    handlePioneerDriveContextmenu,
    isEjectingPioneerDriveIcon,
    isSelectedPioneerDriveIcon,
    isSelectedDesktopLibraryIcon
  }
}
