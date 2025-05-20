<script setup lang="ts">
import { watch, ref, nextTick, computed, onMounted, useTemplateRef } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import hotkeys from 'hotkeys-js'
import { t } from '@renderer/utils/translate'
import { ISongInfo, ISongsAreaColumn } from '../../../../../types/globals'

// 组件导入
import confirm from '@renderer/components/confirmDialog'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import welcomePage from '@renderer/components/welcomePage.vue'
import SongListHeader from './SongListHeader.vue'
import SongListRows from './SongListRows.vue'
import ColumnHeaderContextMenu from './ColumnHeaderContextMenu.vue'
import { getCurrentTimeDirName } from '@renderer/utils/utils'

// Composable import
import { useSongItemContextMenu } from '@renderer/pages/modules/songsArea/composables/useSongItemContextMenu'
import { useCoverLoader } from '@renderer/pages/modules/songsArea/composables/useCoverLoader'
import { useSelectAndMoveSongs } from '@renderer/pages/modules/songsArea/composables/useSelectAndMoveSongs'

// 资源导入
import ascendingOrder from '@renderer/assets/ascending-order.png?asset'
import descendingOrder from '@renderer/assets/descending-order.png?asset'

import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

// 类型定义，以便正确引用 OverlayScrollbarsComponent 实例
type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

const runtime = useRuntimeStore()
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')
const originalSongInfoArr = ref<ISongInfo[]>([])

// Initialize composables
const { showAndHandleSongContextMenu } = useSongItemContextMenu(songsAreaRef)
const { coversLoadCompleted, startNewCoverLoadSession, loadCoversInBatches } = useCoverLoader()
const {
  isDialogVisible: isSelectSongListDialogVisible,
  targetLibraryName: selectSongListDialogTargetLibraryName,
  initiateMoveSongs,
  handleMoveSongsConfirm,
  handleDialogCancel
} = useSelectAndMoveSongs()

const defaultColumns: ISongsAreaColumn[] = [
  {
    columnName: '序号',
    key: 'index',
    show: true,
    width: 60
  },
  {
    columnName: '专辑封面',
    key: 'coverUrl',
    show: true,
    width: 100
  },
  {
    columnName: '曲目标题',
    key: 'title',
    show: true,
    width: 250
  },
  {
    columnName: '表演者',
    key: 'artist',
    show: true,
    width: 200,
    order: 'asc'
  },
  {
    columnName: '时长',
    key: 'duration',
    show: true,
    width: 100
  },
  {
    columnName: '专辑',
    key: 'album',
    show: true,
    width: 200
  },
  {
    columnName: '风格',
    key: 'genre',
    show: true,
    width: 200
  },
  {
    columnName: '唱片公司',
    key: 'label',
    show: true,
    width: 200
  },
  {
    columnName: '比特率',
    key: 'bitrate',
    show: true,
    width: 200
  },
  {
    columnName: '编码格式',
    key: 'container',
    show: true,
    width: 200
  }
]

