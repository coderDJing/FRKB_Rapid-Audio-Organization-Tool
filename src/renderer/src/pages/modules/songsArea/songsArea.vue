<script setup lang="ts">
import {
  watch,
  ref,
  shallowRef,
  nextTick,
  computed,
  onMounted,
  onUnmounted,
  useTemplateRef,
  markRaw
} from 'vue'
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
import { MIN_WIDTH_BY_KEY } from './minWidth'

// Composable import
import { useSongItemContextMenu } from '@renderer/pages/modules/songsArea/composables/useSongItemContextMenu'
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
// 使用浅响应+markRaw，避免为上千行数据创建深层 Proxy，降低 flushJobs 峰值
const originalSongInfoArr = shallowRef<ISongInfo[]>([])

// 渐进式渲染：限制首屏渲染数量，逐帧扩容，避免一次性挂载上千行
const renderCount = ref(0)
const visibleSongs = computed(() =>
  runtime.songsArea.songInfoArr.slice(0, Math.max(0, renderCount.value))
)

// Initialize composables
const { showAndHandleSongContextMenu } = useSongItemContextMenu(songsAreaRef)
const {
  isDialogVisible: isSelectSongListDialogVisible,
  targetLibraryName: selectSongListDialogTargetLibraryName,
  initiateMoveSongs,
  handleMoveSongsConfirm,
  handleDialogCancel
} = useSelectAndMoveSongs()
const { isDragging, startDragSongs, endDragSongs, handleDropToSongList } = useDragSongs()

// 统一额外初始宽度：在最小值基础上增加 40
const INIT_EXTRA_WIDTH = 40

// 基础列定义（不包含 width），避免写死无意义的宽度数字
const baseColumns: Omit<ISongsAreaColumn, 'width'>[] = [
  {
    columnName: 'columns.index',
    key: 'index',
    show: true
  },

  {
    columnName: 'columns.title',
    key: 'title',
    show: true,
    filterType: 'text'
  },
  {
    columnName: 'columns.artist',
    key: 'artist',
    show: true,
    filterType: 'text',
    order: 'asc'
  },
  {
    columnName: 'columns.duration',
    key: 'duration',
    show: true,
    filterType: 'duration'
  },
  {
    columnName: 'columns.album',
    key: 'album',
    show: true,
    filterType: 'text'
  },
  {
    columnName: 'columns.genre',
    key: 'genre',
    show: true,
    filterType: 'text'
  },
  {
    columnName: 'columns.label',
    key: 'label',
    show: true,
    filterType: 'text'
  },
  {
    columnName: 'columns.bitrate',
    key: 'bitrate',
    show: true
  },
  {
    columnName: 'columns.format',
    key: 'container',
    show: true,
    filterType: 'text'
  }
]

// 通过最小宽度映射 + 40 生成实际的默认列（带 width）
const defaultColumns: ISongsAreaColumn[] = baseColumns.map((col) => ({
  ...col,
  width: (MIN_WIDTH_BY_KEY[col.key] ?? 0) + INIT_EXTRA_WIDTH
}))

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
                columnName: defaultCol.columnName,
                filterType: defaultCol.filterType,
                // 是否保留筛选条件取决于设置项 persistSongFilters
                filterActive:
                  (runtime.setting.persistSongFilters ? savedCol.filterActive : false) ?? false,
                filterValue: runtime.setting.persistSongFilters ? savedCol.filterValue : undefined,
                filterOp: runtime.setting.persistSongFilters ? savedCol.filterOp : undefined,
                filterDuration: runtime.setting.persistSongFilters
                  ? savedCol.filterDuration
                  : undefined
              }
              return mergedCol
            }
            // 如果 defaultColumns 中已不存在此列 (旧版本残留)，则标记以便后续过滤或直接在此处排除
            return null
          })
          .filter((col) => col !== null) as ISongsAreaColumn[]

        // 2. 添加 defaultColumns 中新增的、但 localStorage 中没有的列（defaultColumns 已带宽度）
        defaultColumns.forEach((defaultCol) => {
          if (!finalColumns.some((fc) => fc.key === defaultCol.key)) {
            finalColumns.push(JSON.parse(JSON.stringify(defaultCol)))
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

    // --- 应用最小列宽校正（只提升到最小值，不降低；保证旧记忆不会小于最小宽度）---
    finalColumns = finalColumns.map((col) => {
      const minWidth = MIN_WIDTH_BY_KEY[col.key] ?? col.width
      if (col.width < minWidth) {
        return { ...col, width: minWidth }
      }
      return col
    })

    // --- 返回最终的列配置 ---
    return finalColumns
  })()
)

