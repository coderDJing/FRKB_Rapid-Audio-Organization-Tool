<script setup lang="ts">
import {
  onMounted,
  onUnmounted,
  ref,
  watch,
  computed,
  ComputedRef,
  useTemplateRef,
  nextTick
} from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import dialogLibraryItem from '@renderer/components/dialogLibraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import hotkeys from 'hotkeys-js'
import listIconAsset from '@renderer/assets/listIcon.svg?asset'
import utils from '../utils/utils'
import { t, toLibraryDisplayName } from '@renderer/utils/translate'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import emitter from '../utils/mitt'
import type { IDir } from 'src/types/globals'
import { handleLibraryAreaEmptySpaceDrop } from '../utils/dragUtils'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

const uuid = uuidV4()
const props = defineProps({
  libraryName: {
    type: String,
    default: 'FilterLibrary'
  }
})
const isMixtapeDialog = computed(() => props.libraryName === 'MixtapeLibrary')
const isDialogListType = (node?: IDir | null) =>
  isMixtapeDialog.value ? node?.type === 'mixtapeList' : node?.type === 'songList'

const runtime = useRuntimeStore()
runtime.activeMenuUUID = ''
runtime.selectSongListDialogShow = true
// 选择区域，提前声明，便于初始化时设为 recent
const selectedArea = ref<'recent' | 'tree' | ''>('')
let recentDialogSelectedSongListUUID: string[] = []
let localStorageRecentDialogSelectedSongListUUID = localStorage.getItem(
  'recentDialogSelectedSongListUUID' + props.libraryName
)
if (localStorageRecentDialogSelectedSongListUUID) {
  recentDialogSelectedSongListUUID = JSON.parse(localStorageRecentDialogSelectedSongListUUID)
  // 按设置的最大缓存数量裁剪本地缓存
  const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
  if (recentDialogSelectedSongListUUID.length > maxCount) {
    recentDialogSelectedSongListUUID = recentDialogSelectedSongListUUID.slice(0, maxCount)
    localStorage.setItem(
      'recentDialogSelectedSongListUUID' + props.libraryName,
      JSON.stringify(recentDialogSelectedSongListUUID)
    )
  }
}
let index = 0
if (recentDialogSelectedSongListUUID.length !== 0) {
  runtime.dialogSelectedSongListUUID = recentDialogSelectedSongListUUID[index]
  selectedArea.value = 'recent'
}

const recentSongListArr = ref<IDir[]>([])
// 最近使用歌单的曲目数量缓存
const recentCounts = ref<Record<string, number>>({})
let delRecentDialogSelectedSongListUUID: string[] = []
watch(
  () => runtime.libraryTree,
  () => {
    recentSongListArr.value = []
    delRecentDialogSelectedSongListUUID = []
    for (let uuid of recentDialogSelectedSongListUUID) {
      let obj = libraryUtils.getLibraryTreeByUUID(uuid)
      if (obj === null) {
        delRecentDialogSelectedSongListUUID.push(uuid)
      }
      if (obj) {
        recentSongListArr.value.push(obj)
        // 异步刷新数量
        if ((runtime as any).setting.showPlaylistTrackCount && obj.type === 'songList') {
          const path = libraryUtils.findDirPathByUuid(obj.uuid)
          window.electron.ipcRenderer
            .invoke('getSongListTrackCount', path)
            .then((n: number) => (recentCounts.value[obj.uuid] = n || 0))
            .catch(() => (recentCounts.value[obj.uuid] = 0))
        }
      }
    }
    if (delRecentDialogSelectedSongListUUID.length !== 0) {
      recentDialogSelectedSongListUUID = recentDialogSelectedSongListUUID.filter(
        (item) => delRecentDialogSelectedSongListUUID.indexOf(item) === -1
      )
      localStorage.setItem(
        'recentDialogSelectedSongListUUID' + props.libraryName,
        JSON.stringify(recentDialogSelectedSongListUUID)
      )
    }
  },
  { deep: true, immediate: true }
)

