<script setup lang="ts">
import {
  watch,
  ref,
  nextTick,
  computed,
  onMounted,
  Ref,
  useTemplateRef,
  ComponentInternalInstance
} from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { UseDraggableOptions, vDraggable } from 'vue-draggable-plus'
import hotkeys from 'hotkeys-js'
import { t } from '@renderer/utils/translate'
import { IMenu, ISongInfo, ISongsAreaColumn } from '../../../../types/globals'

// 组件导入
import songAreaColRightClickMenu from '@renderer/components/songAreaColRightClickMenu.vue'
import confirm from '@renderer/components/confirmDialog'
import selectSongListDialog from '@renderer/components/selectSongListDialog.vue'
import rightClickMenu from '../../components/rightClickMenu'
import exportDialog from '../../components/exportDialog'
import welcomePage from '@renderer/components/welcomePage.vue'

// 资源导入
import ascendingOrder from '@renderer/assets/ascending-order.png?asset'
import descendingOrder from '@renderer/assets/descending-order.png?asset'
import { getCurrentTimeDirName } from '@renderer/utils/utils'

import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

// 类型定义，以便正确引用 OverlayScrollbarsComponent 实例
type OverlayScrollbarsComponentRef = InstanceType<typeof OverlayScrollbarsComponent> | null

// 用于标识当前有效的封面加载任务
const coverLoadTaskId = ref(0)
// 用于跟踪当前列表的封面是否已全部加载完成
const coversLoadCompleted = ref(false)

