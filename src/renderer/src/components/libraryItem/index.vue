<script setup lang="ts">
import { ref, nextTick, watch, useTemplateRef, computed, onMounted } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import libraryItem from '@renderer/components/libraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import listIcon from '@renderer/assets/listIcon.png?asset'
import listIconBlue from '@renderer/assets/listIconBlue.png?asset'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import scanNewSongDialog from '@renderer/components/scanNewSongDialog'
import exportDialog from '@renderer/components/exportDialog'
import { t } from '@renderer/utils/translate'
import emitter from '../../utils/mitt'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import {
  handleDragStart,
  handleDragOver,
  handleDragEnter,
  handleDragLeave,
  handleDrop,
  type DragState
} from '../../utils/dragUtils'
import { reactive } from 'vue'
import { useDragSongs } from '@renderer/pages/modules/songsArea/composables/useDragSongs'
import { analyzeFingerprintsForPaths } from '@renderer/utils/fingerprintActions'
import { invokeMetadataAutoFill } from '@renderer/utils/metadataAutoFill'
import type { IMetadataAutoFillSummary } from '../../../../types/globals'
const props = defineProps({
  uuid: {
    type: String,
    required: true
  },
  libraryName: {
    type: String,
    required: true
  },
  // 歌单筛选关键词（仅匹配歌单名）
  filterText: {
    type: [String, Object],
    default: ''
  }
})
const runtime = useRuntimeStore()
const hasAcoustIdKey = computed(() => {
  const key = (runtime.setting?.acoustIdClientKey || '').trim()
  return key.length > 0
})
const hasWarnedAcoustId = ref(false)
const warnAcoustIdMissing = () => {
  if (hasAcoustIdKey.value || hasWarnedAcoustId.value) return
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
const { handleDropToSongList } = useDragSongs()

let dirData = libraryUtils.getLibraryTreeByUUID(props.uuid)

if (dirData === null) {
  throw new Error(`dirData error: ${JSON.stringify(dirData)}`)
}
let fatherDirData = libraryUtils.getFatherLibraryTreeByUUID(props.uuid)

if (fatherDirData === null) {
  throw new Error(`fatherDirData error: ${JSON.stringify(fatherDirData)}`)
}
const myInputHandleInput = () => {
  const newName = operationInputValue.value
  const invalidCharsRegex = /[<>:"/\\|?*\u0000-\u001F]/
  let hintShouldShow = false
  let hintText = ''

  if (newName === '') {
    hintText = t('library.nameRequired')
    hintShouldShow = true
  } else if (invalidCharsRegex.test(newName)) {
    hintText = t('library.nameInvalidChars')
    hintShouldShow = true
  } else {
    const exists = fatherDirData.children?.some((obj) => obj.dirName === newName)
    if (exists) {
      hintText = t('library.nameAlreadyExists', { name: newName })
      hintShouldShow = true
    }
  }

  inputHintText.value = hintText
  inputHintShow.value = hintShouldShow
}

const inputKeyDownEnter = () => {
  if (inputHintShow.value || operationInputValue.value === '') {
    if (!inputHintShow.value) {
      inputHintText.value = t('library.nameRequired')
      inputHintShow.value = true
    }
    return
  }
  myInput.value?.blur()
}

const inputKeyDownEsc = () => {
  operationInputValue.value = ''
  inputHintShow.value = false
  inputBlurHandle()
}

const inputHintText = ref('')
const inputBlurHandle = async () => {
  if (fatherDirData.children === undefined) {
    throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
  }
  if (inputHintShow.value || operationInputValue.value === '') {
    if (dirData.dirName === '') {
      if (fatherDirData.children[0]?.dirName === '') {
        fatherDirData.children.shift()
      }
    }
    operationInputValue.value = ''
    inputHintShow.value = false
    return
  }
  for (let item of fatherDirData.children) {
    if (item.order) {
      item.order++
    }
  }
  dirData.dirName = operationInputValue.value
  dirData.order = 1
  dirData.children = []
  operationInputValue.value = ''
  // 从开始写盘到完成期间，展示“创建中”动效
  if (dirData.type === 'songList') {
    runtime.creatingSongListUUID = dirData.uuid
  }
  await libraryUtils.diffLibraryTreeExecuteFileOperation()
  // 命名完成并写盘成功后，再进入该歌单（仅当新建的是歌单而非文件夹）
  if (dirData.type === 'songList') {
    runtime.songsArea.songListUUID = dirData.uuid
  }
  // 清除创建中标记
  if (runtime.creatingSongListUUID === dirData.uuid) {
    runtime.creatingSongListUUID = ''
  }
}
let operationInputValue = ref('')

const inputHintShow = ref(false)

const myInput = useTemplateRef('myInput')
if (dirData.dirName === '') {
  nextTick(() => {
    myInput.value?.focus()
  })
}

const rightClickMenuShow = ref(false)
const menuArr = ref(
  dirData.type === 'dir'
    ? [
        [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }],
        [{ menuName: 'common.rename' }, { menuName: 'common.delete' }]
      ]
    : [
        [{ menuName: 'tracks.importTracks' }, { menuName: 'tracks.exportTracks' }],
        [
          { menuName: 'common.rename' },
          { menuName: 'playlist.deletePlaylist' },
          { menuName: 'playlist.emptyPlaylist' }
        ],
        [{ menuName: 'tracks.showInFileExplorer' }],
        [{ menuName: 'playlist.fingerprintDeduplicate' }],
        [{ menuName: 'metadata.autoFillMenu' }],
        [{ menuName: 'tracks.convertFormat' }],
        [{ menuName: 'fingerprints.analyzeAndAdd' }]
      ]
)
const deleteDir = async () => {
  let libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
  if (libraryTree === null) {
    throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
  }
  let uuids = libraryUtils.getAllUuids(libraryTree)

  if (uuids.indexOf(runtime.songsArea.songListUUID) !== -1) {
    runtime.songsArea.songListUUID = ''
  }
  if (uuids.indexOf(runtime.playingData.playingSongListUUID) !== -1) {
    runtime.playingData.playingSongListUUID = ''
    runtime.playingData.playingSongListData = []
    runtime.playingData.playingSong = null
  }
  let deleteIndex
  if (fatherDirData.children === undefined) {
    throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
  }
  for (let index in fatherDirData.children) {
    if (fatherDirData.children[index] == dirData) {
      deleteIndex = index
      continue
    }
    if (fatherDirData.children[index].order && dirData.order) {
      if (fatherDirData.children[index].order > dirData.order) {
        fatherDirData.children[index].order--
      }
    }
  }
  fatherDirData.children.splice(Number(deleteIndex), 1)
  await libraryUtils.diffLibraryTreeExecuteFileOperation()
}
const contextmenuEvent = async (event: MouseEvent) => {
  let songListPath = libraryUtils.findDirPathByUuid(props.uuid)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    await confirm({
      title: t('common.error'),
      content: [t('library.notExistOnDisk')],
      confirmShow: false
    })
    deleteDir()
    return
  }
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    // 回收站中的歌单右键：显示在资源管理器中 + 分隔线 + 彻底删除
    menuArr.value = [
      [{ menuName: 'recycleBin.permanentlyDelete' }],
      [{ menuName: 'tracks.showInFileExplorer' }],
      [{ menuName: 'tracks.convertFormat' }]
    ]
  } else {
    // 非回收站：恢复默认菜单，避免受上次覆盖影响
    menuArr.value =
      dirData.type === 'dir'
        ? [
            [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }],
            [{ menuName: 'common.rename' }, { menuName: 'common.delete' }]
          ]
        : [
            [{ menuName: 'tracks.importTracks' }, { menuName: 'tracks.exportTracks' }],
            [
              { menuName: 'common.rename' },
              { menuName: 'playlist.deletePlaylist' },
              { menuName: 'playlist.emptyPlaylist' }
            ],
            [{ menuName: 'tracks.showInFileExplorer' }],
            [{ menuName: 'metadata.autoFillMenu' }],
            [{ menuName: 'playlist.clearCache' }],
            [{ menuName: 'playlist.fingerprintDeduplicate' }],
            [{ menuName: 'tracks.convertFormat' }],
            [{ menuName: 'fingerprints.analyzeAndAdd' }]
          ]
  }
  rightClickMenuShow.value = true
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  rightClickMenuShow.value = false
  if (result !== 'cancel') {
    if (result.menuName === 'library.createPlaylist') {
      dirChildRendered.value = true
      dirChildShow.value = true

      const newUuid = uuidV4()
      dirData.children?.unshift({
        uuid: newUuid,
        dirName: '',
        type: 'songList'
      })
      // 新建后自动进入该歌单（等效单击，不触发双击）
      runtime.songsArea.songListUUID = newUuid
    } else if (result.menuName === 'library.createFolder') {
      dirChildRendered.value = true
      dirChildShow.value = true

      dirData.children?.unshift({
        uuid: uuidV4(),
        dirName: '',
        type: 'dir'
      })
    } else if (result.menuName === 'common.rename') {
      renameDivShow.value = true
      renameDivValue.value = dirData.dirName
      await nextTick()
      myRenameInput.value?.focus()
    } else if (
      result.menuName === 'common.delete' ||
      result.menuName === 'playlist.deletePlaylist'
    ) {
      deleteDir()
    } else if (result.menuName === 'playlist.emptyPlaylist') {
      let dirPath = libraryUtils.findDirPathByUuid(props.uuid)
      await window.electron.ipcRenderer.invoke('emptyDir', dirPath, getCurrentTimeDirName())
      if (dirData.type === 'songList' && runtime.setting.showPlaylistTrackCount) {
        trackCount.value = 0
      }
      try {
        emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
      } catch {}
      if (runtime.songsArea.songListUUID === props.uuid) {
        // 清空播放相关数据
        runtime.playingData.playingSongListData = []
        runtime.playingData.playingSong = null

        // 清空歌曲列表界面数据
        runtime.songsArea.selectedSongFilePath.length = 0
        // 列表不再使用封面 URL
        runtime.songsArea.songInfoArr = []
        runtime.songsArea.totalSongCount = 0
      }
    } else if (result.menuName === 'tracks.importTracks') {
      if (runtime.isProgressing) {
        await confirm({
          title: t('dialog.hint'),
          content: [t('import.waitForTask')],
          confirmShow: false
        })
        return
      }
      await scanNewSongDialog({ libraryName: props.libraryName, songListUuid: props.uuid })
    } else if (result.menuName === 'tracks.exportTracks') {
      if (runtime.isProgressing) {
        await confirm({
          title: t('dialog.hint'),
          content: [t('import.waitForTask')],
          confirmShow: false
        })
        return
      }
      let result = await exportDialog({ title: 'tracks.title' })
      if (result !== 'cancel') {
        let folderPathVal = result.folderPathVal
        let deleteSongsAfterExport = result.deleteSongsAfterExport
        let dirPath = libraryUtils.findDirPathByUuid(props.uuid)
        await window.electron.ipcRenderer.invoke(
          'exportSongListToDir',
          folderPathVal,
          deleteSongsAfterExport,
          dirPath
        )
        if (deleteSongsAfterExport) {
          if (runtime.songsArea.songListUUID === props.uuid) {
            runtime.songsArea.songListUUID = ''
          }
          if (runtime.playingData.playingSongListUUID === props.uuid) {
            runtime.playingData.playingSongListUUID = ''
            runtime.playingData.playingSongListData = []
            runtime.playingData.playingSong = null
          }
        }
      }
    } else if (result.menuName === 'tracks.showInFileExplorer') {
      window.electron.ipcRenderer.send(
        'openFileExplorer',
        libraryUtils.findDirPathByUuid(props.uuid)
      )
    } else if (result.menuName === 'metadata.autoFillMenu') {
      const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
      const scan = await window.electron.ipcRenderer.invoke('scanSongList', dirPath, props.uuid)
      const files: string[] = Array.isArray(scan?.scanData)
        ? scan.scanData.map((s: any) => s.filePath).filter(Boolean)
        : []
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
      if (runtime.songsArea.songListUUID === props.uuid) {
        try {
          emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
        } catch {}
      }
    } else if (result.menuName === 'tracks.convertFormat') {
      try {
        const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
        const scan = await window.electron.ipcRenderer.invoke('scanSongList', dirPath, props.uuid)
        const files: string[] = Array.isArray(scan?.scanData)
          ? scan.scanData.map((s: any) => s.filePath).filter(Boolean)
          : []
        if (files.length === 0) return
        const sourceExts = Array.from(
          new Set(
            files
              .map((p) => (p || '').toLowerCase())
              .map((p) => p.match(/\.[^\\\/\.]+$/)?.[0] || '')
              .filter((e) => runtime.setting.audioExt.includes(e))
          )
        )
        const { default: openConvertDialog } = await import(
          '@renderer/components/audioConvertDialog'
        )
        const dialogResult: any = await openConvertDialog({ sourceExts })
        if (dialogResult && dialogResult !== 'cancel') {
          await window.electron.ipcRenderer.invoke('audio:convert:start', {
            files,
            options: dialogResult,
            songListUUID: props.uuid
          })
        }
      } catch {}
    } else if (result.menuName === 'fingerprints.analyzeAndAdd') {
      const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
      const scan = await window.electron.ipcRenderer.invoke('scanSongList', dirPath, props.uuid)
      const files: string[] = Array.isArray(scan?.scanData)
        ? scan.scanData.map((s: any) => s.filePath).filter(Boolean)
        : []
      if (!files.length) {
        await confirm({
          title: t('dialog.hint'),
          content: [t('fingerprints.noEligibleTracks')],
          confirmShow: false
        })
        return
      }
      await analyzeFingerprintsForPaths(files, { origin: 'playlist' })
    } else if (result.menuName === 'playlist.clearCache') {
      const dirPath = libraryUtils.findDirPathByUuid(props.uuid)
      await window.electron.ipcRenderer.invoke('playlist:cache:clear', dirPath || '')
      trackCount.value = null
      try {
        emitter.emit('playlistCacheCleared', { uuid: props.uuid })
      } catch {}
    } else if (result.menuName === 'playlist.fingerprintDeduplicate') {
      if (runtime.isProgressing) {
        await confirm({
          title: t('dialog.hint'),
          content: [t('import.waitForTask')],
          confirmShow: false
        })
        return
      }
      const confirmResult = await confirm({
        title: t('playlist.deduplicateConfirmTitle'),
        content: [t('playlist.deduplicateConfirm')]
      })
      if (confirmResult !== 'confirm') {
        return
      }

      runtime.isProgressing = true
      const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
      const progressId = `playlist_dedup_${Date.now()}`
      const normalizePath = (p: string | undefined | null) =>
        (p || '').replace(/\//g, '\\').toLowerCase()
      try {
        const summary: any = await window.electron.ipcRenderer.invoke(
          'deduplicateSongListByFingerprint',
          {
            songListPath,
            progressId
          }
        )
        const removedRaw: string[] = Array.isArray(summary?.removedFilePaths)
          ? summary.removedFilePaths.filter(Boolean)
          : []
        const removedNormalized = removedRaw.map((p) => normalizePath(p)).filter(Boolean)

        if (removedNormalized.length > 0) {
          emitter.emit('songsRemoved', { listUUID: props.uuid, paths: removedNormalized })
        }
        try {
          emitter.emit('playlistContentChanged', { uuids: [props.uuid] })
        } catch {}

        const modeLabel =
          summary?.fingerprintMode === 'file'
            ? t('fingerprints.modeFile')
            : t('fingerprints.modePCM')
        const feedbackLines = [
          t('playlist.deduplicateRemovedCount', { n: removedRaw.length }),
          t('playlist.deduplicateModeUsed', { mode: modeLabel })
        ]
        if (summary?.analyzeFailedCount) {
          feedbackLines.push(t('import.analysisFailedCount', { count: summary.analyzeFailedCount }))
        }
        if (summary?.scannedCount !== undefined) {
          feedbackLines.unshift(
            t('playlist.deduplicateScannedCount', { n: summary.scannedCount || 0 })
          )
        }
        await confirm({
          title: t('playlist.deduplicateFinished'),
          content: feedbackLines,
          confirmShow: false
        })
      } catch (error: any) {
        const message = error?.message ? String(error.message) : '发生未知错误'
        await confirm({
          title: t('common.error'),
          content: [message],
          confirmShow: false
        })
      } finally {
        runtime.isProgressing = false
      }
    } else if (result.menuName === 'recycleBin.permanentlyDelete') {
      let res = await confirm({
        title: t('common.delete'),
        content: [t('tracks.confirmDelete'), t('tracks.deleteHint')]
      })
      if (res === 'confirm') {
        const recycleBin = runtime.libraryTree.children?.find(
          (item) => item.dirName === 'RecycleBin'
        )
        const index = recycleBin?.children?.findIndex((item) => item.uuid === props.uuid)
        if (index !== undefined && index !== -1 && recycleBin?.children) {
          recycleBin.children.splice(index, 1)
        }
        if (runtime.playingData.playingSongListUUID === props.uuid) {
          runtime.playingData.playingSongListUUID = ''
          runtime.playingData.playingSongListData = []
          runtime.playingData.playingSong = null
        }
        if (runtime.songsArea.songListUUID === props.uuid) {
          runtime.songsArea.selectedSongFilePath.length = 0
          // 列表不再使用封面 URL
          runtime.songsArea.songInfoArr = []
          runtime.songsArea.totalSongCount = 0
        }
        await libraryUtils.diffLibraryTreeExecuteFileOperation()
      }
    }
  }
}