const columnData = ref<ISongsAreaColumn[]>(
  (() => {
    const savedData = localStorage.getItem('songColumnData')
    let finalColumns: ISongsAreaColumn[]

    if (!savedData) {
      // --- 情况 1: 没有本地存储，直接使用默认值 ---
      finalColumns = JSON.parse(JSON.stringify(defaultColumns))
    } else {
      // --- 情况 2: 有本地存储，进行合并 ---
      try {
        const parsedData: ISongsAreaColumn[] = JSON.parse(savedData)
        const savedColumnsMap = new Map(parsedData.map((col) => [col.key, col]))

        // 1. 以 defaultColumns 为基础进行合并
        finalColumns = defaultColumns.map((defaultCol) => {
          const savedCol = savedColumnsMap.get(defaultCol.key)
          if (savedCol) {
            // 注意：要检查 savedCol 中属性是否存在，避免 undefined 覆盖默认值
            return {
              ...defaultCol,
              show: savedCol.show !== undefined ? savedCol.show : defaultCol.show,
              width: savedCol.width !== undefined ? savedCol.width : defaultCol.width,
              order: savedCol.order
            }
          } else {
            return JSON.parse(JSON.stringify(defaultCol))
          }
        })

        // 2. 处理本地存储中有，但 defaultColumns 中已移除的列
        // 如果需要清理掉旧版本遗留的、新版本已废弃的列，可以在这里过滤
        finalColumns = finalColumns.filter((col) => defaultColumns.some((dc) => dc.key === col.key))
      } catch (error) {
        console.error('解析本地存储的 songColumnData 出错，将使用默认列配置:', error)
        finalColumns = JSON.parse(JSON.stringify(defaultColumns))
      }
    }

    // --- 确保至少有一个默认排序列（如果用户没有设置任何排序列） ---
    const hasOrderAfterMerge = finalColumns.some((col) => col.order !== undefined)
    if (!hasOrderAfterMerge) {
      const durationColIndex = finalColumns.findIndex((col) => col.key === 'duration')
      if (durationColIndex !== -1) {
        finalColumns[durationColIndex] = { ...finalColumns[durationColIndex], order: 'asc' }
        // 如果 'duration' 列不存在，可以考虑给其他列如 'title' 设置默认排序 (这里保留，以防万一)
      } else {
        const titleColIndex = finalColumns.findIndex((col) => col.key === 'title')
        if (titleColIndex !== -1) {
          finalColumns[titleColIndex] = { ...finalColumns[titleColIndex], order: 'asc' }
        }
      }
    }

    // --- 返回最终的列配置 ---
    return finalColumns
  })()
)

let loadingShow = ref(false)
const isRequesting = ref<boolean>(false)

const openSongList = async () => {
  runtime.songsArea.songInfoArr.forEach((item) => {
    if (item.coverUrl) {
      URL.revokeObjectURL(item.coverUrl)
    }
  })
  const newTaskId = startNewCoverLoadSession()

  isRequesting.value = true
  runtime.songsArea.songInfoArr = []
  originalSongInfoArr.value = []
  await nextTick()

  const songListPath = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID)

  loadingShow.value = false
  const loadingSetTimeout = setTimeout(() => {
    loadingShow.value = true
  }, 100)

  try {
    const { scanData, songListUUID } = await window.electron.ipcRenderer.invoke(
      'scanSongList',
      songListPath,
      runtime.songsArea.songListUUID
    )

    if (songListUUID !== runtime.songsArea.songListUUID) {
      return
    }

    originalSongInfoArr.value = scanData

    const sortedCol = columnData.value.find((col) => col.order)
    if (sortedCol) {
      // 注意：这里对 originalSongInfoArr.value 的副本进行排序
      runtime.songsArea.songInfoArr = sortArrayByProperty<ISongInfo>(
        [...originalSongInfoArr.value],
        sortedCol.key as keyof ISongInfo,
        sortedCol.order
      )
    } else {
      runtime.songsArea.songInfoArr = [...originalSongInfoArr.value]
    }

    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    }

    // --- 启动新的封面加载任务，并设置完成回调 ---
    loadCoversInBatches(runtime.songsArea.songInfoArr, newTaskId)
  } finally {
    isRequesting.value = false
    clearTimeout(loadingSetTimeout)
    loadingShow.value = false
  }
}
watch(
  () => runtime.songsArea.songListUUID,
  async (newUUID) => {
    runtime.songsArea.selectedSongFilePath.length = 0

    if (newUUID) {
      await openSongList()
    } else {
      runtime.songsArea.songInfoArr.forEach((item) => {
        if (item.coverUrl) {
          URL.revokeObjectURL(item.coverUrl)
        }
      })
      runtime.songsArea.songInfoArr = []
      originalSongInfoArr.value = []
    }
  }
)

