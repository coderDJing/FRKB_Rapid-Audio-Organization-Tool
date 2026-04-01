<script setup lang="ts">
import listIconAsset from '@renderer/assets/list.svg?asset'
import likeIconAsset from '@renderer/assets/like.svg?asset'
import settingIconAsset from '@renderer/assets/setting.svg?asset'
import trashIconAsset from '@renderer/assets/trash.svg?asset'
import mixtapeIconAsset from '@renderer/assets/mixtape.svg?asset'
import usbDriveIconAsset from '@renderer/assets/usbDrive.svg?asset'
import { computed, ref, reactive, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import settingDialog from '@renderer/components/settingDialog.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { t } from '@renderer/utils/translate'
import type {
  Icon,
  IDir,
  IPioneerDeviceLibraryKind,
  IPioneerDeviceLibraryState
} from '../../../../types/globals'
import tempListIconAsset from '@renderer/assets/tempList.svg?asset'
import rightClickMenu from '@renderer/components/rightClickMenu'
import confirm from '@renderer/components/confirmDialog'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import emitter from '@renderer/utils/mitt'
import libraryUtils from '@renderer/utils/libraryUtils'
import { emptyRecycleBinWithOptimisticUpdate } from '@renderer/utils/recycleBinActions'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
const emit = defineEmits(['librarySelectedChange'])

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

type PioneerDriveIcon = HoverableIcon & {
  key: string
  tooltip: string
  path: string
  libraryType: IPioneerDeviceLibraryKind
}

type PioneerDriveGroup = {
  key: string
  path: string
  icons: PioneerDriveIcon[]
}

const externalIcon: Icon = {
  name: 'ExternalPlaylist',
  grey: tempListIconAsset,
  white: tempListIconAsset,
  src: tempListIconAsset,
  showAlt: false,
  i18nKey: 'library.externalPlaylist'
} as any

const baseIcons: Icon[] = [
  {
    name: 'FilterLibrary',
    grey: listIconAsset,
    white: listIconAsset,
    src: listIconAsset,
    showAlt: false,
    // i18n key for tooltip
    i18nKey: 'library.filter'
  } as any,
  {
    name: 'CuratedLibrary',
    grey: likeIconAsset,
    white: likeIconAsset,
    src: likeIconAsset,
    showAlt: false,
    i18nKey: 'library.curated'
  } as any,
  {
    name: 'MixtapeLibrary',
    grey: mixtapeIconAsset,
    white: mixtapeIconAsset,
    src: mixtapeIconAsset,
    showAlt: false,
    i18nKey: 'library.mixtapeLibrary'
  } as any,
  {
    name: 'RecycleBin',
    grey: trashIconAsset,
    white: trashIconAsset,
    src: trashIconAsset,
    showAlt: false,
    i18nKey: 'recycleBin.recycleBin'
  } as any
]

const iconArr = ref<Icon[]>([...baseIcons])

const selectedIcon = ref<HoverableIcon>(iconArr.value[0])
selectedIcon.value.src = selectedIcon.value.white

const runtime = useRuntimeStore()
const hasWarnedAcoustId = ref(false)
const waitForUiIdle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const hasAcoustIdKey = () => {
  const key = (runtime.setting?.acoustIdClientKey || '').trim()
  return key.length > 0
}
const warnAcoustIdMissing = () => {
  if (hasAcoustIdKey() || hasWarnedAcoustId.value) return
  hasWarnedAcoustId.value = true
  void confirm({
    title: t('metadata.autoFillFingerprintHintTitle'),
    content: [
      t('metadata.autoFillFingerprintHintMissing'),
      t('metadata.autoFillFingerprintHintGuide')
    ],
    confirmShow: false
  })
}

const updateSelectedIcon = (item: HoverableIcon | undefined) => {
  if (!item) return
  if (selectedIcon.value && selectedIcon.value !== item) {
    selectedIcon.value.src = selectedIcon.value.grey
  }
  selectedIcon.value = item
  selectedIcon.value.src = selectedIcon.value.white
}

const clickIcon = (item: Icon) => {
  if (item.name == selectedIcon.value.name) {
    runtime.libraryAreaSelected = item.name
    return
  }
  runtime.libraryAreaSelected = item.name
}

const settingDialogShow = ref(false)
const clickButtomIcon = (item: ButtomIcon) => {
  if (item.name === 'settings') {
    settingDialogShow.value = true
  }
}
const iconRefMap = reactive<Record<string, HTMLElement | null>>({})
const setIconRef = (name: string, el: Element | ComponentPublicInstance | null) => {
  let dom: HTMLElement | null = null
  if (el) {
    if (el instanceof HTMLElement) {
      dom = el
    } else if ((el as any).$el instanceof HTMLElement) {
      dom = (el as any).$el as HTMLElement
    }
  }
  iconRefMap[name] = dom
}
const iconMouseover = (item: HoverableIcon) => {
  if (selectedIcon.value != item) {
    item.src = item.white
  }
}
const iconMouseout = (item: HoverableIcon) => {
  if (selectedIcon.value != item) {
    item.src = item.grey
  }
}

const getIconMaskStyle = (item: HoverableIcon) => ({
  '--icon-mask': `url("${item.src}")`
})

const isPlayingLibraryIcon = (item: Icon) => {
  const playingUuid = runtime.playingData.playingSongListUUID
  if (!playingUuid) return false
  if (item.name === 'ExternalPlaylist') return playingUuid === EXTERNAL_PLAYLIST_UUID
  if (item.name === 'RecycleBin' && playingUuid === RECYCLE_BIN_UUID) return true
  const libraryNode = findLibraryNode(item.name)
  if (!libraryNode) return false
  const uuids = libraryUtils.getAllUuids(libraryNode)
  return uuids.includes(playingUuid)
}

const findLibraryNode = (libraryName: string): IDir | undefined => {
  return runtime.libraryTree.children?.find((item: any) => item.dirName === libraryName)
}

const collectSongLists = (root?: IDir | null): IDir[] => {
  const result: IDir[] = []
  const traverse = (node?: IDir | null) => {
    if (!node) return
    if (node.type === 'songList') {
      result.push(node)
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child) => traverse(child as IDir))
    }
  }
  traverse(root)
  return result
}