// 定义异步分批处理封面的函数 (使用 requestAnimationFrame)
// 返回 Promise<boolean> 指示任务是否完整完成 (true) 或被取消 (false)
async function processCoversInBatchesRAF(
  data: ISongInfo[],
  currentTaskId: number,
  batchSize = 1
): Promise<boolean> {
  // 检查启动时的任务 ID 是否仍然有效
  if (coverLoadTaskId.value !== currentTaskId) {
    // 如果 ID 已改变，则此任务作废，直接返回
    return false // 被取消
  }

  for (let i = 0; i < data.length; i += batchSize) {
    // 在循环开始时再次检查，以防在 await 期间 ID 变化后循环继续
    if (coverLoadTaskId.value !== currentTaskId) {
      return false // 被取消
    }

    const batch = data.slice(i, i + batchSize)
    batch.forEach((item: ISongInfo) => {
      // 检查是否有封面数据且尚未创建 URL
      if (item.cover && !item.coverUrl) {
        try {
          const blob = new Blob([Uint8Array.from(item.cover.data)], { type: item.cover.format })
          item.coverUrl = URL.createObjectURL(blob)
        } catch (error) {
          console.error('Error creating blob URL for item:', item.filePath, error)
        }
      }
    })

    // 处理完一个批次后，等待下一帧
    await new Promise((resolve) => requestAnimationFrame(resolve))

    // 在下一帧开始前，再次检查任务 ID 是否仍然有效
    if (coverLoadTaskId.value !== currentTaskId) {
      return false // 被取消
    }
  }
  // 任务正常完成
  return true // 完整完成
}

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
      finalColumns = JSON.parse(JSON.stringify(defaultColumns)) // 使用深拷贝以防修改默认值
    } else {
      // --- 情况 2: 有本地存储，进行合并 ---
      try {
        const parsedData: ISongsAreaColumn[] = JSON.parse(savedData)
        const savedColumnsMap = new Map(parsedData.map((col) => [col.key, col]))

        // 1. 以 defaultColumns 为基础进行合并
        finalColumns = defaultColumns.map((defaultCol) => {
          const savedCol = savedColumnsMap.get(defaultCol.key)
          if (savedCol) {
            // 如果本地存储中有此列，合并设置
            // 保留默认列的所有键，但用保存的值覆盖 show, width, order
            // 注意：要检查 savedCol 中属性是否存在，避免 undefined 覆盖默认值
            return {
              ...defaultCol, // 包含默认列的所有属性（如 columnName, key）
              show: savedCol.show !== undefined ? savedCol.show : defaultCol.show,
              width: savedCol.width !== undefined ? savedCol.width : defaultCol.width,
              order: savedCol.order // 如果保存的有 order，则使用，否则为 undefined
            }
          } else {
            // 如果本地存储中没有此列（例如新添加的列），使用默认列（深拷贝）
            return JSON.parse(JSON.stringify(defaultCol))
          }
        })

        // 2. 处理本地存储中有，但 defaultColumns 中已移除的列
        // 如果需要清理掉旧版本遗留的、新版本已废弃的列，可以在这里过滤
        finalColumns = finalColumns.filter((col) => defaultColumns.some((dc) => dc.key === col.key))
      } catch (error) {
        console.error('解析本地存储的 songColumnData 出错，将使用默认列配置:', error)
        // 解析出错，也回退到默认配置
        finalColumns = JSON.parse(JSON.stringify(defaultColumns))
      }
    }

    // --- 确保至少有一个默认排序列（如果用户没有设置任何排序列） ---
    // 检查合并后的 finalColumns 是否没有任何列设置了 order
    const hasOrderAfterMerge = finalColumns.some((col) => col.order !== undefined)
    if (!hasOrderAfterMerge) {
      // 如果没有任何列排序，并且 'duration' 列存在，则默认给 'duration' 升序
      const durationColIndex = finalColumns.findIndex((col) => col.key === 'duration')
      if (durationColIndex !== -1) {
        finalColumns[durationColIndex] = { ...finalColumns[durationColIndex], order: 'asc' }
      }
      // 如果 'duration' 列不存在，可以考虑给其他列如 'title' 设置默认排序 (这里保留，以防万一)
      else {
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

const runtime = useRuntimeStore()
let loadingShow = ref(false)

const isRequesting = ref<boolean>(false)
const openSongList = async () => {
  // 清理现有歌曲列表的封面URL
  runtime.songsArea.songInfoArr.forEach((item) => {
    if (item.coverUrl) {
      URL.revokeObjectURL(item.coverUrl)
    }
  })
  // --- 取消旧任务并重置完成状态 ---
  coverLoadTaskId.value++
  coversLoadCompleted.value = false // 新列表加载，重置完成状态

  isRequesting.value = true
  runtime.songsArea.songInfoArr = []
  await nextTick()

  const songListPath = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID)

  // 处理加载状态
  loadingShow.value = false
  const loadingSetTimeout = setTimeout(() => {
    loadingShow.value = true
  }, 100)

  try {
    // 扫描歌单
    const { scanData, songListUUID } = await window.electron.ipcRenderer.invoke(
      'scanSongList',
      songListPath,
      runtime.songsArea.songListUUID
    )

    if (songListUUID !== runtime.songsArea.songListUUID) {
      return
    }

    // 根据排序规则处理数据，并将结果赋值给响应式数组
    const sortedCol = columnData.value.find((col) => col.order)
    if (sortedCol) {
      // 注意：这里先对 scanData 排序，再赋值给响应式数组
      runtime.songsArea.songInfoArr = sortArrayByProperty<ISongInfo>(
        scanData, // 使用原始 scanData 进行排序
        sortedCol.key as keyof ISongInfo,
        sortedCol.order
      )
    } else {
      // 没有排序规则，直接赋值
      runtime.songsArea.songInfoArr = scanData
    }

    // 如果当前播放列表是正在打开的列表，也更新播放列表数据引用
    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    }

    // --- 启动新的封面加载任务，并设置完成回调 ---
    // 传递当前的 taskId
    processCoversInBatchesRAF(runtime.songsArea.songInfoArr, coverLoadTaskId.value).then(
      (completed) => {
        // 只有当这个任务确实完成了（没有中途被新的任务取消）才标记为完成
        if (completed) {
          coversLoadCompleted.value = true
        }
      }
    )
  } finally {
    isRequesting.value = false
    clearTimeout(loadingSetTimeout)
    loadingShow.value = false
    runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
  }
}
watch(
  () => runtime.songsArea.songListUUID,
  async (newUUID) => {
    // 清空选中歌曲
    runtime.songsArea.selectedSongFilePath.length = 0

    if (newUUID) {
      // 有歌单UUID时打开歌单
      await openSongList()
    } else {
      // 无歌单UUID时清理资源
      runtime.songsArea.songInfoArr.forEach((item) => {
        if (item.coverUrl) {
          URL.revokeObjectURL(item.coverUrl)
        }
      })
      runtime.songsArea.songInfoArr = []
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
function onUpdate() {
  localStorage.setItem('songColumnData', JSON.stringify(columnData.value))
}

let startX = 0
let resizingCol: ISongsAreaColumn
let isResizing = false
let initWidth = 0

let isResizeClick = false
function startResize(e: MouseEvent, col: ISongsAreaColumn) {
  if (col.key === 'coverUrl') {
    return
  }
  e.stopPropagation()
  e.preventDefault()
  isResizing = true
  isResizeClick = true
  startX = e.clientX
  resizingCol = col
  initWidth = col.width
  document.addEventListener('mousemove', resize)
  document.addEventListener('mouseup', stopResize)
}

function resize(e: MouseEvent) {
  e.stopPropagation()
  e.preventDefault()
  if (!isResizing) return
  const deltaX = e.clientX - startX
  const newWidth = Math.max(50, initWidth + deltaX) // 设置最小宽度
  resizingCol.width = newWidth
}

function stopResize(e: MouseEvent) {
  e.stopPropagation()
  e.preventDefault()
  isResizing = false
  document.removeEventListener('mousemove', resize)
  document.removeEventListener('mouseup', stopResize)
  onUpdate()
  setTimeout(() => {
    isResizeClick = false
  }, 0)
}

const colRightClickMenuShow = ref(false)
const colRightClickEvent = ref({ x: 0, y: 0 })

// 将 songsAreaRef 的类型显式定义为 OverlayScrollbarsComponentRef
const songsAreaRef = useTemplateRef<OverlayScrollbarsComponentRef>('songsAreaRef')

const contextmenuEvent = (event: MouseEvent) => {
  // 尝试通过 OverlayScrollbars 实例获取 host 元素的边界
  const hostElement = songsAreaRef.value?.osInstance()?.elements().host
  if (hostElement) {
    const parentRect = hostElement.getBoundingClientRect()
    const absoluteX = event.clientX
    const absoluteY = event.clientY

    // Estimate menu dimensions (using your previous estimates)
    const menuHeightEstimate = columnData.value.length * 40
    const menuWidthEstimate = 255

    let adjustedAbsoluteX = absoluteX
    let adjustedAbsoluteY = absoluteY

    // Boundary checks using absolute coordinates and window dimensions
    const windowWidth = window.innerWidth
    const windowHeight = window.innerHeight

    // Apply your original adjustment logic
    if (absoluteY + menuHeightEstimate > windowHeight) {
      adjustedAbsoluteY = absoluteY - (absoluteY + menuHeightEstimate - windowHeight)
    }
    if (absoluteX + menuWidthEstimate > windowWidth) {
      adjustedAbsoluteX = absoluteX - (absoluteX + menuWidthEstimate - windowWidth)
    }

    // Convert adjusted absolute coordinates back to relative coordinates
    const adjustedRelativeX = adjustedAbsoluteX - parentRect.left
    const adjustedRelativeY = adjustedAbsoluteY - parentRect.top

    colRightClickEvent.value = { x: adjustedRelativeX, y: adjustedRelativeY }
    colRightClickMenuShow.value = true
  } else {
    // Fallback: Use original absolute coordinates, no relative conversion or adjustment possible
    colRightClickEvent.value = { x: event.clientX, y: event.clientY }
    colRightClickMenuShow.value = true
  }
}

const colMenuHandleClick = (item: ISongsAreaColumn) => {
  for (let col of columnData.value) {
    if (col.key === item.key) {
      col.show = !col.show
      onUpdate()
      return
    }
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

const menuArr = ref<IMenu[][]>([
  [{ menuName: '导出曲目' }],
  [{ menuName: '移动到筛选库' }, { menuName: '移动到精选库' }],
  [{ menuName: '删除曲目', shortcutKey: 'Delete' }, { menuName: '删除上方所有曲目' }],
  [{ menuName: '在文件资源浏览器中显示' }]
])

const songContextmenu = async (event: MouseEvent, song: ISongInfo) => {
  if (runtime.songsArea.selectedSongFilePath.indexOf(song.filePath) === -1) {
    runtime.songsArea.selectedSongFilePath = [song.filePath]
  }
  let result = await rightClickMenu({
    menuArr: menuArr.value,
    clickEvent: event
  })
  if (result !== 'cancel') {
    if (result.menuName === '删除上方所有曲目') {
      let delSongs = []
      for (let item of runtime.songsArea.songInfoArr) {
        if (item.filePath === song.filePath) {
          break
        }
        if (item.coverUrl) {
          URL.revokeObjectURL(item.coverUrl)
        }
        delSongs.push(item.filePath)
      }
      if (delSongs.length === 0) {
        return
      }

      const isInRecycleBin = runtime.libraryTree.children
        ?.find((item) => item.dirName === '回收站')
        ?.children?.find((item) => item.uuid === runtime.songsArea.songListUUID)

      if (isInRecycleBin) {
        let res = await confirm({
          title: '删除',
          content: [
            t('确定彻底删除此曲目上方的所有曲目吗'),
            t('（曲目将在磁盘上被删除，但声音指纹依然会保留）')
          ]
        })
        if (res !== 'confirm') {
          return
        }
      }

      if (isInRecycleBin) {
        window.electron.ipcRenderer.invoke(
          'permanentlyDelSongs',
          JSON.parse(JSON.stringify(delSongs))
        )
      } else {
        window.electron.ipcRenderer.send(
          'delSongs',
          JSON.parse(JSON.stringify(delSongs)),
          getCurrentTimeDirName()
        )
      }

      runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.filter(
        (song) => !delSongs.includes(song.filePath)
      )
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
      if (
        runtime.playingData.playingSong &&
        delSongs.indexOf(runtime.playingData.playingSong.filePath) !== -1
      ) {
        runtime.playingData.playingSong = null
      }
      // 使用 OverlayScrollbars viewport 的原生 scrollTo 方法
      nextTick(() => {
        // 确保在 DOM 更新后执行
        const viewport = songsAreaRef.value?.osInstance()?.elements().viewport
        if (viewport) {
          viewport.scrollTo({ top: 0, behavior: 'smooth' })
        } else {
          console.warn('OverlayScrollbars viewport element not available.')
        }
      })
    } else if (result.menuName === '删除曲目') {
      deleteSong()
    } else if (result.menuName === '移动到精选库') {
      selectSongListDialogLibraryName.value = '精选库'
      selectSongListDialogShow.value = true
    } else if (result.menuName === '移动到筛选库') {
      selectSongListDialogLibraryName.value = '筛选库'
      selectSongListDialogShow.value = true
    } else if (result.menuName === '导出曲目') {
      let result = await exportDialog({ title: '曲目' })
      if (result !== 'cancel') {
        let folderPathVal = result.folderPathVal
        let deleteSongsAfterExport = result.deleteSongsAfterExport
        let songs = runtime.songsArea.songInfoArr.filter(
          (item) => runtime.songsArea.selectedSongFilePath.indexOf(item.filePath) !== -1
        )
        await window.electron.ipcRenderer.invoke(
          'exportSongsToDir',
          folderPathVal,
          deleteSongsAfterExport,
          JSON.parse(JSON.stringify(songs))
        )
        if (deleteSongsAfterExport) {
          for (let item of songs) {
            if (item.coverUrl) {
              URL.revokeObjectURL(item.coverUrl)
            }
          }
          runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.filter(
            (item) => runtime.songsArea.selectedSongFilePath.indexOf(item.filePath) === -1
          )
          runtime.songsArea.selectedSongFilePath = []
          if (runtime.songsArea.songListUUID === runtime.playingData.playingSongListUUID) {
            runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr

            if (
              runtime.playingData.playingSongListData.filter(
                (item) => item.filePath === runtime.playingData.playingSong?.filePath
              ).length === 0
            ) {
              runtime.playingData.playingSong = null
            }
          }
        }
      }
    } else if (result.menuName === '在文件资源浏览器中显示') {
      window.electron.ipcRenderer.send('show-item-in-folder', song.filePath)
    }
  }
}

const selectSongListDialogShow = ref(false)
const selectSongListDialogLibraryName = ref('')

const selectSongListDialogConfirm = async (songListUUID: string) => {
  selectSongListDialogShow.value = false
  if (songListUUID === runtime.songsArea.songListUUID) {
    return
  }
  await window.electron.ipcRenderer.invoke(
    'moveSongsToDir',
    JSON.parse(JSON.stringify(runtime.songsArea.selectedSongFilePath)),
    libraryUtils.findDirPathByUuid(songListUUID)
  )
  let filteredSongInfoArr = runtime.songsArea.songInfoArr.filter((item) => {
    if (!runtime.songsArea.selectedSongFilePath.includes(item.filePath)) {
      return true
    } else {
      if (item.coverUrl) {
        URL.revokeObjectURL(item.coverUrl)
      }
      return false
    }
  })
  runtime.songsArea.songInfoArr = filteredSongInfoArr
  runtime.songsArea.selectedSongFilePath.length = 0
}

watch(
  () => runtime.playingData.playingSong,
  async () => {
    if (runtime.setting.autoScrollToCurrentSong) {
      if (runtime.playingData.playingSong !== null) {
        if (runtime.songsArea.songListUUID === runtime.playingData.playingSongListUUID) {
          nextTick(() => {
            let playingDom = document.querySelector('.playingSong')
            if (playingDom) {
              playingDom.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
          })
        }
      }
    }
    if (
      runtime.songsArea.songListUUID === runtime.playingData.playingSongListUUID &&
      runtime.playingData.playingSongListData.length !== runtime.songsArea.songInfoArr.length
    ) {
      for (let item of runtime.songsArea.songInfoArr) {
        if (item.coverUrl) {
          URL.revokeObjectURL(item.coverUrl)
        }
      }
      for (let item of runtime.playingData.playingSongListData) {
        if (item.cover) {
          let blob = new Blob([Uint8Array.from(item.cover.data)], { type: item.cover.format })
          const blobUrl = URL.createObjectURL(blob)
          item.coverUrl = blobUrl
        }
      }
      runtime.songsArea.songInfoArr = runtime.playingData.playingSongListData
    }
  }
)
const songDblClick = (song: ISongInfo) => {
  runtime.activeMenuUUID = ''

  runtime.songsArea.selectedSongFilePath = []
  runtime.playingData.playingSong = song
  runtime.playingData.playingSongListUUID = runtime.songsArea.songListUUID
  runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
  window.electron.ipcRenderer.send('readSongFile', song.filePath)
}
const deleteSong = async () => {
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
      window.electron.ipcRenderer.invoke(
        'permanentlyDelSongs',
        JSON.parse(JSON.stringify(runtime.songsArea.selectedSongFilePath))
      )
    } else {
      window.electron.ipcRenderer.send(
        'delSongs',
        JSON.parse(JSON.stringify(runtime.songsArea.selectedSongFilePath)),
        getCurrentTimeDirName()
      )
    }

    let delSongs = runtime.songsArea.songInfoArr.filter(
      (item) => runtime.songsArea.selectedSongFilePath.indexOf(item.filePath) !== -1
    )
    for (let item of delSongs) {
      if (item.coverUrl) {
        URL.revokeObjectURL(item.coverUrl)
      }
    }
    runtime.songsArea.songInfoArr = runtime.songsArea.songInfoArr.filter(
      (item) => runtime.songsArea.selectedSongFilePath.indexOf(item.filePath) === -1
    )
    runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    if (
      runtime.playingData.playingSong &&
      runtime.songsArea.selectedSongFilePath.indexOf(runtime.playingData.playingSong.filePath) !==
        -1
    ) {
      runtime.playingData.playingSong = null
    }
    runtime.songsArea.selectedSongFilePath.length = 0
  }
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
    if (runtime.songsArea.selectedSongFilePath.length === 0) {
      return false
    }
    deleteSong()
    return false
  })
})
const onStart = () => {
  runtime.dragTableHeader = true
}
const onEnd = () => {
  runtime.dragTableHeader = false
}

type VDraggableBinding = [list: Ref<any[]>, options?: UseDraggableOptions<any>]
let vDraggableData: VDraggableBinding = [
  columnData,
  {
    animation: 150,
    direction: 'horizontal',
    onUpdate,
    onStart,
    onEnd
  }
]
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
  if (isResizeClick) {
    return
  }
  if (col.key === 'coverUrl' || col.key === 'index') {
    return
  }

  for (let item of columnData.value) {
    if (item.key !== col.key) {
      item.order = undefined
    }
  }
  col.order = col.order === 'asc' ? 'desc' : 'asc'
  onUpdate()

  // 排序并更新响应式数组
  runtime.songsArea.songInfoArr = sortArrayByProperty<ISongInfo>(
    runtime.songsArea.songInfoArr, // 对当前数组排序
    col.key as keyof ISongInfo,
    col.order
  )
  // 更新播放列表数据引用（如果需要）
  if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
    runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
  }

  // --- 如果封面尚未完全加载，则取消旧任务并启动新的封面加载任务 ---
  if (!coversLoadCompleted.value) {
    coverLoadTaskId.value++ // 增加任务 ID，使旧任务（如果有）失效
    // 重置完成状态，因为我们启动了新任务
    coversLoadCompleted.value = false
    // 传递当前的 taskId 和更新后的数组引用，并设置完成回调
    processCoversInBatchesRAF(runtime.songsArea.songInfoArr, coverLoadTaskId.value).then(
      (completed) => {
        if (completed) {
          coversLoadCompleted.value = true
        }
      }
    )
  } else {
    // 无需操作，因为封面已经加载完毕
  }
}