window.electron.ipcRenderer.on('importFinished', async (event, contentArr, songListUUID) => {
  if (songListUUID == runtime.songsArea.songListUUID) {
    setTimeout(async () => {
      await openSongList()
    }, 1000)
  }
})

// --- 父组件中用于持久化列数据的方法 ---
const persistColumnData = () => {
  localStorage.setItem('songColumnData', JSON.stringify(columnData.value))
}

// --- 处理来自 SongListHeader 的列更新 ---
const handleColumnsUpdate = (newColumns: ISongsAreaColumn[]) => {
  columnData.value = newColumns
  persistColumnData()
}

const colRightClickMenuShow = ref(false)
const triggeringColContextEvent = ref<MouseEvent | null>(null)

const contextmenuEvent = (event: MouseEvent) => {
  triggeringColContextEvent.value = event
  colRightClickMenuShow.value = true
}

const handleToggleColumnVisibility = (columnKey: string) => {
  const columnIndex = columnData.value.findIndex((col) => col.key === columnKey)
  if (columnIndex !== -1) {
    // Create a new array with the toggled show state for reactivity
    const newColumns = columnData.value.map((col, index) => {
      if (index === columnIndex) {
        return { ...col, show: !col.show }
      }
      return col
    })
    columnData.value = newColumns
    persistColumnData()
  }
}

let columnDataArr = computed(() => {
  return columnData.value.filter((item) => item.show)
})
const songClick = (event: MouseEvent, song: ISongInfo) => {
  runtime.activeMenuUUID = ''
  if (event.ctrlKey) {
    let index = runtime.songsArea.selectedSongFilePath.indexOf(song.filePath)
    if (index !== -1) {
      runtime.songsArea.selectedSongFilePath.splice(index, 1)
    } else {
      runtime.songsArea.selectedSongFilePath.push(song.filePath)
    }
  } else if (event.shiftKey) {
    let lastClickSongFilePath = null
    if (runtime.songsArea.selectedSongFilePath.length) {
      lastClickSongFilePath =
        runtime.songsArea.selectedSongFilePath[runtime.songsArea.selectedSongFilePath.length - 1]
    }
    let lastClickSongIndex = 0
    if (lastClickSongFilePath) {
      lastClickSongIndex = runtime.songsArea.songInfoArr.findIndex(
        (item) => item.filePath === lastClickSongFilePath
      )
    }

    let clickSongIndex = runtime.songsArea.songInfoArr.findIndex(
      (item) => item.filePath === song.filePath
    )
    let sliceArr = runtime.songsArea.songInfoArr.slice(
      Math.min(lastClickSongIndex, clickSongIndex),
      Math.max(lastClickSongIndex, clickSongIndex) + 1
    )
    for (let item of sliceArr) {
      if (runtime.songsArea.selectedSongFilePath.indexOf(item.filePath) === -1) {
        runtime.songsArea.selectedSongFilePath.push(item.filePath)
      }
    }
  } else {
    runtime.songsArea.selectedSongFilePath = [song.filePath]
  }
}