const scanSongListsFiles = async (songLists: IDir[]) => {
  const files: string[] = []
  for (const list of songLists) {
    try {
      const dirPath = libraryUtils.findDirPathByUuid(list.uuid)
      const scan = await window.electron.ipcRenderer.invoke('scanSongList', dirPath, list.uuid)
      const songFiles = Array.isArray(scan?.scanData)
        ? scan.scanData.map((s: any) => s.filePath).filter(Boolean)
        : []
      files.push(...songFiles)
    } catch (error) {
      console.error('[librarySelectArea] scanSongList failed', error)
    }
  }
  return Array.from(new Set(files))
}

const handleAutoFillForLibrary = async (libraryName: string) => {
  const libraryNode = findLibraryNode(libraryName)
  const songLists = collectSongLists(libraryNode)
  if (!songLists.length) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('metadata.autoFillNoEligible')],
      confirmShow: false
    })
    return
  }
  const files = await scanSongListsFiles(songLists)
  if (!files.length) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('metadata.autoFillNoEligible')],
      confirmShow: false
    })
    return
  }
  warnAcoustIdMissing()
  runtime.isProgressing = true
  let summary: any = null
  let hadError = false
  try {
    summary = await invokeMetadataAutoFill(files)
  } catch (error: any) {
    hadError = true
    const message =
      typeof error?.message === 'string' && error.message.trim().length
        ? error.message
        : t('common.unknownError')
    await confirm({
      title: t('common.error'),
      content: [message],
      confirmShow: false
    })
  } finally {
    runtime.isProgressing = false
  }
  if (!summary) {
    if (!hadError) {
      await confirm({
        title: t('dialog.hint'),
        content: [t('metadata.autoFillNoEligible')],
        confirmShow: false
      })
    }
    return
  }
  const { default: openAutoSummary } = await import(
    '@renderer/components/autoMetadataSummaryDialog'
  )
  await openAutoSummary(summary)
  const updates =
    summary.items
      ?.filter((item: any) => item.status === 'applied' && item.updatedSongInfo)
      .map((item: any) => ({
        song: item.updatedSongInfo,
        oldFilePath: item.oldFilePath
      })) || []
  if (updates.length) {
    try {
      emitter.emit('metadataBatchUpdated', { updates })
    } catch {}
  }
}