const dirChildShow = ref(false)
const dirChildRendered = ref(false)
const dirHandleClick = async () => {
  runtime.activeMenuUUID = ''
  let songListPath = libraryUtils.findDirPathByUuid(props.uuid)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    await confirm({
      title: t('common.error'),
      content: [t('library.notExistOnDisk')],
      confirmShow: false
    })
    deleteDir()
    return
  }
  if (dirData.type == 'songList') {
    if (runtime.songsArea.songListUUID === props.uuid) {
      runtime.songsArea.songListUUID = ''

      return
    }
    runtime.songsArea.songListUUID = props.uuid
  } else {
    dirChildRendered.value = true
    dirChildShow.value = !dirChildShow.value
  }
}

emitter.on('collapseButtonHandleClick', (libraryName: string) => {
  if (libraryName == props.libraryName) {
    dirChildShow.value = false
  }
})

//----重命名功能--------------------------------------
const renameDivShow = ref(false)
const renameDivValue = ref('')
const myRenameInput = useTemplateRef('myRenameInput')
const renameInputHintShow = ref(false)
const renameInputHintText = ref('')
const renameInputBlurHandle = async () => {
  if (
    renameInputHintShow.value ||
    renameDivValue.value == '' ||
    renameDivValue.value == dirData.dirName
  ) {
    renameDivValue.value = ''
    renameDivShow.value = false
    return
  }
  if (dirData.uuid === runtime.songsArea.songListUUID) {
    for (let item of runtime.songsArea.songInfoArr) {
      let arr = item.filePath.split('\\')
      arr[arr.length - 2] = renameDivValue.value
      item.filePath = arr.join('\\')
    }
    for (let index in runtime.songsArea.selectedSongFilePath) {
      let arr = runtime.songsArea.selectedSongFilePath[index].split('\\')
      arr[arr.length - 2] = renameDivValue.value
      runtime.songsArea.selectedSongFilePath[index] = arr.join('\\')
    }
  }
  if (dirData.uuid === runtime.playingData.playingSongListUUID && runtime.playingData.playingSong) {
    let arr = runtime.playingData.playingSong.filePath.split('\\')
    arr[arr.length - 2] = renameDivValue.value
    runtime.playingData.playingSong.filePath = arr.join('\\')
    for (let item of runtime.playingData.playingSongListData) {
      let arr = item.filePath.split('\\')
      arr[arr.length - 2] = renameDivValue.value
      item.filePath = arr.join('\\')
    }
  }
  dirData.dirName = renameDivValue.value
  renameDivValue.value = ''
  renameDivShow.value = false
  await libraryUtils.diffLibraryTreeExecuteFileOperation()
}
const renameInputKeyDownEnter = () => {
  if (renameDivValue.value == '') {
    renameInputHintText.value = t('library.nameRequired')
    renameInputHintShow.value = true
    return
  }
  if (renameInputHintShow.value) {
    return
  }
  myRenameInput.value?.blur()
}
const renameInputKeyDownEsc = () => {
  renameDivValue.value = ''
  renameInputBlurHandle()
}
const renameMyInputHandleInput = () => {
  const newName = renameDivValue.value
  const invalidCharsRegex = /[<>:"/\\|?*\u0000-\u001F]/
  let hintShouldShow = false
  let hintText = ''

  if (newName === '') {
    hintText = t('library.nameRequired')
    hintShouldShow = true
  } else if (invalidCharsRegex.test(newName)) {
    hintText = t('library.nameInvalidChars')
    hintShouldShow = true
  } else {
    const exists = fatherDirData.children?.some(
      (obj) => obj.dirName === newName && obj.uuid !== props.uuid
    )
    if (exists) {
      hintText = t('library.nameAlreadyExists', { name: newName })
      hintShouldShow = true
    }
  }

  renameInputHintText.value = hintText
  renameInputHintShow.value = hintShouldShow
}

// 监听全局重命名触发（仅当自己是当前选中项时）
emitter.on('libraryArea/trigger-rename', async (targetUuid: string) => {
  try {
    if (targetUuid !== props.uuid) return
    // 仅歌单/文件夹可重命名，且需要已有名称（避免与“新建未命名”冲突）
    if (!dirData?.dirName) return
    renameDivShow.value = true
    renameDivValue.value = dirData.dirName
    await nextTick()
    myRenameInput.value?.focus()
  } catch {}
})

//----------------------------------------

const dragApproach = ref('')
const dragState = reactive<DragState>({
  dragApproach: ''
})

watch(
  () => dragState.dragApproach,
  (newVal) => {
    dragApproach.value = newVal
  }
)

const dragstart = async (event: DragEvent) => {
  const shouldDelete = await handleDragStart(event, props.uuid)
  if (shouldDelete) {
    deleteDir()
  }
  event.target?.addEventListener(
    'dragend',
    () => {
      runtime.dragItemData = null
    },
    { once: true }
  )
}

const dragover = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'none'
    }
    return
  }

  // 检查是否是歌曲拖拽
  const isSongDrag = e.dataTransfer?.types?.includes('application/x-song-drag')

  // 如果是歌曲拖拽且目标是歌单，显示拖拽反馈
  if (isSongDrag && dirData.type === 'songList') {
    // 检查目标歌单是否在回收站中
    const isInRecycleBin = runtime.libraryTree.children
      ?.find((item) => item.dirName === 'RecycleBin')
      ?.children?.some((child) => child.uuid === props.uuid)

    if (isInRecycleBin) {
      // 如果目标歌单在回收站中，不允许拖拽
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      return
    }

    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move'
    }
    dragState.dragApproach = 'center'
    return
  }

  handleDragOver(e, dirData, dragState)
}