const handleSongContextMenuEvent = async (event: MouseEvent, song: ISongInfo) => {
  // showAndHandleSongContextMenu 返回 Promise<OpenDialogAction | null>
  // OpenDialogAction 定义为: { action: 'openSelectSongListDialog', libraryName: '精选库' | '筛选库' }
  // 它也可能处理删除并直接修改 runtime.songsArea.songInfoArr，但不返回特定action。
  // 为了解决 originalSongInfoArr 不同步的问题，理想情况下，
  // useSongItemContextMenu.ts 中的删除操作应该返回一个包含已删除路径的 action。
  // 例如: { action: 'CONTEXT_MENU_SONGS_DELETED', paths: string[] }

  const result = await showAndHandleSongContextMenu(event, song)

  if (result) {
    // 处理移动歌曲到其他列表的对话框请求
    if (result.action === 'openSelectSongListDialog') {
      // result 类型符合 OpenDialogAction 接口
      initiateMoveSongs(result.libraryName)
    }
    // 处理来自右键菜单的歌曲移除操作 (删除、导出后删除等)
    else if (result.action === 'songsRemoved') {
      // 此时 result 类型应符合 SongsRemovedAction 接口: { action: 'songsRemoved', paths: string[] }
      const pathsToRemove = result.paths
      if (Array.isArray(pathsToRemove) && pathsToRemove.length > 0) {
        originalSongInfoArr.value = originalSongInfoArr.value.filter(
          (item) => !pathsToRemove.includes(item.filePath)
        )

        // 2. 确保 runtime.songsArea.songInfoArr 与更新后的 originalSongInfoArr 同步
        // (useSongItemContextMenu 已经修改了 runtime.songsArea.songInfoArr，
        // 但这里的目的是基于 *最新的* originalSongInfoArr 和排序规则重新生成它，
        // 以确保排序基准和显示列表的一致性)
        const sortedCol = columnData.value.find((col) => col.order)
        if (sortedCol) {
          runtime.songsArea.songInfoArr = sortArrayByProperty<ISongInfo>(
            [...originalSongInfoArr.value],
            sortedCol.key as keyof ISongInfo,
            sortedCol.order
          )
        } else {
          runtime.songsArea.songInfoArr = [...originalSongInfoArr.value]
        }

        if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
          runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
        }

        if (
          runtime.playingData.playingSong &&
          pathsToRemove.includes(runtime.playingData.playingSong.filePath)
        ) {
          runtime.playingData.playingSong = null
        }

        // 5. 从当前选择中移除已删除的歌曲 (useSongItemContextMenu 可能已经处理了部分)
        // 为确保一致性，再次进行过滤
        runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
          (path) => !pathsToRemove.includes(path)
        )
      }
    }
    // 其他可能的 action 处理...
  }
  // 如果 result 是 null，或者 action 不匹配任何已知处理，则不执行任何操作
}

const songDblClick = (song: ISongInfo) => {
  runtime.activeMenuUUID = ''
  runtime.songsArea.selectedSongFilePath = []
  runtime.playingData.playingSong = song
  runtime.playingData.playingSongListUUID = runtime.songsArea.songListUUID
  runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
  window.electron.ipcRenderer.send('readSongFile', song.filePath, 0)
}
const handleDeleteKey = async () => {
  const selectedPaths = JSON.parse(JSON.stringify(runtime.songsArea.selectedSongFilePath))
  if (!selectedPaths.length) return false

  const isInRecycleBin = runtime.libraryTree.children
    ?.find((item) => item.dirName === '回收站')
    ?.children?.find((item) => item.uuid === runtime.songsArea.songListUUID)

  let shouldDelete = true
  if (isInRecycleBin) {
    let res = await confirm({
      title: '删除',
      content: [t('确定彻底删除选中的曲目吗'), t('（曲目将在磁盘上被删除，但声音指纹依然会保留）')]
    })
    shouldDelete = res === 'confirm'
  }

  if (shouldDelete) {
    if (isInRecycleBin) {
      window.electron.ipcRenderer.invoke('permanentlyDelSongs', selectedPaths)
    } else {
      window.electron.ipcRenderer.send('delSongs', selectedPaths, getCurrentTimeDirName())
    }

    const songsToDeleteFromOriginal = originalSongInfoArr.value.filter((item) =>
      selectedPaths.includes(item.filePath)
    )
    for (let item of songsToDeleteFromOriginal) {
      if (item.coverUrl) {
        URL.revokeObjectURL(item.coverUrl)
      }
    }

    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (item) => !selectedPaths.includes(item.filePath)
    )

    // 2. 根据当前的排序规则，重新排序 originalSongInfoArr 并更新 runtime.songsArea.songInfoArr
    const sortedCol = columnData.value.find((col) => col.order)
    if (sortedCol) {
      runtime.songsArea.songInfoArr = sortArrayByProperty<ISongInfo>(
        [...originalSongInfoArr.value],
        sortedCol.key as keyof ISongInfo,
        sortedCol.order
      )
    } else {
      runtime.songsArea.songInfoArr = [...originalSongInfoArr.value]
    }

    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    }
    if (
      runtime.playingData.playingSong &&
      selectedPaths.includes(runtime.playingData.playingSong.filePath)
    ) {
      runtime.playingData.playingSong = null
    }
    runtime.songsArea.selectedSongFilePath.length = 0
  }
  return false // Prevent default browser behavior for Delete key
}