const emptyRecycleBinHandleClick = async () => {
  await emptyRecycleBinWithOptimisticUpdate(runtime)
}

const buildMenuArr = (item: Icon) => {
  const commonMenus = [[{ menuName: 'metadata.autoFillMenu' }]]
  if (item.name === 'RecycleBin') {
    return [[{ menuName: 'recycleBin.emptyRecycleBin' }], ...commonMenus]
  }
  return commonMenus
}

const handleIconContextmenu = async (event: MouseEvent, item: Icon) => {
  if (!['FilterLibrary', 'CuratedLibrary', 'RecycleBin'].includes(item.name as string)) return
  event.preventDefault()
  const menuArr = buildMenuArr(item)
  const result = await rightClickMenu({ menuArr, clickEvent: event })
  if (result === 'cancel') return
  switch (result.menuName) {
    case 'metadata.autoFillMenu':
      await handleAutoFillForLibrary(item.name)
      break
    case 'recycleBin.emptyRecycleBin':
      await emptyRecycleBinHandleClick()
      break
  }
}
type ButtomIcon = {
  name: 'settings'
  grey: string
  white: string
  src: string
  showAlt: boolean
  i18nKey?: string
}

const pioneerDriveIcons = ref<PioneerDriveIcon[]>([])
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
let pioneerDriveRefreshTimer: ReturnType<typeof setInterval> | null = null
const ejectingDriveKeys = ref<string[]>([])

const isEjectingPioneerDriveIcon = (item: PioneerDriveIcon) =>
  ejectingDriveKeys.value.includes(item.key)

const getPioneerLibraryTypeLabel = (libraryType: IPioneerDeviceLibraryKind) =>
  libraryType === 'oneLibrary' ? t('pioneer.oneLibraryLabel') : t('pioneer.deviceLibraryLabel')

const restorePioneerDriveSelection = (snapshot: IPioneerDeviceLibraryState) => {
  runtime.pioneerDeviceLibrary.selectedDriveKey = snapshot.selectedDriveKey
  runtime.pioneerDeviceLibrary.selectedDriveName = snapshot.selectedDriveName
  runtime.pioneerDeviceLibrary.selectedDrivePath = snapshot.selectedDrivePath
  runtime.pioneerDeviceLibrary.selectedLibraryType = snapshot.selectedLibraryType
  runtime.pioneerDeviceLibrary.selectedPlaylistId = snapshot.selectedPlaylistId
  runtime.pioneerDeviceLibrary.loading = snapshot.loading
  runtime.pioneerDeviceLibrary.treeNodes = Array.isArray(snapshot.treeNodes)
    ? [...snapshot.treeNodes]
    : []
}

const clearPioneerDriveSelection = () => {
  runtime.pioneerDeviceLibrary.selectedDriveKey = ''
  runtime.pioneerDeviceLibrary.selectedDriveName = ''
  runtime.pioneerDeviceLibrary.selectedDrivePath = ''
  runtime.pioneerDeviceLibrary.selectedLibraryType = ''
  runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
  runtime.pioneerDeviceLibrary.loading = false
  runtime.pioneerDeviceLibrary.treeNodes = []
}

const switchBackToFilterLibraryAfterPioneerExit = () => {
  if (runtime.libraryAreaSelected !== 'PioneerDeviceLibrary') return
  runtime.libraryAreaSelected = 'FilterLibrary'
}