//todo 拖拽文件出窗口
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
      <div
        @contextmenu.stop="contextmenuEvent"
        class="songItem lightBackground"
        style="
          position: sticky;
          top: 0;
          z-index: 10;
          background-color: #191919;
          border-bottom: 1px solid #2b2b2b;
        "
        v-draggable="vDraggableData"
      >
        <div
          class="coverDiv lightBackground unselectable"
          v-for="col of columnDataArr"
          :key="col.key"
          :class="{ coverDiv: col.key == 'coverUrl', titleDiv: col.key != 'coverUrl' }"
          :style="'width:' + col.width + 'px'"
          style="padding-left: 10px; box-sizing: border-box; display: flex; align-items: center"
          @click="colMenuClick(col)"
        >
          <div style="flex-grow: 1; overflow: hidden">
            <div
              style="width: 0; white-space: nowrap; display: flex; align-items: center"
              :style="{ color: col.order ? '#0078d4' : '#cccccc' }"
            >
              {{ t(col.columnName)
              }}<img
                :src="ascendingOrder"
                style="width: 20px; height: 20px"
                v-show="col.order === 'asc'"
              /><img
                :src="descendingOrder"
                style="width: 20px; height: 20px"
                v-show="col.order === 'desc'"
              />
            </div>
          </div>
          <div
            v-if="col.key !== 'coverUrl'"
            style="width: 5px; cursor: e-resize; flex-shrink: 0; height: 100%"
            @mousedown="startResize($event, col)"
          ></div>
        </div>
      </div>

      <!-- Scrollable Content -->
      <div v-show="runtime.songsArea.songInfoArr.length != 0">
        <div
          v-for="(item, index) of runtime.songsArea.songInfoArr"
          :key="item.filePath"
          class="songItem unselectable"
          @click.stop="songClick($event, item)"
          @contextmenu.stop="songContextmenu($event, item)"
          @dblclick.stop="songDblClick(item)"
        >
          <div
            :class="{
              lightBackground:
                index % 2 === 1 &&
                runtime.songsArea.selectedSongFilePath.indexOf(item.filePath) === -1,
              darkBackground:
                index % 2 === 0 &&
                runtime.songsArea.selectedSongFilePath.indexOf(item.filePath) === -1,
              selectedSong: runtime.songsArea.selectedSongFilePath.indexOf(item.filePath) !== -1,
              playingSong: item.filePath === runtime.playingData.playingSong?.filePath
            }"
            style="display: flex"
          >
            <template v-for="col of columnDataArr" :key="col.key">
              <template v-if="col.show">
                <div
                  v-if="col.key == 'coverUrl'"
                  class="coverDiv"
                  style="overflow: hidden"
                  :style="'width:' + col.width + 'px'"
                >
                  <img
                    v-if="item.coverUrl"
                    :src="item.coverUrl"
                    class="unselectable"
                    draggable="false"
                  />
                  <div v-else class="cover-placeholder"></div>
                </div>
                <div
                  v-else-if="col.key == 'index'"
                  class="titleDiv"
                  :style="'width:' + col.width + 'px'"
                >
                  {{ index + 1 }}
                </div>
                <div v-else class="titleDiv" :style="'width:' + col.width + 'px'">
                  {{ item[col.key as keyof ISongInfo] }}
                </div>
              </template>
            </template>
          </div>
        </div>
      </div>
      <!-- Empty State (现在也在滚动容器内) -->
      <div
        v-show="
          !isRequesting &&
          runtime.songsArea.songListUUID &&
          runtime.songsArea.songInfoArr.length === 0
        "
        style="
          /* 可能需要调整空状态样式，因为它现在在滚动区内 */
          min-height: 200px;
          width: 100%;
          display: flex;
          justify-content: center;
          align-items: center;
          flex-direction: column;
          /* 考虑是否需要绝对定位或特定内边距来使其居中 */
          position: absolute; /* 让它脱离文档流，尝试居中 */
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
        "
      >
        <div style="font-size: 16px; color: #999999" class="unselectable">
          {{ t('暂无曲目') }}
        </div>
        <div style="font-size: 12px; color: #999999; margin-top: 10px" class="unselectable">
          {{ t('导入曲目到歌单中，或通过拖拽文件夹或音频文件进行导入。') }}
        </div>
      </div>
    </OverlayScrollbarsComponent>

    <songAreaColRightClickMenu
      v-model="colRightClickMenuShow"
      :clickPosition="colRightClickEvent"
      :columnData="columnData"
      @colMenuHandleClick="colMenuHandleClick"
    />
    <Teleport to="body">
      <selectSongListDialog
        v-if="selectSongListDialogShow"
        :libraryName="selectSongListDialogLibraryName"
        @confirm="selectSongListDialogConfirm"
        @cancel="
          () => {
            selectSongListDialogShow = false
          }
        "
      />
    </Teleport>
  </div>