const libraryData: ComputedRef<IDir> = computed(() => {
  let filtrateLibraryUUID: string | undefined
  if (runtime.libraryTree && runtime.libraryTree.children) {
    filtrateLibraryUUID = runtime.libraryTree.children.find(
      (element) => element.type === 'library' && element.dirName === props.libraryName
    )?.uuid
  }
  if (filtrateLibraryUUID === undefined) {
    throw new Error(`filtrateLibraryUUID error for libraryName ${props.libraryName}`)
  }
  let data = libraryUtils.getLibraryTreeByUUID(filtrateLibraryUUID)
  if (data === null) {
    throw new Error(`libraryData error: could not find library with UUID ${filtrateLibraryUUID}`)
  }
  return data
})

// 扁平化当前库下的全部歌单（不关心折叠状态）
const allSongListArr = computed<IDir[]>(() => {
  const result: IDir[] = []
  const traverse = (node?: IDir) => {
    if (!node) return
    if (isDialogListType(node)) {
      result.push(node)
    }
    if (node.children && node.children.length) {
      for (const child of node.children) traverse(child)
    }
  }
  traverse(libraryData.value)
  return result
})

// 组合“最近使用歌单”+“全部歌单”（保留重复项，便于在两个区域都可停留）
type NavItem = { uuid: string; area: 'recent' | 'tree' }
const combinedNavList = computed<NavItem[]>(() => {
  const list: NavItem[] = []
  for (const item of recentSongListArr.value) list.push({ uuid: item.uuid, area: 'recent' })
  for (const item of allSongListArr.value) list.push({ uuid: item.uuid, area: 'tree' })
  return list
})

// 当前选择所在区域，用于避免重复高亮（已提前声明）

// 当前在组合列表中的索引
const navIndex = ref<number>(-1)
const syncNavIndexByUUID = () => {
  const list = combinedNavList.value || []
  if (!runtime.dialogSelectedSongListUUID) {
    navIndex.value = -1
    return
  }
  // 优先匹配当前区域的索引
  let idx = list.findIndex(
    (x) => x.uuid === runtime.dialogSelectedSongListUUID && x.area === selectedArea.value
  )
  if (idx < 0) {
    // 若当前区域不存在该项，则退回到第一个匹配项
    idx = list.findIndex((x) => x.uuid === runtime.dialogSelectedSongListUUID)
  }
  navIndex.value = idx
}

// 统一的上下移动处理，供热键与输入框箭头键共用
const moveSelection = (direction: 1 | -1) => {
  const list = combinedNavList.value || []
  if (list.length === 0) return
  if (navIndex.value < 0) navIndex.value = 0
  else navIndex.value = (navIndex.value + direction + list.length) % list.length
  const target = list[navIndex.value]
  selectedArea.value = target.area
  runtime.dialogSelectedSongListUUID = target.uuid
}
const handleMoveDown = (e?: KeyboardEvent) => {
  try {
    e?.preventDefault?.()
  } catch {}
  moveSelection(1)
}
const handleMoveUp = (e?: KeyboardEvent) => {
  try {
    e?.preventDefault?.()
  } catch {}
  moveSelection(-1)
}

watch(
  () => [combinedNavList.value.length, runtime.dialogSelectedSongListUUID],
  () => {
    syncNavIndexByUUID()
  },
  { immediate: true }
)

// 当没有“最近使用”时，初始高亮定位到“全部歌单”的第一个
watch(
  () => allSongListArr.value.length,
  (len) => {
    if (len > 0 && runtime.dialogSelectedSongListUUID === '') {
      runtime.dialogSelectedSongListUUID = allSongListArr.value[0].uuid
      selectedArea.value = 'tree'
      syncNavIndexByUUID()
    }
  },
  { immediate: true }
)

// libraryData 已提前定义