const suspendSelectedPioneerDriveBeforeEject = async (item: PioneerDriveIcon) => {
  if (runtime.pioneerDeviceLibrary.selectedDriveKey !== item.key) return null

  const snapshot: IPioneerDeviceLibraryState = {
    selectedDriveKey: runtime.pioneerDeviceLibrary.selectedDriveKey,
    selectedDriveName: runtime.pioneerDeviceLibrary.selectedDriveName,
    selectedDrivePath: runtime.pioneerDeviceLibrary.selectedDrivePath,
    selectedLibraryType: runtime.pioneerDeviceLibrary.selectedLibraryType,
    selectedPlaylistId: runtime.pioneerDeviceLibrary.selectedPlaylistId,
    loading: runtime.pioneerDeviceLibrary.loading,
    treeNodes: Array.isArray(runtime.pioneerDeviceLibrary.treeNodes)
      ? [...runtime.pioneerDeviceLibrary.treeNodes]
      : []
  }

  runtime.pioneerDeviceLibrary.selectedDriveKey = ''
  runtime.pioneerDeviceLibrary.selectedDriveName = ''
  runtime.pioneerDeviceLibrary.selectedDrivePath = ''
  runtime.pioneerDeviceLibrary.selectedLibraryType = ''
  runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
  runtime.pioneerDeviceLibrary.loading = false
  runtime.pioneerDeviceLibrary.treeNodes = []
  if (runtime.libraryAreaSelected === 'PioneerDeviceLibrary') {
    runtime.songsArea.songListUUID = ''
  }

  await nextTick()
  await waitForUiIdle(250)
  return snapshot
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
      'pioneer-device-library:list-removable-drives'
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

    if (runtime.pioneerDeviceLibrary.selectedDriveKey) {
      const target = nextIcons.find(
        (icon) => icon.key === runtime.pioneerDeviceLibrary.selectedDriveKey
      )
      if (!target) {
        clearPioneerDriveSelection()
        switchBackToFilterLibraryAfterPioneerExit()
        return
      }
      if (runtime.libraryAreaSelected === 'PioneerDeviceLibrary') {
        updateSelectedIcon(target)
      }
    }
  } catch (error) {
    console.error('[librarySelectArea] refresh pioneer drives failed', error)
    pioneerDriveIcons.value = []
  }
}

const clickPioneerDriveIcon = async (item: PioneerDriveIcon) => {
  if (!item.path) return
  runtime.pioneerDeviceLibrary.selectedDriveKey = item.key
  runtime.pioneerDeviceLibrary.selectedDriveName = item.tooltip
  runtime.pioneerDeviceLibrary.selectedDrivePath = item.path
  runtime.pioneerDeviceLibrary.selectedLibraryType = item.libraryType
  runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
  runtime.pioneerDeviceLibrary.loading = true
  runtime.pioneerDeviceLibrary.treeNodes = []
  runtime.songsArea.songListUUID = ''
  updateSelectedIcon(item)
  runtime.libraryAreaSelected = 'PioneerDeviceLibrary'
  emit('librarySelectedChange', { name: 'PioneerDeviceLibrary' })

  try {
    const result = await window.electron.ipcRenderer.invoke(
      'pioneer-device-library:load-tree',
      item.path,
      item.libraryType
    )
    const treeNodes = Array.isArray(result?.treeNodes) ? result.treeNodes : []
    runtime.pioneerDeviceLibrary.treeNodes = treeNodes
    runtime.pioneerDeviceLibrary.selectedDriveName =
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

const buildPioneerDriveMenuArr = () => [[{ menuName: 'library.ejectUsbDrive' }]]

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
      'pioneer-device-library:eject-drive',
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
        restorePioneerDriveSelection(suspendedSelection)
      }
      return
    }

    if (suspendedSelection || runtime.pioneerDeviceLibrary.selectedDriveKey === item.key) {
      clearPioneerDriveSelection()
      switchBackToFilterLibraryAfterPioneerExit()
    }
    pioneerDriveIcons.value = pioneerDriveIcons.value.filter((icon) => icon.key !== item.key)
    await refreshPioneerDriveIcons()
  } catch (error: any) {
    if (suspendedSelection) {
      restorePioneerDriveSelection(suspendedSelection)
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
    menuArr: buildPioneerDriveMenuArr(),
    clickEvent: event
  })
  if (result === 'cancel') return
  if (result.menuName === 'library.ejectUsbDrive') {
    await ejectPioneerDriveIcon(item)
  }
}

