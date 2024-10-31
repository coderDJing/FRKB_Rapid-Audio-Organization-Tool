<script setup lang="ts">
import { ref, nextTick, watch, useTemplateRef } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import libraryItem from '@renderer/components/libraryItem.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import listIcon from '@renderer/assets/listIcon.png?asset'
import listIconBlue from '@renderer/assets/listIconBlue.png?asset'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import scanNewSongDialog from '@renderer/components/scanNewSongDialog'
import exportDialog from '@renderer/components/exportDialog'
import { t } from '@renderer/utils/translate'
import dropIntoDialog from '../components/dropIntoDialog'
import emitter from '../utils/mitt'
const props = defineProps({
  uuid: {
    type: String,
    required: true
  },
  libraryName: {
    type: String,
    required: true
  }
})
const runtime = useRuntimeStore()
let dirData = libraryUtils.getLibraryTreeByUUID(props.uuid)
if (dirData === null) {
  throw new Error(`dirData error: ${JSON.stringify(dirData)}`)
}
let fatherDirData = libraryUtils.getFatherLibraryTreeByUUID(props.uuid)
if (fatherDirData === null) {
  throw new Error(`fatherDirData error: ${JSON.stringify(fatherDirData)}`)
}
const myInputHandleInput = () => {
  if (operationInputValue.value == '') {
    inputHintText.value = t('必须提供歌单或文件夹名。')
    inputHintShow.value = true
  } else {
    let exists = fatherDirData.children?.some((obj) => obj.dirName == operationInputValue.value)
    if (exists) {
      inputHintText.value =
        t('此位置已存在歌单或文件夹') + operationInputValue.value + t('。请选择其他名称')
      inputHintShow.value = true
    } else {
      inputHintShow.value = false
    }
  }
}

const inputKeyDownEnter = () => {
  if (operationInputValue.value == '') {
    inputHintText.value = t('必须提供歌单或文件夹名。')
    inputHintShow.value = true
    return
  }
  if (inputHintShow.value) {
    return
  }
  myInput.value?.blur()
}

const inputKeyDownEsc = () => {
  operationInputValue.value = ''
  inputBlurHandle()
}

const inputHintText = ref('')
const inputBlurHandle = async () => {
  if (fatherDirData.children === undefined) {
    throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
  }
  if (inputHintShow.value || operationInputValue.value == '') {
    if (dirData.dirName == '') {
      if (fatherDirData.children[0]?.dirName == '') {
        fatherDirData.children.shift()
      }
    }
    operationInputValue.value = ''
    inputHintShow.value = false
    return
  }

  await window.electron.ipcRenderer.invoke(
    'mkDir',
    {
      uuid: dirData.uuid,
      type: dirData.type == 'dir' ? 'dir' : 'songList',
      dirName: operationInputValue.value,
      order: 1
    },
    libraryUtils.findDirPathByUuid(props.uuid)
  )

  for (let item of fatherDirData.children) {
    if (item.order) {
      item.order++
    }
  }
  dirData.dirName = operationInputValue.value
  dirData.order = 1
  dirData.children = []
  operationInputValue.value = ''
}
let operationInputValue = ref('')

const inputHintShow = ref(false)

const myInput = useTemplateRef('myInput')
if (dirData.dirName == '') {
  nextTick(() => {
    myInput.value?.focus()
  })
}