const collapseButtonRef = useTemplateRef<HTMLDivElement>('collapseButtonRef')
const searchInputRef = useTemplateRef<HTMLInputElement>('searchInputRef')

const libraryTitleText = computed(() => toLibraryDisplayName(libraryData.value.dirName))
const listIcon = listIconAsset

const menuArr = ref([
  isMixtapeDialog.value
    ? [{ menuName: 'library.createMixtape' }, { menuName: 'library.createFolder' }]
    : [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]
])
const contextmenuEvent = async (event: MouseEvent) => {
  if (!libraryData.value) return
  menuArr.value = [
    isMixtapeDialog.value
      ? [{ menuName: 'library.createMixtape' }, { menuName: 'library.createFolder' }]
      : [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]
  ]
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  if (result !== 'cancel') {
    if (result.menuName == 'library.createPlaylist') {
      const newUuid = uuidV4()
      libraryData.value.children = libraryData.value.children || []
      libraryData.value.children.unshift({
        uuid: newUuid,
        type: 'songList',
        dirName: ''
      })
      // 新建后在对话框中仅定位高亮，不触发双击
      runtime.dialogSelectedSongListUUID = newUuid
      selectedArea.value = 'tree'
    } else if (result.menuName == 'library.createMixtape') {
      const newUuid = uuidV4()
      libraryData.value.children = libraryData.value.children || []
      libraryData.value.children.unshift({
        uuid: newUuid,
        type: 'mixtapeList',
        dirName: ''
      })
      runtime.dialogSelectedSongListUUID = newUuid
      selectedArea.value = 'tree'
    } else if (result.menuName == 'library.createFolder') {
      libraryData.value.children = libraryData.value.children || []
      libraryData.value.children.unshift({
        uuid: uuidV4(),
        type: 'dir',
        dirName: ''
      })
    }
  }
}

const collapseButtonHandleClick = async () => {
  if (!libraryData.value) return
  emitter.emit('collapseButtonHandleClick', libraryData.value.dirName + 'Dialog')
}

// 歌单筛选关键词（仅匹配歌单名）
const playlistSearch = ref('')
// 是否显示“立即创建”按钮：当存在关键字，且当前库内没有一个歌单名称与之完全匹配时显示
const exactMatchExists = computed(() => {
  const keyword = String(playlistSearch.value || '')
    .trim()
    .toLowerCase()
  if (!keyword) return true
  return allSongListArr.value.some((x) => (x.dirName || '').toLowerCase() === keyword)
})
const showCreateNow = computed(() => {
  const keyword = String(playlistSearch.value || '').trim()
  return !!keyword && !exactMatchExists.value
})
const searchKeyword = computed(() =>
  String(playlistSearch.value || '')
    .trim()
    .toLowerCase()
)
const filteredRecentSongListArr = computed(() => {
  const base = recentSongListArr.value.filter((item) => isDialogListType(item))
  if (!searchKeyword.value) return base
  return base.filter((item) =>
    String(item.dirName || '')
      .toLowerCase()
      .includes(searchKeyword.value)
  )
})
const filteredAllSongListArr = computed(() => {
  if (!searchKeyword.value) return allSongListArr.value
  return allSongListArr.value.filter((item) =>
    String(item.dirName || '')
      .toLowerCase()
      .includes(searchKeyword.value)
  )
})
const filteredSongListUuids = computed(() => {
  if (!searchKeyword.value) return allSongListArr.value.map((item) => item.uuid)
  return filteredAllSongListArr.value.map((item) => item.uuid)
})