const isSelectedPioneerDriveIcon = (item: PioneerDriveIcon) =>
  runtime.libraryAreaSelected === 'PioneerDeviceLibrary' &&
  runtime.pioneerDeviceLibrary.selectedDriveKey === item.key

onMounted(() => {
  void refreshPioneerDriveIcons()
  pioneerDriveRefreshTimer = setInterval(() => {
    void refreshPioneerDriveIcons()
  }, 15000)
  window.addEventListener('focus', refreshPioneerDriveIcons)
})

onUnmounted(() => {
  if (pioneerDriveRefreshTimer) {
    clearInterval(pioneerDriveRefreshTimer)
    pioneerDriveRefreshTimer = null
  }
  window.removeEventListener('focus', refreshPioneerDriveIcons)
})

const buttomIconArr = ref<ButtomIcon[]>([
  {
    name: 'settings',
    grey: settingIconAsset,
    white: settingIconAsset,
    src: settingIconAsset,
    showAlt: false,
    i18nKey: 'common.setting'
  }
])

const libraryHandleClick = (item: Icon) => {
  emit('librarySelectedChange', item)
}

const isMixtapeSourceSongDrag = () => {
  if (
    Array.isArray(runtime.dragSourceMixtapeItemIds) &&
    runtime.dragSourceMixtapeItemIds.length > 0
  ) {
    return true
  }
  const sourceSongListUUID = runtime.dragSourceSongListUUID
  if (!sourceSongListUUID) return false
  return libraryUtils.getLibraryTreeByUUID(sourceSongListUUID)?.type === 'mixtapeList'
}

// 拖拽时的库切换逻辑
const iconDragEnter = (event: DragEvent, item: Icon) => {
  // 检查是否是歌曲拖拽
  const isSongDrag = event.dataTransfer?.types?.includes('application/x-song-drag')
  if (!isSongDrag || item.name === selectedIcon.value.name) return
  // Mixtape 自动录制歌单来源仅允许在 Mixtape 自动录制库内投放，不应悬浮切换到其他库
  if (isMixtapeSourceSongDrag() && item.name !== 'MixtapeLibrary') return
  // 当拖拽歌曲时，自动切换到对应的库
  clickIcon(item)
  // 同时触发库切换事件，通知父组件更新
  libraryHandleClick(item)
}

watch(
  () => runtime.externalPlaylist.songs.length,
  (len) => {
    const exists = iconArr.value.find((icon) => icon.name === 'ExternalPlaylist')
    if (len > 0 && !exists) {
      externalIcon.src = externalIcon.grey
      const recycleIndex = iconArr.value.findIndex((icon) => icon.name === 'RecycleBin')
      if (recycleIndex === -1) {
        iconArr.value.push(externalIcon)
      } else {
        iconArr.value.splice(recycleIndex, 0, externalIcon)
      }
      if (runtime.libraryAreaSelected === 'ExternalPlaylist') {
        updateSelectedIcon(externalIcon)
      }
    } else if (len === 0 && exists) {
      iconArr.value = iconArr.value.filter((icon) => icon.name !== 'ExternalPlaylist')
    }
  },
  { immediate: true }
)