const rightClickMenuShow = ref(false)
const menuArr = ref(
  dirData.type == 'dir'
    ? [
        [{ menuName: '新建歌单' }, { menuName: '新建文件夹' }],
        [{ menuName: '重命名' }, { menuName: '删除' }]
      ]
    : [
        [{ menuName: '导入曲目' }, { menuName: '导出曲目' }],
        [{ menuName: '重命名' }, { menuName: '删除' }],
        [{ menuName: '在文件资源管理器中显示' }]
      ]
)
const contextmenuEvent = async (event: MouseEvent) => {
  rightClickMenuShow.value = true
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  rightClickMenuShow.value = false
  if (result !== 'cancel') {
    if (result.menuName == '新建歌单') {
      dirChildRendered.value = true
      dirChildShow.value = true

      dirData.children?.unshift({
        uuid: uuidV4(),
        dirName: '',
        type: 'songList'
      })
    } else if (result.menuName == '新建文件夹') {
      dirChildRendered.value = true
      dirChildShow.value = true

      dirData.children?.unshift({
        uuid: uuidV4(),
        dirName: '',
        type: 'dir'
      })
    } else if (result.menuName == '重命名') {
      renameDivShow.value = true
      renameDivValue.value = dirData.dirName
      await nextTick()
      myRenameInput.value?.focus()
    } else if (result.menuName == '删除') {
      let res = await confirm({
        title: '删除',
        content: [
          dirData.type == 'dir' ? t('确认删除此文件夹吗？') : t('确认删除此歌单吗？'),
          t('(曲目将在磁盘上被删除，但声音指纹依然会保留)')
        ]
      })
      if (res === 'confirm') {
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
        const path = libraryUtils.findDirPathByUuid(props.uuid)
        await window.electron.ipcRenderer.invoke('delDir', path)
        await window.electron.ipcRenderer.invoke(
          'updateOrderAfterNum',
          libraryUtils.findDirPathByUuid(fatherDirData.uuid),
          dirData.order
        )
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
      }
    } else if (result.menuName == '导入曲目') {
      if (runtime.isProgressing) {
        await confirm({
          title: t('导入'),
          content: [t('请等待当前任务执行结束')],
          confirmShow: false
        })
        return
      }
      await scanNewSongDialog({ libraryName: props.libraryName, songListUuid: props.uuid })
    } else if (result.menuName == '导出曲目') {
      if (runtime.isProgressing) {
        await confirm({
          title: t('导入'),
          content: [t('请等待当前任务执行结束')],
          confirmShow: false
        })
        return
      }
      let result = await exportDialog({ title: '曲目' })
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
    } else if (result.menuName == '在文件资源管理器中显示') {
      window.electron.ipcRenderer.send(
        'openFileExplorer',
        libraryUtils.findDirPathByUuid(props.uuid)
      )
    }
  }
}

const dirChildShow = ref(false)
const dirChildRendered = ref(false)
const dirHandleClick = async () => {
  runtime.activeMenuUUID = ''
  if (dirData.type == 'songList') {
    runtime.songsArea.songListUUID = props.uuid
  } else {
    dirChildRendered.value = true
    dirChildShow.value = !dirChildShow.value
  }
}

emitter.on('collapseButtonHandleClick', (libraryName) => {
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
  await window.electron.ipcRenderer.invoke(
    'renameDir',
    renameDivValue.value,
    libraryUtils.findDirPathByUuid(props.uuid)
  )
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
}
const renameInputKeyDownEnter = () => {
  if (renameDivValue.value == '') {
    renameInputHintText.value = t('必须提供歌单或文件夹名。')
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
  if (renameDivValue.value == '') {
    renameInputHintText.value = t('必须提供歌单或文件夹名。')
    renameInputHintShow.value = true
  } else {
    let exists = fatherDirData.children?.some((obj) => obj.dirName == renameDivValue.value)
    if (exists) {
      renameInputHintText.value =
        t('此位置已存在歌单或文件夹') + renameDivValue.value + t('。请选择其他名称')
      renameInputHintShow.value = true
    } else {
      renameInputHintShow.value = false
    }
  }
}

//----------------------------------------

const dragstart = () => {
  runtime.dragItemData = dirData
}
const dragApproach = ref('')
const dragover = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    if (dirData.type === 'dir') {
      e.dataTransfer.dropEffect = 'none'
      return
    }
    if (runtime.dragTableHeader) {
      e.dataTransfer.dropEffect = 'none'
      return
    }
    dragApproach.value = 'center'
    e.dataTransfer.dropEffect = 'move'
    return
  }
  e.dataTransfer.dropEffect = 'move'
  if (runtime.dragItemData == dirData) {
    return
  }

  if (libraryUtils.isDragItemInDirChildren(dirData.uuid)) {
    return
  }
  if (dirData.type == 'songList') {
    if (e.offsetY <= 12) {
      dragApproach.value = 'top'
    } else {
      dragApproach.value = 'bottom'
    }
  } else {
    if (e.offsetY <= 8) {
      dragApproach.value = 'top'
    } else if (e.offsetY > 8 && e.offsetY < 16) {
      dragApproach.value = 'center'
    } else {
      dragApproach.value = 'bottom'
    }
  }
}
const dragenter = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    if (dirData.type === 'dir') {
      e.dataTransfer.dropEffect = 'none'
      return
    }
    if (runtime.dragTableHeader) {
      e.dataTransfer.dropEffect = 'none'
      return
    }
    dragApproach.value = 'center'
    e.dataTransfer.dropEffect = 'move'
    return
  }
  e.dataTransfer.dropEffect = 'move'
  if (runtime.dragItemData == dirData) {
    return
  }
  if (libraryUtils.isDragItemInDirChildren(dirData.uuid)) {
    return
  }
  if (dirData.type == 'songList') {
    if (e.offsetY <= 12) {
      dragApproach.value = 'top'
    } else {
      dragApproach.value = 'bottom'
    }
  } else {
    if (e.offsetY <= 8) {
      dragApproach.value = 'top'
    } else if (e.offsetY > 8 && e.offsetY < 16) {
      dragApproach.value = 'center'
    } else {
      dragApproach.value = 'bottom'
    }
  }
}
const dragleave = () => {
  dragApproach.value = ''
}

