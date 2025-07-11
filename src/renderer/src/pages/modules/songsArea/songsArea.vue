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
import { useDragSongs } from '@renderer/pages/modules/songsArea/composables/useDragSongs'
import emitter from '@renderer/utils/mitt'

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
const { isDragging, startDragSongs, endDragSongs, handleDropToSongList } = useDragSongs()

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
      // --- 情况 1: 没有本地存储，直接使用默认值深拷贝副本 ---
      finalColumns = JSON.parse(JSON.stringify(defaultColumns))
    } else {
      // --- 情况 2: 有本地存储，进行合并 ---
      try {
        const parsedSavedColumns: ISongsAreaColumn[] = JSON.parse(savedData)
        const defaultColumnsMap = new Map(defaultColumns.map((col) => [col.key, col]))

        // 1. 以 localStorage 中保存的顺序为基础
        finalColumns = parsedSavedColumns
          .map((savedCol) => {
            const defaultCol = defaultColumnsMap.get(savedCol.key)
            if (defaultCol) {
              // 如果默认配置中还存在该列，则合并属性
              // savedCol 的属性优先，但要确保核心属性来自 defaultCol 以防存储数据不完整或过时
              const mergedCol = {
                ...defaultCol, // 以默认列为基础，确保 columnName 等核心属性是最新的
                // show 和 width 优先用 savedCol 的 (如果存在)
                show: savedCol.show !== undefined ? savedCol.show : defaultCol.show,
                width: savedCol.width !== undefined ? savedCol.width : defaultCol.width,
                // order 的特殊处理:
                // 如果 savedCol 中明确有 order 属性值 (asc/desc), 则使用它。
                // 如果 savedCol 中没有 order 属性 (JSON.stringify 会移除 undefined 的键),
                // 则此列的 order 应该是 undefined，不应从 defaultCol 继承默认排序。
                order: savedCol.hasOwnProperty('order') ? savedCol.order : undefined,
                // 确保 key 和 columnName 来自最新的 defaultColumns，而不是可能过时的 localStorage
                key: defaultCol.key,
                columnName: defaultCol.columnName
              }
              return mergedCol
            }
            // 如果 defaultColumns 中已不存在此列 (旧版本残留)，则标记以便后续过滤或直接在此处排除
            return null
          })
          .filter((col) => col !== null) as ISongsAreaColumn[]

        // 2. 添加 defaultColumns 中新增的、但 localStorage 中没有的列
        defaultColumns.forEach((defaultCol) => {
          if (!finalColumns.some((fc) => fc.key === defaultCol.key)) {
            finalColumns.push(JSON.parse(JSON.stringify(defaultCol))) // 添加新列的深拷贝副本
          }
        })

        // 3. 确保最终的列只包含当前 defaultColumns 中定义的 key (移除在 localStorage 中但已在 defaultColumns 中废弃的列)
        // 这一步在步骤1的 filter(col => col !== null) 以及对 defaultCol 的依赖已经间接处理了
        // 如果需要更严格的基于 defaultColumns 的 key 过滤，可以再次执行：
        finalColumns = finalColumns.filter((fc) => defaultColumnsMap.has(fc.key))
      } catch (error) {
        console.error(
          '解析本地存储的 songColumnData 出错或合并时发生错误，将使用默认列配置:',
          error
        )
        finalColumns = JSON.parse(JSON.stringify(defaultColumns)) // 出错则回退到默认深拷贝副本
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

// 监听 songInfoArr 的变化，同步更新 originalSongInfoArr
watch(
  () => runtime.songsArea.songInfoArr,
  (newSongInfoArr) => {
    // 如果 songInfoArr 被清空（比如清空歌单操作），同步清空 originalSongInfoArr
    if (newSongInfoArr.length === 0) {
      originalSongInfoArr.value = []
    }
  },
  { deep: true }
)

window.electron.ipcRenderer.on('importFinished', async (event, contentArr, songListUUID) => {
  if (songListUUID == runtime.songsArea.songListUUID) {
    setTimeout(async () => {
      await openSongList()
    }, 1000)
  }
})

// 监听歌曲拖拽移动事件
emitter.on('songsMovedByDrag', (movedSongPaths: string[]) => {
  if (Array.isArray(movedSongPaths) && movedSongPaths.length > 0) {
    // 从 originalSongInfoArr 中移除歌曲
    const songsToRemove = originalSongInfoArr.value.filter((song) =>
      movedSongPaths.includes(song.filePath)
    )

    // 释放封面 URL
    songsToRemove.forEach((song) => {
      if (song.coverUrl) {
        URL.revokeObjectURL(song.coverUrl)
      }
    })

    // 更新 originalSongInfoArr
    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (song) => !movedSongPaths.includes(song.filePath)
    )

    // 更新 runtime.songsArea.songInfoArr
    runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.filter(
      (song) => !movedSongPaths.includes(song.filePath)
    )

    // 如果当前播放列表是被修改的列表，更新播放数据
    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr

      // 如果当前播放的歌曲是被移动的歌曲之一，停止播放
      if (
        runtime.playingData.playingSong &&
        movedSongPaths.includes(runtime.playingData.playingSong.filePath)
      ) {
        runtime.playingData.playingSong = null
      }
    }

    // 清空选中状态
    runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
      (path) => !movedSongPaths.includes(path)
    )
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

const columnDataArr = computed(() => {
  return columnData.value.filter((item) => item.show)
})

const totalColumnsWidth = computed(() => {
  // 确保至少有一个基础宽度，例如，如果没有列，则为0，或者是一个最小的默认值
  if (!columnDataArr.value || columnDataArr.value.length === 0) {
    return 0 // 或者一个合适的最小宽度
  }
  return columnDataArr.value.reduce((sum, col) => sum + (col.width || 0), 0)
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
      const pathsToRemove = result.paths

      if (Array.isArray(pathsToRemove) && pathsToRemove.length > 0) {
        // const originalPathsBeforeFilter = runtime.songsArea.songInfoArr.map(s => s.filePath);

        // 1. 从 originalSongInfoArr (原始顺序的源) 中移除歌曲
        // const initialOriginalCount = originalSongInfoArr.value.length;
        originalSongInfoArr.value = originalSongInfoArr.value.filter(
          (item) => !pathsToRemove.includes(item.filePath)
        )

        // 2. 从 runtime.songsArea.songInfoArr (当前显示的、可能已排序的列表) 中移除歌曲
        // const initialRuntimeCount = runtime.songsArea.songInfoArr.length;
        const newRuntimeSongInfoArr = runtime.songsArea.songInfoArr.filter(
          (item) => !pathsToRemove.includes(item.filePath)
        )
        runtime.songsArea.songInfoArr = newRuntimeSongInfoArr

        // 3. 更新播放列表和当前播放歌曲 (如果受影响)
        if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
          runtime.playingData.playingSongListData = [...runtime.songsArea.songInfoArr] // 使用更新后的 runtime.songsArea.songInfoArr
        }
        if (
          runtime.playingData.playingSong &&
          pathsToRemove.includes(runtime.playingData.playingSong.filePath)
        ) {
          runtime.playingData.playingSong = null
        }

        // 4. 从当前选择中移除已删除的歌曲
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

// 拖拽相关函数
const handleSongDragStart = (event: DragEvent, song: ISongInfo) => {
  if (!runtime.songsArea.songListUUID) return

  // 确保拖拽的歌曲在选中列表中
  const isSelected = runtime.songsArea.selectedSongFilePath.includes(song.filePath)

  if (!isSelected || runtime.songsArea.selectedSongFilePath.length === 0) {
    // 如果这首歌没有被选中，或者没有选中任何歌曲，就选中这首歌
    runtime.songsArea.selectedSongFilePath = [song.filePath]
  }

  startDragSongs(song, runtime.libraryAreaSelected, runtime.songsArea.songListUUID)

  // 设置拖拽数据
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(
      'application/x-song-drag',
      JSON.stringify({
        type: 'song',
        sourceLibraryName: runtime.libraryAreaSelected,
        sourceSongListUUID: runtime.songsArea.songListUUID
      })
    )
  }
}

const handleSongDragEnd = (event: DragEvent) => {
  endDragSongs()
}

// 新增 watch 来同步 songsArea 和 playingData.playingSongListData
watch(
  () => runtime.playingData.playingSongListData,
  (newPlayingListData, oldPlayingListData) => {
    const currentSongsAreaListUUID = runtime.songsArea.songListUUID
    const currentPlayingListUUID = runtime.playingData.playingSongListUUID

    // 仅当 songsArea 显示的是当前播放列表时才进行同步
    if (currentSongsAreaListUUID && currentSongsAreaListUUID === currentPlayingListUUID) {
      const songsInArea = runtime.songsArea.songInfoArr
      if (!songsInArea || songsInArea.length === 0) return

      const areaFilePaths = new Set(songsInArea.map((s) => s.filePath))
      const playingListFilePaths = new Set((newPlayingListData || []).map((s) => s.filePath))

      const pathsToRemove: string[] = []
      areaFilePaths.forEach((filePath) => {
        if (!playingListFilePaths.has(filePath)) {
          pathsToRemove.push(filePath)
        }
      })

      if (pathsToRemove.length > 0) {
        originalSongInfoArr.value = originalSongInfoArr.value.filter(
          (item) => !pathsToRemove.includes(item.filePath)
        )

        runtime.songsArea.songInfoArr = songsInArea.filter(
          (item) => !pathsToRemove.includes(item.filePath)
        )

        runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
          (path) => !pathsToRemove.includes(path)
        )
      }
    }
  },
  { deep: true } // 使用 deep watch 以便检测数组内部元素的更改或数组自身的替换
)
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
        :total-width="totalColumnsWidth"
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
        :total-width="totalColumnsWidth"
        :sourceLibraryName="runtime.libraryAreaSelected"
        :sourceSongListUUID="runtime.songsArea.songListUUID"
        @song-click="songClick"
        @song-contextmenu="handleSongContextMenuEvent"
        @song-dblclick="songDblClick"
        @song-dragstart="handleSongDragStart"
        @song-dragend="handleSongDragEnd"
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