watch(
  () => runtime.libraryAreaSelected,
  (val) => {
    if (val === 'PioneerDeviceLibrary') {
      const target = pioneerDriveIcons.value.find(
        (icon) => icon.key === runtime.pioneerDeviceLibrary.selectedDriveKey
      )
      if (target) {
        updateSelectedIcon(target)
      }
      return
    }
    const target = iconArr.value.find((icon) => icon.name === val)
    if (target) {
      updateSelectedIcon(target)
    }
  },
  { immediate: true }
)
</script>
<template>
  <div class="librarySelectArea unselectable">
    <div>
      <div
        v-for="item of iconArr"
        :key="item.name"
        class="iconBox"
        @click="clickIcon(item)"
        @contextmenu.stop.prevent="handleIconContextmenu($event, item)"
        @mouseover="iconMouseover(item)"
        @mouseout="iconMouseout(item)"
        @dragenter="iconDragEnter($event, item)"
      >
        <div
          class="iconBoxAccent"
          :style="{ backgroundColor: item.name == selectedIcon.name ? 'var(--accent)' : '' }"
        ></div>
        <div class="iconBoxContent" @click="libraryHandleClick(item)">
          <span
            :ref="(el) => setIconRef(item.name, el)"
            :style="getIconMaskStyle(item)"
            :class="[
              'sidebar-icon',
              {
                'is-active': item.name === selectedIcon.name,
                'is-playing': isPlayingLibraryIcon(item)
              }
            ]"
          ></span>
          <bubbleBox
            :dom="iconRefMap[item.name] || undefined"
            :title="t((item as any).i18nKey || item.name)"
          />
        </div>
      </div>
      <div
        v-for="group of pioneerDriveGroups"
        :key="group.key"
        class="deviceGroup"
        :class="{
          'deviceGroup--selected': group.icons.some((item) => isSelectedPioneerDriveIcon(item)),
          'deviceGroup--multi': group.icons.length > 1
        }"
      >
        <div class="deviceGroupInner">
          <template v-for="item of group.icons" :key="item.key">
            <div
              class="iconBox iconBox--device iconBox--device-group"
              :class="{ 'is-ejecting': isEjectingPioneerDriveIcon(item) }"
              @click="isEjectingPioneerDriveIcon(item) ? null : clickPioneerDriveIcon(item)"
              @contextmenu.stop.prevent="handlePioneerDriveContextmenu($event, item)"
              @mouseover="iconMouseover(item)"
              @mouseout="iconMouseout(item)"
            >
              <div
                class="iconBoxAccent"
                :style="{
                  backgroundColor: isSelectedPioneerDriveIcon(item) ? 'var(--accent)' : ''
                }"
              ></div>
              <div class="iconBoxContent">
                <span
                  :ref="(el) => setIconRef(item.key, el)"
                  :style="getIconMaskStyle(item)"
                  :class="[
                    'sidebar-icon',
                    {
                      'is-active': isSelectedPioneerDriveIcon(item),
                      'is-ejecting': isEjectingPioneerDriveIcon(item)
                    }
                  ]"
                ></span>
                <bubbleBox
                  :dom="iconRefMap[item.key] || undefined"
                  :title="
                    isEjectingPioneerDriveIcon(item)
                      ? t('library.ejectUsbDriveProgress')
                      : item.tooltip
                  "
                  :max-width="320"
                />
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
    <div>
      <div
        v-for="item of buttomIconArr"
        :key="item.name"
        class="iconBox"
        @click="clickButtomIcon(item)"
        @mouseover="iconMouseover(item)"
        @mouseout="iconMouseout(item)"
      >
        <div class="iconBoxAccent"></div>
        <div class="iconBoxContent">
          <span
            :ref="(el) => setIconRef(item.name, el)"
            :style="getIconMaskStyle(item)"
            :class="['sidebar-icon']"
          ></span>
          <bubbleBox
            :dom="iconRefMap[item.name] || undefined"
            :title="t(item.i18nKey || 'common.setting')"
          />
        </div>
      </div>
    </div>
    <settingDialog v-if="settingDialogShow" @cancel="settingDialogShow = false" />
  </div>