const dragenter = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'none'
    }
    return
  }

  // 检查是否是歌曲拖拽
  const isSongDrag = e.dataTransfer?.types?.includes('application/x-song-drag')

  // 如果是歌曲拖拽且目标是歌单，显示拖拽反馈
  if (isSongDrag && dirData.type === 'songList') {
    // 检查目标歌单是否在回收站中
    const isInRecycleBin = runtime.libraryTree.children
      ?.find((item) => item.dirName === 'RecycleBin')
      ?.children?.some((child) => child.uuid === props.uuid)

    if (isInRecycleBin) {
      // 如果目标歌单在回收站中，不允许拖拽
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none'
      }
      return
    }

    e.preventDefault()
    dragState.dragApproach = 'center'
    return
  }

  handleDragEnter(e, dirData, dragState)
}

const dragleave = () => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    return
  }
  handleDragLeave(dragState)
}

const drop = async (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    return
  }

  // 检查是否是歌曲拖拽
  const isSongDrag = e.dataTransfer?.types?.includes('application/x-song-drag')

  if (isSongDrag && dirData.type === 'songList') {
    // 检查目标歌单是否在回收站中
    const isInRecycleBin = runtime.libraryTree.children
      ?.find((item) => item.dirName === 'RecycleBin')
      ?.children?.some((child) => child.uuid === props.uuid)

    if (isInRecycleBin) {
      // 如果目标歌单在回收站中，不允许拖拽，直接返回
      dragState.dragApproach = ''
      return
    }

    e.preventDefault()
    const movedSongPaths = await handleDropToSongList(props.uuid, runtime.libraryAreaSelected)
    dragState.dragApproach = ''

    // 如果有歌曲被移动，发送消息给 songsArea 更新数据
    if (movedSongPaths.length > 0) {
      // 通过 mitt 发送事件
      emitter.emit('songsMovedByDrag', movedSongPaths)
    }
    return
  }

  // 处理原有的目录/歌单拖拽逻辑
  const shouldDelete = await handleDrop(e, dirData, dragState, fatherDirData)
  if (shouldDelete) {
    deleteDir()
  }
}