// 立即以关键字作为名称在根层级创建歌单，并置顶；在对话框中仅高亮不触发确认
const createNow = async () => {
  if (!libraryData.value) return
  const name = String(playlistSearch.value || '').trim()
  if (!name) return
  const newUuid = uuidV4()
  // 先提升已有 order，再插入新项到首位
  for (let item of libraryData.value.children || []) {
    if (item.order) item.order++
  }
  libraryData.value.children = libraryData.value.children || []
  libraryData.value.children.unshift({
    uuid: newUuid,
    type: isMixtapeDialog.value ? 'mixtapeList' : 'songList',
    dirName: name,
    order: 1,
    children: []
  } as IDir)
  try {
    await libraryUtils.diffLibraryTreeExecuteFileOperation()
  } catch {}
  // 在选择对话框内：高亮但不触发双击确认
  runtime.dialogSelectedSongListUUID = newUuid
  selectedArea.value = 'tree'
  // 创建完成后清空搜索
  playlistSearch.value = ''
}

const dragover = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  e.dataTransfer.dropEffect = 'move'
}
const dragenter = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  e.dataTransfer.dropEffect = 'move'
}
const dragleave = () => {
  if (runtime.dragItemData === null) {
    return
  }
}
const drop = async () => {
  if (runtime.dragItemData === null || !libraryData.value) {
    return
  }
  try {
    const handled = await handleLibraryAreaEmptySpaceDrop(runtime.dragItemData, libraryData.value)
  } catch (error) {
    console.error('Drop operation failed:', error)
  } finally {
    runtime.dragItemData = null
  }
}
onMounted(() => {
  hotkeys('s', uuid, () => {
    handleMoveDown()
  })
  hotkeys('w', uuid, () => {
    handleMoveUp()
  })
  // 兼容上下方向键
  hotkeys('down', uuid, (e) => {
    handleMoveDown(e as any)
  })
  hotkeys('up', uuid, (e) => {
    handleMoveUp(e as any)
  })
  // 在对话框内统一使用 F2 触发重命名，避免与 Enter 确认冲突
  hotkeys('f2', uuid, (e) => {
    try {
      e.preventDefault()
      const target = runtime.dialogSelectedSongListUUID
      if (target) emitter.emit('dialog/trigger-rename', target)
      return false
    } catch {}
  })
  hotkeys('E,Enter', uuid, () => {
    confirmHandle()
  })
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  runtime.dialogSelectedSongListUUID = ''
  runtime.selectSongListDialogShow = false
})

const flashArea = ref('')
const flashBorder = (flashAreaName: string) => {
  flashArea.value = flashAreaName
  let count = 0
  const interval = setInterval(() => {
    count++
    if (count >= 3) {
      clearInterval(interval)
      flashArea.value = ''
    }
  }, 500)
}
const { dialogVisible, closeWithAnimation } = useDialogTransition()

const confirmHandle = () => {
  const selectedUuid = runtime.dialogSelectedSongListUUID
  const selectionVisible =
    !searchKeyword.value || filteredSongListUuids.value.includes(selectedUuid)
  if (
    !selectedUuid ||
    !selectionVisible ||
    libraryUtils.getLibraryTreeByUUID(selectedUuid) === null
  ) {
    if (!flashArea.value) {
      flashBorder('selectSongList')
    }
  } else {
    if (recentDialogSelectedSongListUUID.indexOf(selectedUuid) === -1) {
      recentDialogSelectedSongListUUID.unshift(selectedUuid)
      const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
      while (recentDialogSelectedSongListUUID.length > maxCount) {
        recentDialogSelectedSongListUUID.pop()
      }
    } else {
      recentDialogSelectedSongListUUID.unshift(
        recentDialogSelectedSongListUUID.splice(
          recentDialogSelectedSongListUUID.indexOf(selectedUuid),
          1
        )[0]
      )
      const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
      while (recentDialogSelectedSongListUUID.length > maxCount) {
        recentDialogSelectedSongListUUID.pop()
      }
    }
    localStorage.setItem(
      'recentDialogSelectedSongListUUID' + props.libraryName,
      JSON.stringify(recentDialogSelectedSongListUUID)
    )
    closeWithAnimation(() => emits('confirm', selectedUuid))
  }
}
const emits = defineEmits(['cancel', 'confirm'])
const cancel = () => {
  closeWithAnimation(() => emits('cancel'))
}
const handleSearchEnter = () => {
  if (!searchKeyword.value) return
  const firstRecent = filteredRecentSongListArr.value[0]
  const firstAll = filteredAllSongListArr.value[0]
  if (!firstRecent && !firstAll) {
    createNow()
    searchInputRef.value?.blur()
    return
  }
  if (firstRecent) {
    runtime.dialogSelectedSongListUUID = firstRecent.uuid
    selectedArea.value = 'recent'
  } else if (firstAll) {
    runtime.dialogSelectedSongListUUID = firstAll.uuid
    selectedArea.value = 'tree'
  }
  syncNavIndexByUUID()
  searchInputRef.value?.blur()
}