const approachCenterEnd = () => {
  if (dirData.children === undefined) {
    throw new Error(`dirData.children error: ${JSON.stringify(dirData.children)}`)
  }
  if (runtime.dragItemData === null) {
    throw new Error(`runtime.dragItemData error: ${JSON.stringify(runtime.dragItemData)}`)
  }
  dirData.children.unshift({ ...runtime.dragItemData, order: 1 })
  let dragItemDataFather = libraryUtils.getFatherLibraryTreeByUUID(runtime.dragItemData.uuid)
  if (dragItemDataFather === null || dragItemDataFather.children === undefined) {
    throw new Error(`dragItemDataFather error: ${JSON.stringify(dragItemDataFather)}`)
  }
  for (let item of dragItemDataFather.children) {
    if (item.order && runtime.dragItemData.order) {
      if (item.order > runtime.dragItemData.order) {
        item.order--
      }
    }
  }
  dragItemDataFather.children.splice(dragItemDataFather.children.indexOf(runtime.dragItemData), 1)
}
const drop = async (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'move'
    dragApproach.value = ''
    let files = Array.from(e.dataTransfer.files)
    let result = await dropIntoDialog({
      songListUuid: props.uuid,
      libraryName: props.libraryName
    })
    if (result === 'cancel') {
      return
    }
    let filePaths = []
    for (let item of files) {
      filePaths.push(item.path)
    }
    runtime.importingSongListUUID = result.importingSongListUUID
    runtime.isProgressing = true
    window.electron.ipcRenderer.send('startImportSongs', {
      filePaths: filePaths,
      songListPath: result.songListPath,
      isDeleteSourceFile: result.isDeleteSourceFile,
      isComparisonSongFingerprint: result.isComparisonSongFingerprint,
      isPushSongFingerprintLibrary: result.isPushSongFingerprintLibrary,
      songListUUID: result.importingSongListUUID
    })
    return
  }
  try {
    let approach = dragApproach.value
    dragApproach.value = ''
    if (runtime.dragItemData == dirData) {
      return
    }
    if (libraryUtils.isDragItemInDirChildren(dirData.uuid)) {
      return
    }
    if (approach == 'center') {
      if (dirData.children === undefined) {
        throw new Error(`dirData.children error: ${JSON.stringify(dirData.children)}`)
      }
      if (
        libraryUtils.getFatherLibraryTreeByUUID(runtime.dragItemData.uuid)?.uuid == dirData.uuid
      ) {
        let removedElement = dirData.children?.splice(
          dirData.children.indexOf(runtime.dragItemData),
          1
        )[0]
        if (removedElement === undefined) {
          throw new Error(`removedElement error: ${JSON.stringify(removedElement)}`)
        }
        dirData.children?.unshift(removedElement)

        libraryUtils.reOrderChildren(dirData.children)
        await window.electron.ipcRenderer.invoke(
          'reOrderSubDir',
          libraryUtils.findDirPathByUuid(dirData.uuid),
          JSON.stringify(dirData.children)
        )
        return
      }
      const existingItem = dirData.children.find((item) => {
        return (
          item.dirName === runtime.dragItemData?.dirName && item.uuid !== runtime.dragItemData.uuid
        )
      })
      if (existingItem) {
        let res = await confirm({
          title: '移动',
          content: [
            t('目标文件夹下已存在："') + runtime.dragItemData.dirName + t('"'),
            t('是否继续执行替换'),
            t('（被替换的歌单或文件夹将被删除）')
          ]
        })
        if (res == 'confirm') {
          await window.electron.ipcRenderer.invoke(
            'moveInDir',
            libraryUtils.findDirPathByUuid(runtime.dragItemData.uuid),
            libraryUtils.findDirPathByUuid(dirData.uuid),
            true
          )
          let oldOrder = existingItem.order
          dirData.children.splice(dirData.children.indexOf(existingItem), 1)
          for (let item of dirData.children) {
            if (item.order && oldOrder) {
              if (item.order < oldOrder) {
                item.order++
              } else {
                break
              }
            }
          }
          approachCenterEnd()
        }
        return
      }
      let dragItemDataFather = libraryUtils.getFatherLibraryTreeByUUID(runtime.dragItemData.uuid)
      if (dragItemDataFather === null || dragItemDataFather.children === undefined) {
        throw new Error(`dragItemDataFather error: ${JSON.stringify(dragItemDataFather)}`)
      }
      await window.electron.ipcRenderer.invoke(
        'moveToDirSample',
        libraryUtils.findDirPathByUuid(runtime.dragItemData.uuid),
        libraryUtils.findDirPathByUuid(dirData.uuid)
      )
      let removedElement = dragItemDataFather.children.splice(
        dragItemDataFather.children.indexOf(runtime.dragItemData),
        1
      )[0]
      libraryUtils.reOrderChildren(dragItemDataFather.children)
      await window.electron.ipcRenderer.invoke(
        'reOrderSubDir',
        libraryUtils.findDirPathByUuid(dragItemDataFather.uuid),
        JSON.stringify(dragItemDataFather.children)
      )
      dirData.children.unshift(removedElement)
      libraryUtils.reOrderChildren(dirData.children)
      await window.electron.ipcRenderer.invoke(
        'reOrderSubDir',
        libraryUtils.findDirPathByUuid(dirData.uuid),
        JSON.stringify(dirData.children)
      )
      let libraryTree = libraryUtils.getLibraryTreeByUUID(runtime.dragItemData.uuid)
      if (libraryTree === null) {
        throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
      }
      let flatUUID = libraryUtils.getAllUuids(libraryTree)
      if (flatUUID.indexOf(runtime.songsArea.songListUUID) != -1) {
        runtime.songsArea.songListUUID = ''
      }
      if (flatUUID.indexOf(runtime.playingData.playingSongListUUID) != -1) {
        runtime.playingData.playingSongListUUID = ''
        runtime.playingData.playingSongListData = []
        runtime.playingData.playingSong = null
      }
      return
    } else if (approach == 'top' || approach == 'bottom') {
      let dragItemDataFather = libraryUtils.getFatherLibraryTreeByUUID(runtime.dragItemData.uuid)
      if (dragItemDataFather == fatherDirData) {
        if (dirData.order === undefined) {
          throw new Error(`order error: ${JSON.stringify(dirData)}`)
        }
        if (runtime.dragItemData.order === undefined) {
          throw new Error(`order error: ${JSON.stringify(runtime.dragItemData)}`)
        }
        if (fatherDirData.children === undefined) {
          throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
        }
        // 两个dir在同一目录下
        if (approach == 'top' && dirData.order - runtime.dragItemData.order == 1) {
          return
        }
        if (approach == 'bottom' && runtime.dragItemData.order - dirData.order == 1) {
          return
        }
        let removedElement = fatherDirData.children.splice(
          fatherDirData.children.indexOf(runtime.dragItemData),
          1
        )[0]
        fatherDirData.children.splice(
          approach == 'top'
            ? fatherDirData.children.indexOf(dirData)
            : fatherDirData.children.indexOf(dirData) + 1,
          0,
          removedElement
        )
        libraryUtils.reOrderChildren(fatherDirData.children)

        await window.electron.ipcRenderer.invoke(
          'reOrderSubDir',
          libraryUtils.findDirPathByUuid(fatherDirData.uuid),
          JSON.stringify(fatherDirData.children)
        )
        return
      } else {
        if (fatherDirData.children === undefined) {
          throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
        }
        // 两个dir不在同一目录下
        const existingItem = fatherDirData.children.find((item) => {
          return (
            item.dirName === runtime.dragItemData?.dirName &&
            item.uuid !== runtime.dragItemData.uuid
          )
        })
        if (existingItem) {
          let res = await confirm({
            title: '移动',
            content: [
              t('目标文件夹下已存在："') + runtime.dragItemData.dirName + t('"'),
              t('是否继续执行替换'),
              t('（被替换的歌单或文件夹将被删除）')
            ]
          })
          if (res == 'confirm') {
            if (dragItemDataFather === null || dragItemDataFather.children === undefined) {
              throw new Error(`dragItemDataFather error: ${JSON.stringify(dragItemDataFather)}`)
            }
            let targetPath = libraryUtils.findDirPathByUuid(existingItem.uuid)

            await window.electron.ipcRenderer.invoke('delDir', targetPath)
            fatherDirData.children.splice(
              approach == 'top'
                ? fatherDirData.children.indexOf(dirData)
                : fatherDirData.children.indexOf(dirData) + 1,
              0,
              runtime.dragItemData
            )
            fatherDirData.children.splice(fatherDirData.children.indexOf(existingItem), 1)
            libraryUtils.reOrderChildren(fatherDirData.children)
            await window.electron.ipcRenderer.invoke(
              'moveToDirSample',
              libraryUtils.findDirPathByUuid(runtime.dragItemData.uuid),
              libraryUtils.findDirPathByUuid(fatherDirData.uuid)
            )
            await window.electron.ipcRenderer.invoke(
              'reOrderSubDir',
              libraryUtils.findDirPathByUuid(fatherDirData.uuid),
              JSON.stringify(fatherDirData.children)
            )
            dragItemDataFather.children.splice(
              dragItemDataFather.children.indexOf(runtime.dragItemData),
              1
            )
            libraryUtils.reOrderChildren(dragItemDataFather.children)
            await window.electron.ipcRenderer.invoke(
              'reOrderSubDir',
              libraryUtils.findDirPathByUuid(dragItemDataFather.uuid),
              JSON.stringify(dragItemDataFather.children)
            )
          }
          let libraryTree = libraryUtils.getLibraryTreeByUUID(runtime.dragItemData.uuid)
          if (libraryTree === null) {
            throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
          }
          let flatUUID = libraryUtils.getAllUuids(libraryTree)
          if (flatUUID.indexOf(runtime.songsArea.songListUUID) != -1) {
            runtime.songsArea.songListUUID = ''
          }
          if (flatUUID.indexOf(runtime.playingData.playingSongListUUID) != -1) {
            runtime.playingData.playingSongListUUID = ''
            runtime.playingData.playingSongListData = []
            runtime.playingData.playingSong = null
          }
          return
        }
        await window.electron.ipcRenderer.invoke(
          'moveToDirSample',
          libraryUtils.findDirPathByUuid(runtime.dragItemData.uuid),
          libraryUtils.findDirPathByUuid(fatherDirData.uuid)
        )
        if (dragItemDataFather === null || dragItemDataFather.children === undefined) {
          throw new Error(`dragItemDataFather error: ${JSON.stringify(dragItemDataFather)}`)
        }
        let removedElement = dragItemDataFather.children.splice(
          dragItemDataFather.children.indexOf(runtime.dragItemData),
          1
        )[0]
        fatherDirData.children.splice(
          approach == 'top'
            ? fatherDirData.children.indexOf(dirData)
            : fatherDirData.children.indexOf(dirData) + 1,
          0,
          removedElement
        )
        libraryUtils.reOrderChildren(dragItemDataFather.children)
        await window.electron.ipcRenderer.invoke(
          'reOrderSubDir',
          libraryUtils.findDirPathByUuid(dragItemDataFather.uuid),
          JSON.stringify(dragItemDataFather.children)
        )
        libraryUtils.reOrderChildren(fatherDirData.children)
        await window.electron.ipcRenderer.invoke(
          'reOrderSubDir',
          libraryUtils.findDirPathByUuid(fatherDirData.uuid),
          JSON.stringify(fatherDirData.children)
        )
        let libraryTree = libraryUtils.getLibraryTreeByUUID(runtime.dragItemData.uuid)
        if (libraryTree === null) {
          throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
        }
        let flatUUID = libraryUtils.getAllUuids(libraryTree)
        if (flatUUID.indexOf(runtime.songsArea.songListUUID) != -1) {
          runtime.songsArea.songListUUID = ''
        }
        if (flatUUID.indexOf(runtime.playingData.playingSongListUUID) != -1) {
          runtime.playingData.playingSongListUUID = ''
          runtime.playingData.playingSongListData = []
          runtime.playingData.playingSong = null
        }
        return
      }
    }
  } catch (error) {
    throw error
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
</script>
<template>
  <div
    class="mainBody"
    style="display: flex; cursor: pointer; box-sizing: border-box"
    :style="'padding-left:' + indentWidth + 'px'"
    @contextmenu.stop="contextmenuEvent"
    @click.stop="dirHandleClick()"
    @dragover.stop.prevent="dragover"
    @dragstart.stop="dragstart"
    @dragenter.stop.prevent="dragenter"
    @drop.stop.prevent="drop"
    @dragleave.stop="dragleave"
    :draggable="dirData.dirName && !renameDivShow ? true : false"
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
        v-if="dirData.type == 'songList' && runtime.importingSongListUUID != props.uuid"
        style="width: 13px; height: 13px"
        :src="isPlaying ? listIconBlue : listIcon"
      />
      <div
        v-if="dirData.type == 'songList' && runtime.importingSongListUUID == props.uuid"
        class="loading"
        :class="{ isPlayingLoading: isPlaying }"
      ></div>
    </div>
    <div style="height: 23px; width: calc(100% - 20px)">
      <div
        v-if="dirData.dirName && !renameDivShow"
        style="
          line-height: 23px;
          font-size: 13px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        "
        :class="{ isPlaying: isPlaying }"
      >
        {{ dirData.dirName }}
      </div>
      <div v-if="!dirData.dirName">
        <input
          ref="myInput"
          v-model="operationInputValue"
          class="myInput"
          :class="{ myInputRedBorder: inputHintShow }"
          @blur="inputBlurHandle"
          @keydown.enter="inputKeyDownEnter"
          @keydown.Esc="inputKeyDownEsc"
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
          @keydown.Esc="renameInputKeyDownEsc"
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
      <libraryItem :uuid="item.uuid" :libraryName="props.libraryName" />
    </template>
  </div>
</template>
<style lang="scss" scoped>
.isPlaying {
  color: #0078d4 !important;
}

.isPlayingLoading {
  border: 2px solid #0078d4 !important;
}

.loading {
  width: 8px;
  height: 8px;
  border: 2px solid #cccccc;
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
  background-color: #37373d;

  &:hover {
    background-color: #37373d !important;
  }
}

.mainBody {
  &:hover {
    background-color: #2a2d2e;
  }
}

.borderTop {
  box-shadow: inset 0 1px 0 0 #0078d4;
}

.borderBottom {
  box-shadow: inset 0 -1px 0 0 #0078d4;
}

.borderCenter {
  box-shadow: inset 0 0 0 1px #0078d4;
}

.rightClickBorder {
  box-shadow: inset 0 0 0 1px #0078d4;
}

.myInput {
  width: calc(100% - 6px);
  height: 19px;
  background-color: #313131;
  border: 1px solid #086bb7;
  outline: none;
  color: #cccccc;
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
    font-size: 12px;
    padding-left: 5px;
    position: relative;
    z-index: 100;
  }
}

.prefixIcon {
  color: #cccccc;
  width: 20px;
  min-width: 20px;
  height: 23px;
  display: flex;
  justify-content: center;
  align-items: center;
}
</style>