let loadingShow = ref(false)
const isRequesting = ref<boolean>(false)

const openSongList = async () => {
  const perfStartAll = performance.now()
  const prevOriginalLen = originalSongInfoArr.value.length
  const prevRuntimeLen = runtime.songsArea.songInfoArr.length
  const sortedColBefore = columnData.value.find((c) => c.order)

  // 列表不再显示封面

  isRequesting.value = true
  runtime.songsArea.songInfoArr = []
  originalSongInfoArr.value = []
  await nextTick()

  const songListPath = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID)

  loadingShow.value = false
  const loadingSetTimeout = setTimeout(() => {
    loadingShow.value = true
  }, 100)

  let perfInvokeStart = 0
  try {
    perfInvokeStart = performance.now()
    const {
      scanData,
      songListUUID,
      perf: mainPerf
    } = await window.electron.ipcRenderer.invoke(
      'scanSongList',
      songListPath,
      runtime.songsArea.songListUUID
    )

    if (songListUUID !== runtime.songsArea.songListUUID) {
      return
    }

    const perfAfterIPC = performance.now()
    const perfAssignStart = performance.now()
    // 避免深代理：整表标记为非响应
    originalSongInfoArr.value = markRaw(scanData)

    // 初次加载后应用筛选与排序
    applyFiltersAndSorting()
    const perfAfterFilterSort = performance.now()

    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    }

    // 列表不再显示封面

    // 渐进式渲染启动：先渲染少量行，随后逐帧扩容
    const totalRows = runtime.songsArea.songInfoArr.length
    const INITIAL_ROWS = 60
    const CHUNK_ROWS = 120
    renderCount.value = Math.min(totalRows, INITIAL_ROWS)
    await nextTick()
    ;(() => {
      const step = () => {
        if (renderCount.value >= totalRows) return
        renderCount.value = Math.min(renderCount.value + CHUNK_ROWS, totalRows)
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })()

    // 追加：等待 DOM 刷新 + 行元素稳定，尽可能接近“渲染完成”
    const perfBeforeDomFlush = performance.now()
    await nextTick()
    const perfAfterDomFlush = performance.now()

    const getRowsCount = (): number => {
      try {
        const vp = songsAreaRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined
        if (vp) {
          // 仅统计可视区域内且已插入的行
          return vp.querySelectorAll('.song-row-item').length
        }
        return document.querySelectorAll('.song-row-item').length
      } catch {
        return 0
      }
    }
    const waitRowsStable = async (timeoutMs = 4000) => {
      const start = performance.now()
      let last = -1
      let stableFrames = 0
      while (performance.now() - start < timeoutMs) {
        await new Promise((r) => requestAnimationFrame(r))
        const cur = getRowsCount()
        if (cur === last) stableFrames++
        else stableFrames = 0
        last = cur
        if (cur > 0 && stableFrames >= 2) {
          return { rowsRendered: cur, renderWaitMs: performance.now() - start }
        }
      }
      return { rowsRendered: Math.max(last, 0), renderWaitMs: performance.now() - start }
    }
    const renderWaitStart = performance.now()
    const { rowsRendered, renderWaitMs } = await waitRowsStable(8000)
    const perfAfterPaint = performance.now()

    const perfEndAll = performance.now()
    // 上报渲染端阶段耗时
    window.electron.ipcRenderer.send('perfLog', {
      scope: 'openSongList',
      songListUUID: runtime.songsArea.songListUUID,
      ms: {
        all: Math.round(perfEndAll - perfStartAll),
        beforeInvoke: Math.round(performance.now() - perfStartAll),
        ipcRoundtrip: Math.round(perfAfterIPC - perfInvokeStart),
        assignOriginal: Math.round(perfAfterFilterSort - perfAssignStart),
        filterAndSort: Math.round(perfAfterFilterSort - perfAssignStart),
        domFlushed: Math.round(perfAfterDomFlush - perfBeforeDomFlush),
        paintedSinceAssign: Math.round(perfAfterPaint - perfAssignStart),
        renderWait: Math.round(renderWaitMs)
      },
      render: {
        expectedRows: runtime.songsArea.songInfoArr.length,
        rowsRendered
      },
      mainPerf
    })
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
      runtime.songsArea.songInfoArr = []
      originalSongInfoArr.value = []
    }
  }
)

// 注意：不再通过监听 runtime.songsArea.songInfoArr 来清空 originalSongInfoArr，
// 以避免在筛选/列变更导致的临时空列表时误将原始数据清除。

window.electron.ipcRenderer.on('importFinished', async (event, songListUUID, _importSummary) => {
  if (songListUUID === runtime.songsArea.songListUUID) {
    setTimeout(async () => {
      await openSongList()
    }, 1000)
  }
})