</template>
<style lang="scss" scoped>
.librarySelectArea {
  height: 100%;
  width: 45px;
  border-right: 1px solid var(--border);
  background-color: var(--bg);
  display: flex;
  justify-content: space-between;
  flex-direction: column;

  .fade-enter-active,
  .fade-leave-active {
    transition: opacity 0.15s;
  }

  .fade-enter,
  .fade-leave-to {
    opacity: 0;
  }

  .iconBox {
    width: 45px;
    height: 45px;
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;

    .iconBoxAccent {
      width: 2px;
      height: 100%;
      flex: 0 0 2px;
    }

    .iconBoxContent {
      flex-grow: 1;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
      position: relative;
    }

    .sidebar-icon {
      width: 25px;
      height: 25px;
      display: inline-block;
      position: relative;
      opacity: 0.55;
      background-color: currentColor;
      color: var(--text);
      mask-image: var(--icon-mask);
      mask-repeat: no-repeat;
      mask-position: center;
      mask-size: contain;
      -webkit-mask-image: var(--icon-mask);
      -webkit-mask-repeat: no-repeat;
      -webkit-mask-position: center;
      -webkit-mask-size: contain;
      transition:
        opacity 0.15s ease,
        color 0.15s ease;
    }

    .sidebar-icon.is-ejecting {
      opacity: 0.82;
    }

    .sidebar-icon.is-ejecting::after {
      content: '';
      position: absolute;
      width: 6px;
      height: 6px;
      right: -2px;
      bottom: -1px;
      border-radius: 999px;
      background-color: var(--accent);
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 24%, transparent);
      animation: usb-drive-eject-dot 1.15s ease-in-out infinite;
      pointer-events: none;
    }

    &:hover .sidebar-icon {
      opacity: 0.85;
    }

    .sidebar-icon.is-active {
      opacity: 1;
    }

    .sidebar-icon.is-playing {
      opacity: 1;
      color: var(--accent);
    }

    &.iconBox--device.is-ejecting {
      cursor: progress;
    }

    &.iconBox--device-group {
      height: 39px;
    }
  }

  .deviceGroup {
    --device-connector-x: 6px;
    --device-connector-branch-width: 4px;
    width: 45px;
    display: flex;
    justify-content: center;
    padding: 4px 0;
  }

  .deviceGroupInner {
    width: 45px;
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
  }

  .deviceGroup--multi .deviceGroupInner::before {
    content: '';
    position: absolute;
    top: 19.5px;
    bottom: 19.5px;
    left: var(--device-connector-x);
    width: 1.5px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--border) 78%, transparent);
    pointer-events: none;
  }

  .deviceGroup--multi .iconBox--device-group::before {
    content: '';
    position: absolute;
    left: var(--device-connector-x);
    top: 50%;
    width: var(--device-connector-branch-width);
    height: 1.5px;
    transform: translateY(-50%);
    border-radius: 999px;
    background: color-mix(in srgb, var(--border) 78%, transparent);
    pointer-events: none;
  }

  .deviceGroup--selected.deviceGroup--multi .deviceGroupInner::before,
  .deviceGroup--selected.deviceGroup--multi .iconBox--device-group::before {
    background: color-mix(in srgb, var(--accent) 52%, var(--border));
  }

  .bubbleBox {
    height: 22px;
    line-height: 22px;
    text-align: center;
    position: relative;
    border-radius: 3px;
    border: 1px solid var(--border);
    font-size: 12px;
    background-color: var(--bg-elev);
    padding: 0 10px;
  }

  .bubbleBox::before {
    content: '';
    position: absolute;
    width: 0;
    height: 0;
    top: 5px;
    left: -5px;
    border-top: 5px solid transparent;
    border-bottom: 5px solid transparent;
    border-right: 5px solid var(--border);
  }

  @keyframes usb-drive-eject-dot {
    0%,
    100% {
      opacity: 0.45;
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 12%, transparent);
    }

    50% {
      opacity: 1;
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 0%, transparent);
    }
  }
}
</style>
