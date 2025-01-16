<script setup lang="ts">
import { watch, ref, nextTick, computed, onMounted, Ref, useTemplateRef } from 'vue'
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
const defaultColumns: ISongsAreaColumn[] = [
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
    if (!savedData) {
      return defaultColumns
    }

    const parsedData = JSON.parse(savedData)
    const hasOrder = parsedData.some((col: ISongsAreaColumn) => col.order !== undefined)

    if (hasOrder) {
      return parsedData
    }

    return parsedData.map((col: ISongsAreaColumn) =>
      col.key === 'artist' ? { ...col, order: 'asc' } : col
    )
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

    // 处理歌曲封面
    scanData.forEach((item: ISongInfo) => {
      if (item.cover) {
        const blob = new Blob([Uint8Array.from(item.cover.data)], { type: item.cover.format })
        item.coverUrl = URL.createObjectURL(blob)
      }
    })

    // 根据排序规则处理数据
    const sortedCol = columnData.value.find((col) => col.order)
    if (sortedCol) {
      runtime.songsArea.songInfoArr = sortArrayByProperty<ISongInfo>(
        scanData,
        sortedCol.key as keyof ISongInfo,
        sortedCol.order
      )

      if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
        runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
      }
    }
  } finally {
    isRequesting.value = false
    clearTimeout(loadingSetTimeout)
    loadingShow.value = false
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
const colRightClickEvent = ref({})
const contextmenuEvent = (event: MouseEvent) => {
  colRightClickEvent.value = event
  colRightClickMenuShow.value = true
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
  [{ menuName: '删除曲目', shortcutKey: 'Delete' }, { menuName: '删除上方所有曲目' }]
])

const songsAreaRef = useTemplateRef('songsAreaRef')
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
      let res = await confirm({
        title: '删除',
        content: [
          t('确定删除此曲目上方的所有曲目吗'),
          t('（曲目将在磁盘上被删除，但声音指纹依然会保留）')
        ]
      })
      if (res === 'confirm') {
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
        window.electron.ipcRenderer.send('delSongs', JSON.parse(JSON.stringify(delSongs)))
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
        songsAreaRef.value?.scrollTo({
          top: 0,
          behavior: 'smooth'
        })
      }
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
  let res = await confirm({
    title: '删除',
    content: [t('确定删除选中的曲目吗'), t('（曲目将在磁盘上被删除，但声音指纹依然会保留）')]
  })
  if (res === 'confirm') {
    window.electron.ipcRenderer.send(
      'delSongs',
      JSON.parse(JSON.stringify(runtime.songsArea.selectedSongFilePath))
    )
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
  if (col.key === 'coverUrl') {
    return
  }

  for (let item of columnData.value) {
    if (item.key !== col.key) {
      item.order = undefined
    }
  }
  col.order = col.order === 'asc' ? 'desc' : 'asc'
  onUpdate()
  runtime.songsArea.songInfoArr = sortArrayByProperty<ISongInfo>(
    runtime.songsArea.songInfoArr,
    col.key as keyof ISongInfo,
    col.order
  )
  if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
    runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
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
    <div
      ref="songsAreaRef"
      style="height: 100%; width: 100%; overflow: auto"
      v-if="runtime.songsArea.songListUUID && !loadingShow"
      @click="runtime.songsArea.selectedSongFilePath.length = 0"
    >
      <div
        @contextmenu.stop="contextmenuEvent"
        class="songItem lightBackground"
        style="position: sticky; top: 0"
        v-draggable="vDraggableData"
      >
        <div
          class="coverDiv lightBackground unselectable"
          v-for="col of columnDataArr"
          :key="col.key"
          :class="{ coverDiv: col.key == 'coverUrl', titleDiv: col.key != 'coverUrl' }"
          :style="'width:' + col.width + 'px'"
          style="
            border-right: 1px solid #000000;
            padding-left: 10px;
            box-sizing: border-box;
            display: flex;
          "
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
            style="width: 5px; cursor: e-resize"
            @mousedown="startResize($event, col)"
          ></div>
        </div>
      </div>
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
                  <img :src="item.coverUrl" class="unselectable" />
                </div>
                <div v-else class="titleDiv" :style="'width:' + col.width + 'px'">
                  {{ item[col.key as keyof ISongInfo] }}
                </div>
              </template>
            </template>
          </div>
        </div>
      </div>
      <div
        v-show="
          !isRequesting &&
          runtime.songsArea.songListUUID &&
          runtime.songsArea.songInfoArr.length === 0
        "
        style="
          height: 80%;
          width: 100%;
          display: flex;
          justify-content: center;
          align-items: center;
          flex-direction: column;
          position: sticky;
          left: 0;
        "
      >
        <div style="font-size: 16px; color: #999999" class="unselectable">{{ t('暂无曲目') }}</div>
        <div style="font-size: 12px; color: #999999; margin-top: 10px" class="unselectable">
          {{ t('导入曲目到歌单中，或通过拖拽文件夹或音频文件进行导入。') }}
        </div>
      </div>
    </div>

    <songAreaColRightClickMenu
      v-model="colRightClickMenuShow"
      :clickEvent="colRightClickEvent"
      :columnData="columnData"
      @colMenuHandleClick="colMenuHandleClick"
    />
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
  height: 29px;
  line-height: 30px;
  border-right: 1px solid #2b2b2b;
  border-bottom: 1px solid #2b2b2b;

  img {
    width: 100%;
  }
}

.titleDiv {
  height: 30px;
  line-height: 30px;
  padding-left: 10px;
  box-sizing: border-box;
  border-right: 1px solid #2b2b2b;
  white-space: nowrap;
  overflow: hidden;
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