// 依据选择的 UUID 判定当前高亮区域（用户通过鼠标点击树或最近区时生效）
watch(
  () => runtime.dialogSelectedSongListUUID,
  (val) => {
    if (!val) {
      selectedArea.value = ''
      navIndex.value = -1
      return
    }
    const inRecent = recentSongListArr.value.some((x) => x.uuid === val)
    const inTree = allSongListArr.value.some((x) => x.uuid === val)
    if (inRecent && inTree) {
      // 两边都有时，保留当前区域；若无区域则默认 recent
      if (!selectedArea.value) selectedArea.value = 'recent'
    } else if (inRecent) {
      selectedArea.value = 'recent'
    } else if (inTree) {
      selectedArea.value = 'tree'
    } else {
      selectedArea.value = ''
    }
    syncNavIndexByUUID()
  }
)

// --- 保持选中项可见：对“最近使用”区域进行滚动 ---
// 记录最近区每一行元素的引用
const recentRowRefs = new Map<string, HTMLElement>()
const setRecentRowRef = (uuid: string, el: HTMLElement | null) => {
  if (el) recentRowRefs.set(uuid, el)
  else recentRowRefs.delete(uuid)
}

// 当选中项或区域变化时，如果处于“recent”区域，滚动到可见
watch(
  [
    () => runtime.dialogSelectedSongListUUID,
    () => selectedArea.value,
    () => recentSongListArr.value.length
  ],
  async () => {
    if (selectedArea.value === 'recent' && runtime.dialogSelectedSongListUUID) {
      await nextTick()
      try {
        recentRowRefs
          .get(runtime.dialogSelectedSongListUUID)
          ?.scrollIntoView?.({ block: 'nearest' })
      } catch {}
    }
  },
  { immediate: true }
)
</script>
<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="content inner" @contextmenu.stop="contextmenuEvent">
      <div v-if="libraryData" class="unselectable libraryTitle dialog-title dialog-header">
        <div class="collapseButtonPlaceholder"></div>
        <span>{{ libraryTitleText }}</span>
        <div class="collapseButtonWrapper">
          <div style="display: flex; justify-content: center; align-items: center">
            <div
              ref="collapseButtonRef"
              class="collapseButton"
              data-dialog-drag-ignore="true"
              @click="collapseButtonHandleClick()"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                xmlns="http://www.w3.org/2000/svg"
                fill="currentColor"
              >
                <path d="M9 9H4v1h5V9z" />
                <path
                  fill-rule="evenodd"
                  clip-rule="evenodd"
                  d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"
                />
              </svg>
            </div>
            <bubbleBox
              :dom="collapseButtonRef || undefined"
              :title="t('playlist.collapsibleFolder')"
            />
          </div>
        </div>
      </div>
      <div class="dialog-body">
        <!-- 顶部筛选输入框 -->
        <div class="librarySearchWrapper">
          <div class="searchRow">
            <div class="searchInputWrapper">
              <input
                ref="searchInputRef"
                v-model="playlistSearch"
                class="searchInput"
                :placeholder="t('playlist.searchPlaylists')"
                @keydown.down.prevent="handleMoveDown"
                @keydown.up.prevent="handleMoveUp"
                @keydown.enter.prevent.stop="handleSearchEnter"
              />
              <div
                v-show="String(playlistSearch || '').length"
                class="clearBtn"
                @click="playlistSearch = ''"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  shape-rendering="geometricPrecision"
                >
                  <path
                    d="M3 3 L9 9 M9 3 L3 9"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    vector-effect="non-scaling-stroke"
                  />
                </svg>
              </div>
            </div>
            <div v-if="showCreateNow" class="createNowBtn" @click="createNow">
              {{ t('playlist.createNow') }}
            </div>
          </div>
        </div>
        <div
          v-if="libraryData?.children?.length"
          class="unselectable libraryArea flashing-border"
          :class="{ 'is-flashing': flashArea == 'selectSongList' }"
        >
          <OverlayScrollbarsComponent
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
            style="height: 100%; width: 100%"
            defer
          >
            <div class="sectionStack">
              <div v-if="recentSongListArr.length > 0" class="sectionCard sectionCard--recent">
                <div class="sectionHeader">
                  <div class="sectionTitle">
                    <span class="sectionAccent sectionAccent--recent"></span>
                    <span>{{ t('library.recentlyUsed') }}</span>
                  </div>
                </div>
                <div class="sectionBody">
                  <div
                    v-for="item of filteredRecentSongListArr"
                    :key="item.uuid"
                    :ref="(el: any) => setRecentRowRef(item.uuid, el)"
                    :class="{
                      selectedDir:
                        selectedArea === 'recent' && item.uuid == runtime.dialogSelectedSongListUUID
                    }"
                    class="recentLibraryItem"
                    @click="
                      ((runtime.dialogSelectedSongListUUID = item.uuid), (selectedArea = 'recent'))
                    "
                    @dblclick="confirmHandle()"
                  >
                    <div
                      style="
                        width: 20px;
                        justify-content: center;
                        align-items: center;
                        display: flex;
                      "
                    >
                      <img
                        class="songlist-icon"
                        style="width: 13px; height: 13px"
                        :src="listIcon"
                      />
                    </div>
                    <div class="nameRow">
                      <span class="nameText">{{ item.dirName }}</span>
                      <span
                        v-if="
                          (runtime as any).setting.showPlaylistTrackCount &&
                          item.type === 'songList'
                        "
                        class="countBadge"
                        >{{ recentCounts[item.uuid] ?? 0 }}</span
                      >
                    </div>
                  </div>
                </div>
              </div>
              <div class="sectionCard sectionCard--all">
                <div class="sectionHeader">
                  <div class="sectionTitle">
                    <span class="sectionAccent sectionAccent--all"></span>
                    <span>{{ t('library.allPlaylists') }}</span>
                  </div>
                </div>
                <div class="sectionBody">
                  <template v-for="item of libraryData?.children" :key="item.uuid">
                    <dialogLibraryItem
                      :uuid="item.uuid"
                      :library-name="libraryData.dirName + 'Dialog'"
                      :filter-text="playlistSearch"
                      :suppress-highlight="selectedArea === 'recent'"
                      @dbl-click-song-list="confirmHandle()"
                      @mark-tree-selected="selectedArea = 'tree'"
                    />
                  </template>
                  <div
                    class="libraryDropSpace"
                    @dragover.stop.prevent="dragover"
                    @dragenter.stop.prevent="dragenter"
                    @drop.stop="drop"
                    @dragleave.stop="dragleave"
                  ></div>
                </div>
              </div>
            </div>
          </OverlayScrollbarsComponent>
        </div>
        <div
          v-else
          class="unselectable flashing-border"
          :class="{ 'is-flashing': flashArea == 'selectSongList' }"
          style="
            max-width: 300px;
            display: flex;
            justify-content: center;
            align-items: center;
            flex-grow: 1;
            min-height: 0;
          "
        >
          <span style="font-size: 12px; color: var(--text-weak)">{{
            t('library.rightClickToCreate')
          }}</span>
        </div>
      </div>

      <div class="dialog-footer footer-centered">
        <div class="button" style="width: 90px; text-align: center" @click="confirmHandle()">
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="cancel()">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.sectionStack {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px;
  box-sizing: border-box;
}

