<script setup lang="ts">
import listIconAsset from '@renderer/assets/list.svg?asset'
import likeIconAsset from '@renderer/assets/like.svg?asset'
import settingIconAsset from '@renderer/assets/setting.svg?asset'
import trashIconAsset from '@renderer/assets/trash.svg?asset'
import mixtapeIconAsset from '@renderer/assets/mixtape.svg?asset'
import usbDriveIconAsset from '@renderer/assets/usbDrive.svg?asset'
import rekordboxDesktopIconAsset from '@renderer/assets/rekordboxDesktop.svg?asset'
import {
  computed,
  ref,
  reactive,
  watch,
  nextTick,
  onMounted,
  onUnmounted,
  useTemplateRef
} from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import settingDialog from '@renderer/components/settingDialog.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { t } from '@renderer/utils/translate'
import type { Icon, IDir, IMetadataAutoFillSummary } from '../../../../types/globals'
import tempListIconAsset from '@renderer/assets/tempList.svg?asset'
import rightClickMenu from '@renderer/components/rightClickMenu'
import confirm from '@renderer/components/confirmDialog'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import emitter from '@renderer/utils/mitt'
import libraryUtils from '@renderer/utils/libraryUtils'
import {
  collectFilesForAudioConvert,
  startAudioConvertFromFiles
} from '@renderer/utils/audioConvertActions'
import { emptyRecycleBinWithOptimisticUpdate } from '@renderer/utils/recycleBinActions'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { useRekordboxSourceIcons } from './librarySelectArea/useRekordboxSourceIcons'
const emit = defineEmits(['librarySelectedChange'])

type HoverableIcon = {
  name: string
  grey: string
  white: string
  src: string
  showAlt: boolean
  i18nKey?: string
}

type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null
type ComponentWithElement = ComponentPublicInstance & { $el?: unknown }
type ScanSongListResult = {
  scanData?: Array<{ filePath?: string }>
}

type SongListScanRequest = {
  songListPath: string | string[]
  songListUUID: string
}

const externalIcon: Icon = {
  name: 'ExternalPlaylist',
  grey: tempListIconAsset,
  white: tempListIconAsset,
  src: tempListIconAsset,
  showAlt: false,
  i18nKey: 'library.externalPlaylist'
}

const baseIcons: Icon[] = [
  {
    name: 'FilterLibrary',
    grey: listIconAsset,
    white: listIconAsset,
    src: listIconAsset,
    showAlt: false,
    // i18n key for tooltip
    i18nKey: 'library.filter'
  },
  {
    name: 'CuratedLibrary',
    grey: likeIconAsset,
    white: likeIconAsset,
    src: likeIconAsset,
    showAlt: false,
    i18nKey: 'library.curated'
  },
  {
    name: 'MixtapeLibrary',
    grey: mixtapeIconAsset,
    white: mixtapeIconAsset,
    src: mixtapeIconAsset,
    showAlt: false,
    i18nKey: 'library.mixtapeLibrary'
  },
  {
    name: 'RecycleBin',
    grey: trashIconAsset,
    white: trashIconAsset,
    src: trashIconAsset,
    showAlt: false,
    i18nKey: 'recycleBin.recycleBin'
  }
]

const iconArr = ref<Icon[]>([...baseIcons])
const coreIconNameSet = new Set(['FilterLibrary', 'CuratedLibrary', 'MixtapeLibrary', 'RecycleBin'])
const coreIconArr = computed(() => iconArr.value.filter((item) => coreIconNameSet.has(item.name)))
const dynamicIconArr = computed(() =>
  iconArr.value.filter((item) => !coreIconNameSet.has(item.name))
)
const hasDynamicEntries = computed(
  () =>
    dynamicIconArr.value.length > 0 ||
    Boolean(desktopLibraryIcon.value) ||
    pioneerDriveGroups.value.length > 0
)

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
const scrollItemRefMap = reactive<Record<string, HTMLElement | null>>({})
const resolveRefDom = (el: Element | ComponentPublicInstance | null) => {
  let dom: HTMLElement | null = null
  if (el) {
    if (el instanceof HTMLElement) {
      dom = el
    } else if ((el as ComponentWithElement).$el instanceof HTMLElement) {
      dom = (el as ComponentWithElement).$el
    }
  }
  return dom
}
const setIconRef = (name: string, el: Element | ComponentPublicInstance | null) => {
  const dom = resolveRefDom(el)
  iconRefMap[name] = dom
}
const setScrollItemRef = (name: string, el: Element | ComponentPublicInstance | null) => {
  const dom = resolveRefDom(el)
  scrollItemRefMap[name] = dom
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
  return runtime.libraryTree.children?.find((item: IDir) => item.dirName === libraryName)
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
      const scan = (await window.electron.ipcRenderer.invoke(
        'scanSongList',
        dirPath,
        list.uuid
      )) as ScanSongListResult | null
      const songFiles = Array.isArray(scan?.scanData)
        ? scan.scanData.map((s) => s.filePath).filter((item): item is string => !!item)
        : []
      files.push(...songFiles)
    } catch (error) {
      console.error('[librarySelectArea] scanSongList failed', error)
    }
  }
  return Array.from(new Set(files))
}