onMounted(() => {
  hotkeys('ctrl+a, command+a', 'windowGlobal', () => {
    runtime.songsArea.selectedSongFilePath.length = 0
    for (let item of runtime.songsArea.songInfoArr) {
      runtime.songsArea.selectedSongFilePath.push(item.filePath)
    }
    return false
  })
  hotkeys('delete', 'windowGlobal', () => {
    handleDeleteKey()
    return false
  })
})

function sortArrayByProperty<T>(array: T[], property: keyof T, order: 'asc' | 'desc' = 'asc'): T[] {
  const collator = new Intl.Collator('zh-CN', {
    numeric: true, // 启用数字排序
    sensitivity: 'base' // 不区分大小写
  })

  return [...array].sort((a, b) => {
    const valueA = String(a[property] || '')
    const valueB = String(b[property] || '')

    return order === 'asc' ? collator.compare(valueA, valueB) : collator.compare(valueB, valueA)
  })
}
const colMenuClick = (col: ISongsAreaColumn) => {
  if (col.key === 'coverUrl' || col.key === 'index') {
    return
  }

  const newColumnData = columnData.value.map((item) => {
    if (item.key !== col.key) {
      return { ...item, order: undefined }
    }
    const newOrderForItem = item.order === 'asc' ? 'desc' : item.order === 'desc' ? 'asc' : 'asc' // Default to asc if undefined
    return { ...item, order: newOrderForItem as 'asc' | 'desc' }
  })
  columnData.value = newColumnData
  persistColumnData()

  // Get the new order of the clicked column for sorting
  const clickedColNewOrder = newColumnData.find((c) => c.key === col.key)?.order

  if (clickedColNewOrder) {
    // Ensure it's 'asc' or 'desc'
    runtime.songsArea.songInfoArr = sortArrayByProperty<ISongInfo>(
      [...originalSongInfoArr.value],
      col.key as keyof ISongInfo, // Use the key from the original clicked column object
      clickedColNewOrder // Use its new order from the updated array
    )

    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    }

    if (!coversLoadCompleted.value) {
      const newTaskId = startNewCoverLoadSession()
      loadCoversInBatches(runtime.songsArea.songInfoArr, newTaskId)
    }
  } else {
    // This case (clickedColNewOrder is undefined) should not happen for sortable columns
    // because the map logic above assigns 'asc' or 'desc'.
    console.warn(
      'Clicked column new order is undefined after map, this should not happen for sortable columns:',
      col.key
    )
  }
}

// --- 新增计算属性给 SongListRows ---
const playingSongFilePathForRows = computed(() => runtime.playingData.playingSong?.filePath)