.sectionCard {
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px;
  box-sizing: border-box;
}

.sectionHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 6px 4px;
}

.sectionTitle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.sectionAccent {
  width: 6px;
  height: 14px;
  border-radius: 3px;
  background-color: var(--accent);
}

.sectionAccent--recent {
  background-color: var(--accent);
}

.sectionAccent--all {
  background-color: var(--text-weak);
}

.sectionBody {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0;
}

.libraryDropSpace {
  flex-grow: 1;
  min-height: 30px;
}

.recentLibraryItem {
  display: flex;

  height: 23px;
  align-items: center;
  font-size: 13px;
  border-radius: 4px;
  padding: 0 6px 0 2px;

  &:hover {
    background-color: var(--hover);
  }
}

.nameRow {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 8px;
  width: 100%;
  position: relative;
}
.nameText {
  flex: 1 1 auto;
  min-width: 0;
  padding-right: 48px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.countBadge {
  min-width: 18px;
  height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
  background-color: var(--hover);
  color: var(--text-weak);
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
}

.selectedDir {
  background-color: var(--hover);

  &:hover {
    background-color: var(--hover) !important;
  }
}

.libraryArea {
  max-width: 300px;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  flex-grow: 1;
  min-height: 0; // 防止内容过多时溢出 flex 容器
}

.content {
  height: 70vh;
  max-height: 70vh;
  width: 300px;
  max-width: 300px;
  display: flex;
  flex-grow: 1;
  background-color: var(--bg);
  overflow: hidden;
  flex-direction: column;

  .libraryTitle {
    padding: 0 12px 0 12px;
    font-size: 12px;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;

    span {
      flex: 1;
      text-align: center;
    }

    .collapseButtonPlaceholder,
    .collapseButtonWrapper {
      width: 32px;
      display: flex;
      justify-content: center;
      align-items: center;
      flex-shrink: 0;
    }

    .collapseButton {
      color: var(--text);
      width: 20px;
      height: 20px;
      display: flex;
      justify-content: center;
      align-items: center;

      border-radius: 5px;

      &:hover {
        background-color: var(--hover);
      }
    }
  }
}
.dialog-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background-color: var(--bg);
}
.footer-centered {
  justify-content: center;
}

