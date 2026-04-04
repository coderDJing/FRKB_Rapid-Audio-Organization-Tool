import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import rightClickMenu from '@renderer/components/rightClickMenu'
import { t } from '@renderer/utils/translate'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type {
  IPioneerDeviceLibraryKind,
  IRekordboxLibraryBrowserState
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

  const refreshPioneerDriveIcons = async () => {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('usb', 'list-removable-drives')
      )
      const drives = Array.isArray(result) ? (result as PioneerDriveEntry[]) : []
      pioneerDriveIcons.value = drives
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
      const probe = await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('desktop', 'probe')
      )
      if (!probe?.available || !probe?.sourceRootPath) {
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

  const refreshRekordboxSourceIcons = async () => {
    await Promise.all([refreshPioneerDriveIcons(), refreshDesktopLibraryIcon()])
  }

  const clickPioneerDriveIcon = async (item: PioneerDriveIcon) => {
    if (!item.path) return
    runtime.pioneerDeviceLibrary.selectedSourceKey = item.key
    runtime.pioneerDeviceLibrary.selectedSourceName = item.tooltip
    runtime.pioneerDeviceLibrary.selectedSourceRootPath = item.path
    runtime.pioneerDeviceLibrary.selectedSourceKind = 'usb'
    runtime.pioneerDeviceLibrary.selectedLibraryType = item.libraryType
    runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
    runtime.pioneerDeviceLibrary.loading = true
    runtime.pioneerDeviceLibrary.treeNodes = []
    runtime.songsArea.songListUUID = ''
    updateSelectedIcon(item)
    runtime.libraryAreaSelected = 'PioneerDeviceLibrary'
    emitLibrarySelectedChange({ name: 'PioneerDeviceLibrary' })

    try {
      const result = await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('usb', 'load-tree'),
        item.path,
        item.libraryType
      )
      runtime.pioneerDeviceLibrary.treeNodes = Array.isArray(result?.treeNodes)
        ? result.treeNodes
        : []
      runtime.pioneerDeviceLibrary.selectedSourceName =
        String(result?.driveName || '').trim() || item.tooltip
    } catch (error: any) {
      runtime.pioneerDeviceLibrary.treeNodes = []
      await confirm({
        title: t('common.error'),
        content: [String(error?.message || error || t('pioneer.loadTreeFailed'))],
        confirmShow: false
      })
    } finally {
      runtime.pioneerDeviceLibrary.loading = false
    }
  }

  const clickDesktopLibraryIcon = async () => {
    const icon = desktopLibraryIcon.value
    if (!icon?.rootPath) return
    runtime.pioneerDeviceLibrary.selectedSourceKey = icon.key
    runtime.pioneerDeviceLibrary.selectedSourceName = t('library.rekordboxDesktopLibrary')
    runtime.pioneerDeviceLibrary.selectedSourceRootPath = icon.rootPath
    runtime.pioneerDeviceLibrary.selectedSourceKind = 'desktop'
    runtime.pioneerDeviceLibrary.selectedLibraryType = 'masterDb'
    runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
    runtime.pioneerDeviceLibrary.loading = true
    runtime.pioneerDeviceLibrary.treeNodes = []
    runtime.songsArea.songListUUID = ''
    updateSelectedIcon(icon)
    runtime.libraryAreaSelected = 'PioneerDeviceLibrary'
    emitLibrarySelectedChange({ name: 'PioneerDeviceLibrary' })

    try {
      const result = await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('desktop', 'load-tree')
      )
      runtime.pioneerDeviceLibrary.treeNodes = Array.isArray(result?.treeNodes)
        ? result.treeNodes
        : []
      runtime.pioneerDeviceLibrary.selectedSourceName = t('library.rekordboxDesktopLibrary')
      runtime.pioneerDeviceLibrary.selectedSourceRootPath =
        String(result?.sourceRootPath || '').trim() || icon.rootPath
    } catch (error: any) {
      runtime.pioneerDeviceLibrary.treeNodes = []
      await confirm({
        title: t('common.error'),
        content: [String(error?.message || error || t('rekordboxDesktop.loadTreeFailed'))],
        confirmShow: false
      })
    } finally {
      runtime.pioneerDeviceLibrary.loading = false
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
      pioneerDriveIcons.value = pioneerDriveIcons.value.filter((icon) => icon.key !== item.key)
      await refreshPioneerDriveIcons()
    } catch (error: any) {
      if (suspendedSelection) {
        restoreSelection(suspendedSelection)
      }
      await confirm({
        title: t('common.error'),
        content: buildPioneerDriveEjectErrorContent({
          success: false,
          path: item.path,
          code: 'EJECT_COMMAND_FAILED',
          detail: String(error?.message || error || '')
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

  onMounted(() => {
    void refreshRekordboxSourceIcons()
    refreshTimer = setInterval(() => {
      void refreshRekordboxSourceIcons()
    }, 15000)
    window.addEventListener('focus', refreshRekordboxSourceIcons)
  })

  onUnmounted(() => {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
    window.removeEventListener('focus', refreshRekordboxSourceIcons)
  })

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