const buildSongListScanRequests = (songLists: IDir[]): SongListScanRequest[] =>
  songLists.map((list) => ({
    songListPath: libraryUtils.findDirPathByUuid(list.uuid),
    songListUUID: list.uuid
  }))

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
  let summary: IMetadataAutoFillSummary | null = null
  let hadError = false
  try {
    summary = await invokeMetadataAutoFill(files)
  } catch (error: unknown) {
    hadError = true
    const message =
      error instanceof Error && error.message.trim() ? error.message : t('common.unknownError')
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
      ?.filter((item) => item.status === 'applied' && item.updatedSongInfo)
      .map((item) => ({
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
  const commonMenus = [
    [{ menuName: 'metadata.autoFillMenu' }],
    [{ menuName: 'tracks.convertNonMp3ToMp3' }]
  ]
  if (item.name === 'RecycleBin') {
    return [[{ menuName: 'recycleBin.emptyRecycleBin' }], ...commonMenus]
  }
  return commonMenus
}

const handleConvertLibraryToMp3 = async (libraryName: string) => {
  const libraryNode = findLibraryNode(libraryName)
  const songLists = collectSongLists(libraryNode)
  if (!songLists.length) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('convert.noNonMp3Files')],
      confirmShow: false
    })
    return
  }
  const files = await collectFilesForAudioConvert(buildSongListScanRequests(songLists))
  const result = await startAudioConvertFromFiles({
    files,
    allowedSourceExts: runtime.setting.audioExt,
    presetTargetFormat: 'mp3',
    lockTargetFormat: true,
    excludeSameFormatAsTarget: true
  })
  if (result.status === 'no-files') {
    await confirm({
      title: t('dialog.hint'),
      content: [t('convert.noNonMp3Files')],
      confirmShow: false
    })
  }
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
    case 'tracks.convertNonMp3ToMp3':
      await handleConvertLibraryToMp3(item.name)
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

const {
  pioneerDriveGroups,
  desktopLibraryIcon,
  clickPioneerDriveIcon,
  clickDesktopLibraryIcon,
  handlePioneerDriveContextmenu,
  isEjectingPioneerDriveIcon,
  isSelectedPioneerDriveIcon,
  isSelectedDesktopLibraryIcon
} = useRekordboxSourceIcons({
  runtime,
  usbDriveIconAsset,
  rekordboxDesktopIconAsset,
  updateSelectedIcon,
  waitForUiIdle,
  emitLibrarySelectedChange: (payload) => emit('librarySelectedChange', payload)
})
const dynamicIconsScrollRef = useTemplateRef<OverlayScrollbarsComponentRef>('dynamicIconsScrollRef')
const dynamicScrollState = reactive({
  canScroll: false,
  atTop: true,
  atBottom: true
})
let dynamicScrollViewportEl: HTMLElement | null = null
const updateDynamicScrollState = () => {
  const viewport = dynamicIconsScrollRef.value?.osInstance()?.elements().viewport as
    | HTMLElement
    | undefined
  if (!viewport) {
    dynamicScrollState.canScroll = false
    dynamicScrollState.atTop = true
    dynamicScrollState.atBottom = true
    return
  }
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  dynamicScrollState.canScroll = maxScrollTop > 1
  dynamicScrollState.atTop = viewport.scrollTop <= 1
  dynamicScrollState.atBottom = viewport.scrollTop >= maxScrollTop - 1
}
const handleDynamicScroll = () => {
  updateDynamicScrollState()
}
const syncDynamicScrollViewport = async () => {
  await nextTick()
  const viewport = dynamicIconsScrollRef.value?.osInstance()?.elements().viewport as
    | HTMLElement
    | undefined
  if (dynamicScrollViewportEl !== viewport) {
    dynamicScrollViewportEl?.removeEventListener('scroll', handleDynamicScroll)
    dynamicScrollViewportEl = viewport || null
    dynamicScrollViewportEl?.addEventListener('scroll', handleDynamicScroll, { passive: true })
  }
  updateDynamicScrollState()
}
const selectedDynamicScrollKey = computed(() => {
  if (runtime.libraryAreaSelected === 'PioneerDeviceLibrary') {
    return runtime.pioneerDeviceLibrary.selectedSourceKey || ''
  }
  return dynamicIconArr.value.some((item) => item.name === runtime.libraryAreaSelected)
    ? runtime.libraryAreaSelected
    : ''
})
const scrollSelectedDynamicIconIntoView = async () => {
  const key = selectedDynamicScrollKey.value
  if (!key) return
  await nextTick()
  const viewport = dynamicIconsScrollRef.value?.osInstance()?.elements().viewport as
    | HTMLElement
    | undefined
  const target = scrollItemRefMap[key]
  if (!viewport || !target) return
  target.scrollIntoView({ block: 'nearest' })
  updateDynamicScrollState()
}
onMounted(() => {
  void syncDynamicScrollViewport()
})