// 全局事件处理函数（保持稳定引用，便于卸载时 off）
const onSongsRemoved = (payload: { listUUID?: string; paths: string[] } | { paths: string[] }) => {
  const pathsToRemove = Array.isArray((payload as any).paths) ? (payload as any).paths : []
  const listUUID = (payload as any).listUUID

  if (!pathsToRemove.length) return
  if (listUUID && listUUID !== runtime.songsArea.songListUUID) return
  // 从 original 中删除
  originalSongInfoArr.value = originalSongInfoArr.value.filter(
    (song) => !pathsToRemove.includes(song.filePath)
  )

  // 统一通过筛选与排序重建显示列表，避免直接操作 runtime 列表导致与排序链路打架
  applyFiltersAndSorting()

  // 同步播放数据（如果当前播放列表即为该歌单）
  if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
    runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    if (
      runtime.playingData.playingSong &&
      pathsToRemove.includes(runtime.playingData.playingSong.filePath)
    ) {
      runtime.playingData.playingSong = null
    }
  }

  // 从当前选择中移除已删除的歌曲
  runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
    (path) => !pathsToRemove.includes(path)
  )
}

const onSongsMovedByDrag = (movedSongPaths: string[]) => {
  if (!Array.isArray(movedSongPaths) || movedSongPaths.length === 0) return

  // 从 originalSongInfoArr 中移除歌曲

  // 更新 originalSongInfoArr
  originalSongInfoArr.value = originalSongInfoArr.value.filter(
    (song) => !movedSongPaths.includes(song.filePath)
  )
  // 统一通过筛选与排序重建显示列表
  applyFiltersAndSorting()

  // 如果当前播放列表是被修改的列表，更新播放数据
  if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
    runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    if (
      runtime.playingData.playingSong &&
      movedSongPaths.includes(runtime.playingData.playingSong.filePath)
    ) {
      runtime.playingData.playingSong = null
    }
  }

  // 清空选中状态中的对应项
  runtime.songsArea.selectedSongFilePath = runtime.songsArea.selectedSongFilePath.filter(
    (path) => !movedSongPaths.includes(path)
  )
}

onMounted(() => {
  emitter.on('songsRemoved', onSongsRemoved)
  emitter.on('songsMovedByDrag', onSongsMovedByDrag)
})

onUnmounted(() => {
  emitter.off('songsRemoved', onSongsRemoved)
  emitter.off('songsMovedByDrag', onSongsMovedByDrag)
})

// --- 父组件中用于持久化列数据的方法 ---
const persistColumnData = () => {
  localStorage.setItem('songColumnData', JSON.stringify(columnData.value))
}