.librarySearchWrapper {
  padding: 6px 5px 6px 5px;
  background-color: var(--bg);
}

.searchInput {
  width: 100%;
  height: 22px;
  line-height: 22px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  border-radius: 2px;
  padding: 0 8px;
  box-sizing: border-box;
  font-size: 12px;
  font-weight: normal;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

// 当鼠标悬停在输入框容器（包括清空按钮）时，也应用输入框的 hover 效果
.searchInputWrapper:hover .searchInput {
  background-color: var(--hover);
  border-color: var(--accent);
}

.searchRow {
  display: flex;
  gap: 6px;
  align-items: center;
}

.searchRow .searchInput {
  flex: 1 1 auto;
  width: 100%;
}

.searchInputWrapper {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}

.searchInputWrapper .searchInput {
  width: 100%;
  padding-right: 24px; // 为清空按钮预留空间
}

.clearBtn {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  cursor: pointer;
  z-index: 1;
}

.createNowBtn {
  height: 22px;
  line-height: 22px;
  padding: 0 8px;
  font-size: 12px;
  border-radius: 2px;
  border: 1px solid var(--border);
  box-sizing: border-box;
  background-color: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
  user-select: none;
  white-space: nowrap; // 禁止换行
  flex-shrink: 0; // 不因空间不足被压缩

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
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
  font-weight: normal;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter,
.fade-leave-to {
  opacity: 0;
}
</style>