onUnmounted(() => {
  dynamicScrollViewportEl?.removeEventListener('scroll', handleDynamicScroll)
  dynamicScrollViewportEl = null
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
      const target =
        (runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop'
          ? desktopLibraryIcon.value
          : null) ||
        pioneerDriveGroups.value
          .flatMap((group) => group.icons)
          .find((icon) => icon.key === runtime.pioneerDeviceLibrary.selectedSourceKey)
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

watch(
  () => [
    hasDynamicEntries.value,
    dynamicIconArr.value.map((item) => item.name).join('|'),
    desktopLibraryIcon.value?.key || '',
    pioneerDriveGroups.value.map((group) => group.icons.map((item) => item.key).join(',')).join('|')
  ],
  () => {
    void syncDynamicScrollViewport()
    void scrollSelectedDynamicIconIntoView()
  },
  { flush: 'post' }
)

watch(
  () => selectedDynamicScrollKey.value,
  () => {
    void scrollSelectedDynamicIconIntoView()
  },
  { flush: 'post' }
)
</script>
<template>
  <div class="librarySelectArea unselectable">
    <div class="librarySelectAreaCore">
      <div
        v-for="item of coreIconArr"
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
            :title="t(item.i18nKey || item.name)"
          />
        </div>
      </div>
    </div>

    <div
      class="librarySelectAreaDynamic"
      :class="{ 'librarySelectAreaDynamic--with-divider': hasDynamicEntries }"
    >
      <div v-if="hasDynamicEntries" class="librarySelectAreaDynamicScrollShell">
        <div
          v-show="dynamicScrollState.canScroll && !dynamicScrollState.atTop"
          class="librarySelectAreaScrollFade librarySelectAreaScrollFade--top"
        ></div>
        <OverlayScrollbarsComponent
          ref="dynamicIconsScrollRef"
          class="librarySelectAreaDynamicScroller"
          :options="{
            scrollbars: {
              autoHide: 'leave' as const,
              autoHideDelay: 50,
              clickScroll: true
            } as const,
            overflow: {
              x: 'hidden',
              y: 'scroll'
            } as const
          }"
          element="div"
          defer
        >
          <div
            v-for="item of dynamicIconArr"
            :key="item.name"
            :ref="(el) => setScrollItemRef(item.name, el)"
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
                :title="t(item.i18nKey || item.name)"
              />
            </div>
          </div>
          <div
            v-if="desktopLibraryIcon"
            :ref="(el) => setScrollItemRef(desktopLibraryIcon?.key || '', el)"
            class="iconBox iconBox--device"
            @click="clickDesktopLibraryIcon()"
            @mouseover="iconMouseover(desktopLibraryIcon)"
            @mouseout="iconMouseout(desktopLibraryIcon)"
          >
            <div
              class="iconBoxAccent"
              :style="{ backgroundColor: isSelectedDesktopLibraryIcon ? 'var(--accent)' : '' }"
            ></div>
            <div class="iconBoxContent">
              <span
                :ref="(el) => setIconRef(desktopLibraryIcon?.key || '', el)"
                :style="getIconMaskStyle(desktopLibraryIcon)"
                :class="[
                  'sidebar-icon',
                  {
                    'is-active': isSelectedDesktopLibraryIcon
                  }
                ]"
              ></span>
              <bubbleBox
                :dom="iconRefMap[desktopLibraryIcon?.key || ''] || undefined"
                :title="desktopLibraryIcon?.tooltip || ''"
                :max-width="320"
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
                  :ref="(el) => setScrollItemRef(item.key, el)"
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
        </OverlayScrollbarsComponent>
        <div
          v-show="dynamicScrollState.canScroll && !dynamicScrollState.atBottom"
          class="librarySelectAreaScrollFade librarySelectAreaScrollFade--bottom"
        ></div>
      </div>
    </div>

    <div class="librarySelectAreaFooter">
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
  flex-direction: column;
  align-items: stretch;

  .librarySelectAreaCore,
  .librarySelectAreaFooter {
    flex: 0 0 auto;
  }

  .librarySelectAreaDynamic {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
  }

  .librarySelectAreaDynamic--with-divider::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 1px;
    background: color-mix(in srgb, var(--border) 88%, transparent);
    pointer-events: none;
    z-index: 2;
  }

  .librarySelectAreaDynamicScrollShell {
    height: 100%;
    position: relative;
  }

  .librarySelectAreaDynamicScroller {
    height: 100%;
    width: 100%;
  }

  .librarySelectAreaFooter {
    padding-top: 0;
    border-top: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
    background: linear-gradient(
      to bottom,
      color-mix(in srgb, var(--bg) 88%, transparent),
      var(--bg)
    );
  }

  .librarySelectAreaScrollFade {
    position: absolute;
    left: 0;
    right: 0;
    height: 18px;
    pointer-events: none;
    z-index: 1;
  }

  .librarySelectAreaScrollFade--top {
    top: 0;
    background: linear-gradient(to bottom, var(--bg), transparent);
  }

  .librarySelectAreaScrollFade--bottom {
    bottom: 0;
    background: linear-gradient(to top, var(--bg), transparent);
  }

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

  :deep(.librarySelectAreaDynamicScroller .os-viewport) {
    overscroll-behavior: contain;
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