const indentWidth = ref(0)
let depth = libraryUtils.getDepthByUuid(props.uuid)
if (depth === undefined) {
  throw new Error(`depth error: ${JSON.stringify(depth)}`)
}
indentWidth.value = (depth - 2) * 10

let isPlaying = ref(false)
watch(
  () => runtime.playingData.playingSongListUUID,
  () => {
    if (!runtime.playingData.playingSongListUUID) {
      isPlaying.value = false
      return
    }
    let libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
    if (libraryTree === null) {
      throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
    }
    let uuids = libraryUtils.getAllUuids(libraryTree)
    if (uuids.indexOf(runtime.playingData.playingSongListUUID) != -1) {
      isPlaying.value = true
    } else {
      isPlaying.value = false
    }
  }
)

// 歌单曲目数量缓存（避免每次渲染都请求）
const trackCount = ref<number | null>(null)
let fetchingCount = false
async function ensureTrackCount() {
  if (!runtime.setting.showPlaylistTrackCount) return
  if (fetchingCount) return
  if (!dirData || dirData.type !== 'songList') return
  try {
    fetchingCount = true
    const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
    const count = await window.electron.ipcRenderer.invoke('getSongListTrackCount', songListPath)
    trackCount.value = typeof count === 'number' ? count : 0
  } catch {
    trackCount.value = 0
  } finally {
    fetchingCount = false
  }
}