// --- 处理来自 SongListHeader 的列更新 ---
const handleColumnsUpdate = (newColumns: ISongsAreaColumn[]) => {
  columnData.value = newColumns
  persistColumnData()
  // 应用筛选并清空选择
  applyFiltersAndSorting()
  runtime.songsArea.selectedSongFilePath.length = 0
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

// 模板内避免直接访问 window，提取为方法
const logRowsRendered = (count: number) => {
  try {
    window.electron.ipcRenderer.send('perfLog', {
      scope: 'rowsRendered',
      songListUUID: runtime.songsArea.songListUUID,
      rendered: count,
      expected: runtime.songsArea.songInfoArr.length,
      ts: Date.now()
    })
  } catch {}
}

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
        // 1. 从 originalSongInfoArr (原始顺序的源) 中移除歌曲
        originalSongInfoArr.value = originalSongInfoArr.value.filter(
          (item) => !pathsToRemove.includes(item.filePath)
        )

        // 2. 从 runtime.songsArea.songInfoArr (当前显示的、可能已排序的列表) 中移除歌曲
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

const songDblClick = async (song: ISongInfo) => {
  const lower = (song.filePath || '').toLowerCase()
  if (lower.endsWith('.aif') || lower.endsWith('.aiff')) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('player.aiffNotSupported')],
      confirmShow: false
    })
    return
  }

  runtime.activeMenuUUID = ''
  runtime.songsArea.selectedSongFilePath = []
  runtime.playingData.playingSong = song
  runtime.playingData.playingSongListUUID = runtime.songsArea.songListUUID
  runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
}
const handleDeleteKey = async () => {
  const selectedPaths = JSON.parse(JSON.stringify(runtime.songsArea.selectedSongFilePath))
  if (!selectedPaths.length) return false

  const isInRecycleBin = runtime.libraryTree.children
    ?.find((item) => item.dirName === 'RecycleBin')
    ?.children?.find((item) => item.uuid === runtime.songsArea.songListUUID)

  let shouldDelete = true
  if (isInRecycleBin) {
    let res = await confirm({
      title: t('common.delete'),
      content: [t('tracks.confirmDeleteSelected'), t('tracks.deleteHint')]
    })
    shouldDelete = res === 'confirm'
  }

  if (shouldDelete) {
    if (isInRecycleBin) {
      window.electron.ipcRenderer.invoke('permanentlyDelSongs', selectedPaths)
    } else {
      window.electron.ipcRenderer.send('delSongs', selectedPaths, getCurrentTimeDirName())
    }

    originalSongInfoArr.value = originalSongInfoArr.value.filter(
      (item) => !selectedPaths.includes(item.filePath)
    )

    // 统一通过筛选与排序函数重建显示列表，避免直接从 original 拷贝导致“复活”
    applyFiltersAndSorting()

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

// --- 工具：解析 MM:SS 为秒 ---
function parseDurationToSeconds(mmss: string): number {
  if (!mmss || typeof mmss !== 'string') return NaN
  const parts = mmss.split(':')
  if (parts.length !== 2) return NaN
  const m = Number(parts[0])
  const s = Number(parts[1])
  if (Number.isNaN(m) || Number.isNaN(s)) return NaN
  return m * 60 + s
}

// --- 根据列筛选过滤并按当前排序排序 ---
function applyFiltersAndSorting() {
  // 从 original 过滤
  let filtered = [...originalSongInfoArr.value]

  for (const col of columnData.value) {
    if (!col.filterActive) continue
    if (col.filterType === 'text' && col.filterValue && col.key) {
      const keyword = String(col.filterValue).toLowerCase()
      filtered = filtered.filter((song) => {
        const value = String((song as any)[col.key] ?? '').toLowerCase()
        return value.includes(keyword)
      })
    } else if (col.filterType === 'duration' && col.filterOp && col.filterDuration) {
      const target = parseDurationToSeconds(col.filterDuration)
      filtered = filtered.filter((song) => {
        const dur = parseDurationToSeconds(String((song as any)['duration'] ?? ''))
        if (Number.isNaN(dur) || Number.isNaN(target)) return false
        if (col.filterOp === 'eq') return dur === target
        if (col.filterOp === 'gte') return dur >= target
        if (col.filterOp === 'lte') return dur <= target
        return true
      })
    }
  }

  // 排序
  const sortedCol = columnData.value.find((c) => c.order)
  if (sortedCol) {
    filtered = sortArrayByProperty<ISongInfo>(
      filtered,
      sortedCol.key as keyof ISongInfo,
      sortedCol.order
    )
  }

  runtime.songsArea.songInfoArr = filtered
}
const colMenuClick = (col: ISongsAreaColumn) => {
  if (col.key === 'index') {
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

  // 统一通过筛选与排序函数重建显示数据，避免直接从 original 拷贝导致“复活”
  applyFiltersAndSorting()

  if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
    runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
  }

  // 列表不再处理封面加载
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
  // 不在此处直接重建 original/runtime，避免与全局 events（songsRemoved）重复或打架导致“复活”
  // 仅记录日志，列表更新完全交给事件流处理
  // runtime.songsArea.selectedSongFilePath 应该已经被 handleMoveSongsConfirm (composable内部) 清空了
}

const shouldShowEmptyState = computed(() => {
  return (
    !isRequesting.value &&
    runtime.songsArea.songListUUID &&
    runtime.songsArea.songInfoArr.length === 0
  )
})
// 是否存在任意激活的筛选条件
const hasActiveFilter = computed(() => columnData.value.some((c) => !!c.filterActive))
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
        :songs="visibleSongs"
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
        @rows-rendered="logRowsRendered"
      />
    </OverlayScrollbarsComponent>

    <!-- Empty State Overlay: 独立于滚动内容，始终居中在可视区域 -->
    <div v-if="shouldShowEmptyState && !loadingShow" class="songs-area-empty-overlay unselectable">
      <div class="empty-box">
        <div class="title">
          {{ hasActiveFilter ? t('filters.noResults') : t('tracks.noTracks') }}
        </div>
        <div class="hint">
          {{ hasActiveFilter ? t('filters.noResultsHint') : t('tracks.noTracksHint') }}
        </div>
      </div>
    </div>

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

/* 新的空态覆盖层，固定在可视区域中央，不受横向滚动影响 */
.songs-area-empty-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.songs-area-empty-overlay .empty-box {
  min-height: 120px;
  min-width: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.songs-area-empty-overlay .title {
  font-size: 16px;
  color: #999999;
}
.songs-area-empty-overlay .hint {
  font-size: 12px;
  color: #999999;
  margin-top: 10px;
}
</style>