</template>
<style lang="scss" scoped>
.selectedSong {
  background-color: #37373d;
}

.playingSong {
  color: #0078d4 !important;
  font-weight: bold;
}

.coverDiv {
  height: 30px;
  /* 统一高度 */
  box-sizing: border-box;
  /* 统一盒模型 */
  border-right: 1px solid #2b2b2b;
  /* 确保右边框 */
  border-bottom: 1px solid #2b2b2b;
  /* 数据单元格需要底部边框 */
  /* 注意：这里不添加 padding-left，让图片填充 */

  img {
    width: 100%;
    height: 100%;
    /* 让图片填充高度 */
    object-fit: cover;
    /* 控制图片缩放方式 */
    display: block;
    /* 移除图片下方可能的空隙 */
  }

  .cover-placeholder {
    width: 100%;
    height: 100%;
  }
}

.titleDiv {
  height: 30px;
  /* 统一高度 */
  padding-left: 10px;
  /* 保留内边距 */
  box-sizing: border-box;
  /* 统一盒模型 */
  border-right: 1px solid #2b2b2b;
  /* 确保右边框 */
  border-bottom: 1px solid #2b2b2b;
  /* 数据单元格需要底部边框 */
  white-space: nowrap;
  overflow: hidden;
  display: flex;
  /* 使用 flex 垂直居中文本 */
  align-items: center;
  /* 使用 flex 垂直居中文本 */
}

.songItem {
  width: 0;
  height: 30px;
  display: flex;
  font-size: 14px;

  div {
    flex-shrink: 0;
  }
}

.lightBackground {
  background-color: #191919;
}

.darkBackground {
  background-color: #000000;
}

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
</style>