// 新增：监听当前播放歌曲的变化，并滚动到视图
watch(
  () => runtime.playingData.playingSong,
  (newSong, oldSong) => {
    if (
      runtime.setting.autoScrollToCurrentSong &&
      newSong &&
      newSong.filePath !== oldSong?.filePath &&
      songsAreaRef.value
    ) {
      nextTick(() => {
        const scrollInstance = songsAreaRef.value?.osInstance()
        if (scrollInstance) {
          // SongListRows.vue 会给当前播放的歌曲行添加 .playingSong 类
          // 我们需要找到 .song-row-item 元素，因为 .song-row-content 可能不是直接的子元素。
          // 假设每个 song-row-item 包含一个 .song-row-content.playingSong
          // 或者更准确地说，SongListRows.vue 中，.playingSong 类是加在 .song-row-content 上的。
          // 我们需要滚动的是 .song-row-item
          const viewportElement = scrollInstance.elements().viewport
          // filePath 是唯一的，可以用来构造一个更精确的 data-attribute selector
          // 但目前 SongListRows.vue 并没有添加这样的 attribute。
          // 使用 .playingSong 类是最直接的方式，因为它是由 playingSongFilePathForRows 决定的。

          const playingSongContentElement = viewportElement.querySelector(
            '.song-row-content.playingSong'
          )

          if (playingSongContentElement) {
            const playingSongRowItem = playingSongContentElement.closest(
              '.song-row-item'
            ) as HTMLElement
            if (playingSongRowItem) {
              playingSongRowItem.scrollIntoView({ block: 'center', behavior: 'smooth' })
            }
          }
          // Playing song element might not be found if the song list is not the current playing list,
          // or if the song list has just changed and the DOM hasn't updated yet. This is acceptable.
        }
      })
    }
  },
  { deep: true } // deep might not be necessary if only filePath matters, but playingSong is an object.
)

// 新增：处理移动歌曲对话框确认后的逻辑
async function onMoveSongsDialogConfirmed(targetSongListUuid: string) {
  const pathsEffectivelyMoved = [...runtime.songsArea.selectedSongFilePath]

  if (pathsEffectivelyMoved.length === 0) {
    // 如果没有选中的歌曲，让 composable 的 handleMoveSongsConfirm 处理（它可能会直接关闭对话框或不做任何事）
    await handleMoveSongsConfirm(targetSongListUuid)
    return
  }

  // 调用 composable 中的函数来执行移动操作 (IPC, 关闭对话框, 清空选择等)
  // handleMoveSongsConfirm 应该会处理 isDialogVisible 和 selectedSongFilePath
  await handleMoveSongsConfirm(targetSongListUuid)

  // IPC 调用完成后，我们用 pathsEffectivelyMoved 来更新本地的 originalSongInfoArr
  originalSongInfoArr.value = originalSongInfoArr.value.filter(
    (song) => !pathsEffectivelyMoved.includes(song.filePath)
  )

  // 2. 根据当前的排序规则，重新排序 originalSongInfoArr 并更新 runtime.songsArea.songInfoArr
  const sortedCol = columnData.value.find((col) => col.order)
  if (sortedCol) {
    runtime.songsArea.songInfoArr = sortArrayByProperty<ISongInfo>(
      [...originalSongInfoArr.value],
      sortedCol.key as keyof ISongInfo,
      sortedCol.order
    )
  } else {
    runtime.songsArea.songInfoArr = [...originalSongInfoArr.value]
  }

  if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
    runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
  }

  if (
    runtime.playingData.playingSong &&
    pathsEffectivelyMoved.includes(runtime.playingData.playingSong.filePath)
  ) {
    runtime.playingData.playingSong = null // 或者可以设置为播放下一首等逻辑
  }
  // runtime.songsArea.selectedSongFilePath 应该已经被 handleMoveSongsConfirm (composable内部) 清空了
}