onMounted(() => {
  ensureTrackCount()
})

// 200ms 去抖 + 去重刷新
let debounceTimer: any = null
const pendingSet = new Set<string>()
emitter.on('playlistContentChanged', (payload: any) => {
  try {
    const uuids: string[] = (payload?.uuids || []).filter(Boolean)
    for (const u of uuids) pendingSet.add(u)
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (pendingSet.has(props.uuid)) {
        // 若当前歌单正打开，优先用内存长度
        if (runtime.songsArea.songListUUID === props.uuid) {
          trackCount.value = runtime.songsArea.totalSongCount
        } else {
          ensureTrackCount()
        }
      }
      pendingSet.clear()
    }, 200)
  } catch {}
})

watch(
  () => [runtime.setting.showPlaylistTrackCount, dirData?.dirName],
  () => {
    if (runtime.setting.showPlaylistTrackCount) ensureTrackCount()
  }
)

const displayDirName = computed(() => {
  const d = dirData
  if (!d) return ''
  if (runtime.libraryAreaSelected === 'RecycleBin' && d.dirName) {
    // 支持分钟格式（无秒）与历史秒级格式
    const matchMinute = d.dirName.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})$/)
    if (matchMinute) {
      return `${matchMinute[1]}-${matchMinute[2]}-${matchMinute[3]} ${matchMinute[4]}:${matchMinute[5]}`
    }
    const matchSecond = d.dirName.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/)
    if (matchSecond) {
      return `${matchSecond[1]}-${matchSecond[2]}-${matchSecond[3]} ${matchSecond[4]}:${matchSecond[5]}:${matchSecond[6]}`
    }
  }
  if (
    d.type === 'songList' &&
    runtime.setting.showPlaylistTrackCount &&
    trackCount.value !== null
  ) {
    return d.dirName
  }
  return d.dirName
})

