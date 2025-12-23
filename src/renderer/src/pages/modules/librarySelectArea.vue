<script setup lang="ts">
import listGrey from '@renderer/assets/list-grey.png?asset'
import listWhite from '@renderer/assets/list-white.png?asset'
import likeGrey from '@renderer/assets/like-grey.png?asset'
import likeWhite from '@renderer/assets/like-white.png?asset'
import settingGrey from '@renderer/assets/setting-grey.png?asset'
import settingWhite from '@renderer/assets/setting-white.png?asset'
import trashGrey from '@renderer/assets/trash-grey.png?asset'
import trashWhite from '@renderer/assets/trash-white.png?asset'
import { ref, reactive, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import settingDialog from '@renderer/components/settingDialog.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { t } from '@renderer/utils/translate'
import type { Icon, IDir } from '../../../../types/globals'
import tempListGrey from '@renderer/assets/tempList-grey.png?asset'
import tempListWhite from '@renderer/assets/tempList-white.png?asset'
import rightClickMenu from '@renderer/components/rightClickMenu'
import confirm from '@renderer/components/confirmDialog'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import emitter from '@renderer/utils/mitt'
import libraryUtils from '@renderer/utils/libraryUtils'
import { setSelectionLabelForFilePathsBatched } from '@renderer/utils/selectionActions'
const emit = defineEmits(['librarySelectedChange'])

const baseIcons: Icon[] = [
  {
    name: 'FilterLibrary',
    grey: listGrey,
    white: listWhite,
    src: listGrey,
    showAlt: false,
    // i18n key for tooltip
    i18nKey: 'library.filter'
  } as any,
  {
    name: 'CuratedLibrary',
    grey: likeGrey,
    white: likeWhite,
    src: likeGrey,
    showAlt: false,
    i18nKey: 'library.curated'
  } as any,
  {
    name: 'RecycleBin',
    grey: trashGrey,
    white: trashWhite,
    src: trashGrey,
    showAlt: false,
    i18nKey: 'recycleBin.recycleBin'
  } as any
]

const externalIcon: Icon = {
  name: 'ExternalPlaylist',
  grey: tempListGrey,
  white: tempListWhite,
  src: tempListGrey,
  showAlt: false,
  i18nKey: 'library.externalPlaylist'
} as any

const iconArr = ref<Icon[]>([...baseIcons])

const selectedIcon = ref(iconArr.value[0])
selectedIcon.value.src = selectedIcon.value.white

const runtime = useRuntimeStore()
const hasWarnedAcoustId = ref(false)
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

const updateSelectedIcon = (item: Icon | undefined) => {
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
  if (item.name == '设置') {
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
const iconMouseover = (item: Icon | ButtomIcon) => {
  if (selectedIcon.value != item) {
    item.src = item.white
  }
}
const iconMouseout = (item: Icon | ButtomIcon) => {
  if (selectedIcon.value != item) {
    item.src = item.grey
  }
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
      console.error('[librarySelectArea] scanSongList 失败', error)
    }
  }
  return Array.from(new Set(files))
}

const handleBulkLabelForLibrary = async (libraryName: string, label: 'liked' | 'disliked') => {
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

  try {
    emitter.emit('selectionLabelsChanged', { filePaths: files, label })
  } catch {}

  const summary = await setSelectionLabelForFilePathsBatched({
    filePaths: files,
    label,
    batchSize: 200,
    concurrency: 2
  })

  if (summary.failedBatches > 0) {
    await confirm({
      title: t('common.error'),
      content: [
        t('selection.bulkDoneWithErrors', {
          okBatches: summary.okBatches,
          failedBatches: summary.failedBatches
        }),
        summary.firstErrorMessage || t('common.unknownError')
      ],
      confirmShow: false
    })
  }
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

const clearCachesForLibrary = async (libraryName: string) => {
  const libraryNode = findLibraryNode(libraryName)
  const songLists = collectSongLists(libraryNode)
  if (!songLists.length) return
  for (const list of songLists) {
    try {
      const dirPath = libraryUtils.findDirPathByUuid(list.uuid)
      await window.electron.ipcRenderer.invoke('playlist:cache:clear', dirPath || '')
      emitter.emit('playlistCacheCleared', { uuid: list.uuid })
    } catch (error) {
      console.error('[librarySelectArea] 清理歌单缓存失败', error)
    }
  }
}

const emptyRecycleBinHandleClick = async () => {
  const res = await confirm({
    title: t('recycleBin.emptyRecycleBin'),
    content: [t('recycleBin.confirmEmpty'), t('tracks.deleteHint')]
  })
  if (res !== 'confirm') return
  const recycleBin = findLibraryNode('RecycleBin')
  const recycleChildren = recycleBin?.children || []
  if (recycleChildren.length === 0) return

  await window.electron.ipcRenderer.invoke('emptyRecycleBin')

  const recycleUUIDs = new Set(recycleChildren.map((c: any) => c.uuid))

  if (recycleUUIDs.has(runtime.songsArea.songListUUID)) {
    runtime.songsArea.songListUUID = ''
    runtime.songsArea.selectedSongFilePath.length = 0
    runtime.songsArea.songInfoArr = []
    runtime.songsArea.totalSongCount = 0
  }

  if (recycleUUIDs.has(runtime.playingData.playingSongListUUID)) {
    runtime.playingData.playingSong = null
    runtime.playingData.playingSongListUUID = ''
    runtime.playingData.playingSongListData = []
  }

  if (recycleBin) {
    recycleBin.children = []
  }
}

const buildMenuArr = (item: Icon) => {
  const commonMenus = [
    [{ menuName: 'selection.likeAllInLibrary' }, { menuName: 'selection.dislikeAllInLibrary' }],
    [{ menuName: 'metadata.autoFillMenu' }],
    [{ menuName: 'playlist.clearCache' }]
  ]
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
    case 'selection.likeAllInLibrary':
      await handleBulkLabelForLibrary(item.name, 'liked')
      break
    case 'selection.dislikeAllInLibrary':
      await handleBulkLabelForLibrary(item.name, 'disliked')
      break
    case 'metadata.autoFillMenu':
      await handleAutoFillForLibrary(item.name)
      break
    case 'playlist.clearCache':
      await clearCachesForLibrary(item.name)
      break
    case 'recycleBin.emptyRecycleBin':
      await emptyRecycleBinHandleClick()
      break
  }
}
type ButtomIcon = {
  name: '设置'
  grey: string
  white: string
  src: string
  showAlt: boolean
  i18nKey?: string
}
const buttomIconArr = ref<ButtomIcon[]>([
  {
    name: '设置',
    grey: settingGrey,
    white: settingWhite,
    src: settingGrey,
    showAlt: false,
    i18nKey: 'common.setting'
  }
])

const libraryHandleClick = (item: Icon) => {
  emit('librarySelectedChange', item)
}

// 拖拽时的库切换逻辑
const iconDragEnter = (event: DragEvent, item: Icon) => {
  // 检查是否是歌曲拖拽
  const isSongDrag = event.dataTransfer?.types?.includes('application/x-song-drag')

  if (isSongDrag && item.name !== selectedIcon.value.name) {
    // 当拖拽歌曲时，自动切换到对应的库
    clickIcon(item)
    // 同时触发库切换事件，通知父组件更新
    libraryHandleClick(item)
  }
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
          style="width: 2px; height: 100%"
          :style="{ backgroundColor: item.name == selectedIcon.name ? 'var(--accent)' : '' }"
        ></div>
        <div
          style="
            flex-grow: 1;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
          "
          @click="libraryHandleClick(item)"
        >
          <img
            :src="item.src"
            draggable="false"
            :ref="(el) => setIconRef(item.name, el)"
            :class="{ 'theme-icon': item.src === item.white }"
          />
          <bubbleBox
            :dom="iconRefMap[item.name] || undefined"
            :title="t((item as any).i18nKey || item.name)"
          />
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
        <div style="width: 2px; height: 100%"></div>
        <div
          style="
            flex-grow: 1;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
          "
        >
          <img
            :src="item.src"
            draggable="false"
            :ref="(el) => setIconRef(item.name, el)"
            :class="{ 'theme-icon': item.src === item.white }"
          />
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

    img {
      width: 25px;
      height: 25px;
    }
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
}
</style>