const shouldShowEmptyState = computed(() => {
  return (
    !isRequesting.value &&
    runtime.songsArea.songListUUID &&
    runtime.songsArea.songInfoArr.length === 0
  )
})
// --- END 新增计算属性 ---
</script>
<template>
  <div style="width: 100%; height: 100%; min-width: 0; overflow: hidden; position: relative">
    <div
      v-show="!loadingShow && !runtime.songsArea.songListUUID"
      class="unselectable welcomeContainer"
    >
      <welcomePage />
    </div>
    <div
      v-show="loadingShow"
      style="width: 100%; height: 100%; display: flex; justify-content: center; align-items: center"
    >
      <div class="loading"></div>
    </div>

    <OverlayScrollbarsComponent
      v-if="runtime.songsArea.songListUUID && !loadingShow"
      :options="{
        scrollbars: {
          autoHide: 'leave',
          autoHideDelay: 50,
          clickScroll: true
        },
        overflow: {
          x: 'scroll',
          y: 'scroll'
        }
      }"
      element="div"
      style="height: 100%; width: 100%; position: relative"
      defer
      ref="songsAreaRef"
      @click="runtime.songsArea.selectedSongFilePath.length = 0"
    >
      <SongListHeader
        :columns="columnData"
        :t="t"
        :ascendingOrder="ascendingOrder"
        :descendingOrder="descendingOrder"
        @update:columns="handleColumnsUpdate"
        @column-click="colMenuClick"
        @header-contextmenu="contextmenuEvent"
        @drag-start="runtime.dragTableHeader = true"
        @drag-end="runtime.dragTableHeader = false"
      />

      <!-- 使用 SongListRows 组件渲染歌曲列表 -->
      <SongListRows
        v-if="runtime.songsArea.songInfoArr.length > 0"
        :songs="runtime.songsArea.songInfoArr"
        :visibleColumns="columnDataArr"
        :selectedSongFilePaths="runtime.songsArea.selectedSongFilePath"
        :playingSongFilePath="playingSongFilePathForRows"
        @song-click="songClick"
        @song-contextmenu="handleSongContextMenuEvent"
        @song-dblclick="songDblClick"
      />

      <!-- Empty State: 如果没有歌曲且满足特定条件 (shouldShowEmptyState) -->
      <div
        v-else-if="shouldShowEmptyState"
        class="songs-area-empty-state unselectable"
        style="
          min-height: 200px;
          width: 100%;
          display: flex;
          justify-content: center;
          align-items: center;
          flex-direction: column;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
        "
      >
        <div style="font-size: 16px; color: #999999">
          {{ t('暂无曲目') }}
        </div>
        <div style="font-size: 12px; color: #999999; margin-top: 10px">
          {{ t('导入曲目到歌单中，或通过拖拽文件夹或音频文件进行导入。') }}
        </div>
      </div>
    </OverlayScrollbarsComponent>

    <ColumnHeaderContextMenu
      v-model="colRightClickMenuShow"
      :targetEvent="triggeringColContextEvent"
      :columns="columnData"
      :scrollHostElement="songsAreaRef?.osInstance()?.elements().host"
      @toggle-column-visibility="handleToggleColumnVisibility"
    />
    <Teleport to="body">
      <selectSongListDialog
        v-if="isSelectSongListDialogVisible"
        :libraryName="selectSongListDialogTargetLibraryName"
        @confirm="onMoveSongsDialogConfirmed"
        @cancel="handleDialogCancel"
      />
    </Teleport>
  </div>
</template>
<style lang="scss" scoped>
.loading {
  display: block;
  position: relative;
  width: 6px;
  height: 10px;

  animation: rectangle infinite 1s ease-in-out -0.2s;

  background-color: #cccccc;
}

.loading:before,
.loading:after {
  position: absolute;
  width: 6px;
  height: 10px;
  content: '';
  background-color: #cccccc;
}

.loading:before {
  left: -14px;

  animation: rectangle infinite 1s ease-in-out -0.4s;
}

.loading:after {
  right: -14px;

  animation: rectangle infinite 1s ease-in-out;
}

@keyframes rectangle {
  0%,
  80%,
  100% {
    height: 20px;
    box-shadow: 0 0 #cccccc;
  }

  40% {
    height: 30px;
    box-shadow: 0 -20px #cccccc;
  }
}

.welcomeContainer {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  min-width: 430px;
}

/* 为新的空状态容器添加一个类名，以便将来可能需要的特定样式 */
.songs-area-empty-state {
  /* Styles for empty state are mostly inline, but class is good for targeting */
  &.unselectable {
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
  }
}
</style>