// 供模板使用的名称（不带数量）
const nameForDisplay = computed(() => displayDirName.value)

// --- 筛选：仅歌单名匹配 + 自动展开包含匹配歌单的文件夹 ---
const keyword = computed(() =>
  String((props as any).filterText || '')
    .trim()
    .toLowerCase()
)
const matchesSelf = computed(() => {
  if (!keyword.value) return true
  return dirData?.type === 'songList' && dirData?.dirName?.toLowerCase().includes(keyword.value)
})
function hasMatchingDescendant(node?: any): boolean {
  if (!keyword.value) return true
  if (!node?.children) return false
  for (const c of node.children) {
    if (c.type === 'songList' && c.dirName?.toLowerCase().includes(keyword.value)) return true
    if (c.type === 'dir' && hasMatchingDescendant(c)) return true
  }
  return false
}
const shouldShow = computed(() => {
  if (!keyword.value) return true
  return matchesSelf.value || hasMatchingDescendant(dirData)
})
watch(keyword, () => {
  if (!keyword.value) return
  if (dirData?.type === 'dir' && hasMatchingDescendant(dirData)) {
    dirChildRendered.value = true
    dirChildShow.value = true
  }
})
</script>
<template>
  <div
    class="mainBody"
    style="display: flex; box-sizing: border-box"
    :style="'padding-left:' + indentWidth + 'px'"
    @contextmenu.stop="contextmenuEvent"
    @click.stop="dirHandleClick()"
    @dragover.stop.prevent="dragover"
    @dragstart.stop="dragstart"
    @dragenter.stop.prevent="dragenter"
    @drop.stop.prevent="drop"
    @dragleave.stop="dragleave"
    v-show="shouldShow"
    :draggable="
      dirData.dirName && !renameDivShow && runtime.libraryAreaSelected !== 'RecycleBin'
        ? true
        : false
    "
    :class="{
      rightClickBorder: rightClickMenuShow,
      borderTop: dragApproach == 'top',
      borderBottom: dragApproach == 'bottom',
      borderCenter: dragApproach == 'center',
      selectedDir: props.uuid == runtime.songsArea.songListUUID
    }"
  >
    <div class="prefixIcon" :class="{ isPlaying: isPlaying }">
      <svg
        v-if="dirData.type == 'dir'"
        v-show="!dirChildShow"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          clip-rule="evenodd"
          d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z"
        />
      </svg>
      <svg
        v-if="dirData.type == 'dir'"
        v-show="dirChildShow"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          clip-rule="evenodd"
          d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"
        />
      </svg>
      <img
        v-if="
          dirData.type == 'songList' &&
          runtime.importingSongListUUID != props.uuid &&
          runtime.creatingSongListUUID !== props.uuid
        "
        style="width: 13px; height: 13px"
        :src="isPlaying ? listIconBlue : listIcon"
        :class="!isPlaying ? 'songlist-icon' : ''"
      />
      <div
        v-if="dirData.type == 'songList' && runtime.creatingSongListUUID === props.uuid"
        class="loading"
        :class="{ isPlayingLoading: isPlaying }"
      ></div>
      <div
        v-if="dirData.type == 'songList' && runtime.importingSongListUUID == props.uuid"
        class="loading"
        :class="{ isPlayingLoading: isPlaying }"
      ></div>
    </div>
    <div style="height: 23px; width: calc(100% - 20px)">
      <div
        v-if="dirData.dirName && !renameDivShow"
        class="nameRow"
        :class="{ isPlaying: isPlaying }"
      >
        <span class="nameText">{{ nameForDisplay }}</span>
        <span
          v-if="
            dirData.type === 'songList' &&
            runtime.setting.showPlaylistTrackCount &&
            trackCount !== null
          "
          class="countBadge"
          :class="{ isPlaying: isPlaying }"
          :title="t('tracks.title')"
          >{{ trackCount }}</span
        >
      </div>
      <div v-if="!dirData.dirName">
        <input
          ref="myInput"
          v-model="operationInputValue"
          class="myInput"
          :class="{ myInputRedBorder: inputHintShow }"
          @blur="inputBlurHandle"
          @keydown.enter="inputKeyDownEnter"
          @keydown.esc="inputKeyDownEsc"
          @click.stop="() => {}"
          @contextmenu.stop="() => {}"
          @input="myInputHandleInput"
        />
        <div v-show="inputHintShow" class="myInputHint">
          <div>{{ inputHintText }}</div>
        </div>
      </div>
      <div v-if="renameDivShow">
        <input
          ref="myRenameInput"
          v-model="renameDivValue"
          class="myInput"
          :class="{ myInputRedBorder: renameInputHintShow }"
          @blur="renameInputBlurHandle"
          @keydown.enter="renameInputKeyDownEnter"
          @keydown.esc="renameInputKeyDownEsc"
          @click.stop="() => {}"
          @contextmenu.stop="() => {}"
          @input="renameMyInputHandleInput"
        />
        <div v-show="renameInputHintShow" class="myInputHint">
          <div>{{ renameInputHintText }}</div>
        </div>
      </div>
    </div>
  </div>
  <div
    v-if="dirData.type == 'dir' && dirChildRendered"
    v-show="dirChildShow"
    style="width: 100%; box-sizing: border-box"
  >
    <template v-for="item of dirData.children" :key="item.uuid">
      <libraryItem
        :uuid="item.uuid"
        :libraryName="props.libraryName"
        :filterText="(props as any).filterText"
      />
    </template>
  </div>
</template>
<style lang="scss" scoped>
.nameRow {
  line-height: 23px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 8px; // 右侧留白，避免贴边
  position: relative; // 让徽标绝对定位不受省略号影响
}

.nameText {
  flex: 1 1 auto;
  min-width: 0;
  padding-right: 48px; // 为绝对定位的徽标预留空间
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

.isPlaying.countBadge {
  background-color: var(--accent);
  color: #ffffff !important;
}
.isPlaying {
  color: var(--accent) !important;
}

.isPlayingLoading {
  border: 2px solid var(--accent) !important;
}

.loading {
  width: 8px;
  height: 8px;
  border: 2px solid var(--text);
  border-top-color: transparent;
  border-radius: 100%;
  animation: circle infinite 0.75s linear;
}

// 转转转动画
@keyframes circle {
  0% {
    transform: rotate(0);
  }

  100% {
    transform: rotate(360deg);
  }
}

.selectedDir {
  background-color: var(--hover);

  &:hover {
    background-color: var(--hover) !important;
  }
}

.mainBody {
  &:hover {
    background-color: var(--hover);
  }
}

.borderTop {
  box-shadow: inset 0 1px 0 0 var(--accent);
}

.borderBottom {
  box-shadow: inset 0 -1px 0 0 var(--accent);
}

.borderCenter {
  box-shadow: inset 0 0 0 1px var(--accent);
}

.rightClickBorder {
  box-shadow: inset 0 0 0 1px var(--accent);
}

.myInput {
  width: calc(100% - 6px);
  height: 19px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
}

.myInputRedBorder {
  border: 1px solid #be1100;
}

.myInputHint {
  div {
    width: calc(100% - 7px);
    min-height: 25px;
    line-height: 25px;
    background-color: #5a1d1d;
    border-right: 1px solid #be1100;
    border-left: 1px solid #be1100;
    border-bottom: 1px solid #be1100;
    color: #ffffff;
    font-size: 12px;
    padding-left: 5px;
    position: relative;
    z-index: 100;
  }
}

.prefixIcon {
  color: var(--text);
  width: 20px;
  min-width: 20px;
  height: 23px;
  display: flex;
  justify-content: center;
  align-items: center;
}
</style>
