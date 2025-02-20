import type { IDir } from 'src/types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import dropIntoDialog from '@renderer/components/dropIntoDialog'

export const handleDragStart = async (event: DragEvent, uuid: string) => {
  const runtime = useRuntimeStore()
  let songListPath = libraryUtils.findDirPathByUuid(uuid)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    event.preventDefault()
    await confirm({
      title: '错误',
      content: [t('此歌单/文件夹在磁盘中不存在，可能已被手动删除')],
      confirmShow: false
    })
    return true // 表示需要删除
  }
  runtime.dragItemData = libraryUtils.getLibraryTreeByUUID(uuid)
  return false
}

export function handleDragOver(e: DragEvent, dirData: IDir, dragState: { dragApproach: string }) {
  const runtime = useRuntimeStore()
  if (runtime.dragItemData === null) {
    // 外部拖拽，只允许拖到歌单的中间
    if (dirData.type !== 'songList') {
      e.dataTransfer!.dropEffect = 'none'
      dragState.dragApproach = ''
      return
    }
    e.dataTransfer!.dropEffect = 'copy'
    dragState.dragApproach = 'center'
    return
  }

  e.dataTransfer!.dropEffect = 'move'
  if (runtime.dragItemData === dirData) {
    return
  }

  if (libraryUtils.isDragItemInDirChildren(dirData.uuid)) {
    return
  }

  if (dirData.type === 'songList') {
    if (e.offsetY <= 12) {
      dragState.dragApproach = 'top'
    } else {
      dragState.dragApproach = 'bottom'
    }
  } else {
    if (e.offsetY <= 8) {
      dragState.dragApproach = 'top'
    } else if (e.offsetY > 8 && e.offsetY < 16) {
      dragState.dragApproach = 'center'
    } else {
      dragState.dragApproach = 'bottom'
    }
  }
}

export function handleDragEnter(e: DragEvent, dirData: IDir, dragState: { dragApproach: string }) {
  const runtime = useRuntimeStore()
  if (runtime.dragItemData === null) {
    // 外部拖拽，只允许拖到歌单的中间
    if (dirData.type !== 'songList') {
      e.dataTransfer!.dropEffect = 'none'
      dragState.dragApproach = ''
      return
    }
    e.dataTransfer!.dropEffect = 'copy'
    dragState.dragApproach = 'center'
    return
  }

  e.dataTransfer!.dropEffect = 'move'
  if (runtime.dragItemData === dirData) {
    return
  }

  if (libraryUtils.isDragItemInDirChildren(dirData.uuid)) {
    return
  }

  if (dirData.type === 'songList') {
    if (e.offsetY <= 12) {
      dragState.dragApproach = 'top'
    } else {
      dragState.dragApproach = 'bottom'
    }
  } else {
    if (e.offsetY <= 8) {
      dragState.dragApproach = 'top'
    } else if (e.offsetY > 8 && e.offsetY < 16) {
      dragState.dragApproach = 'center'
    } else {
      dragState.dragApproach = 'bottom'
    }
  }
}

export const handleDragLeave = (dragState: { dragApproach: string }) => {
  dragState.dragApproach = ''
}

const approachCenterEnd = async (dirData: any, runtime: any) => {
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

export async function handleDrop(
  e: DragEvent,
  dirData: IDir,
  dragState: { dragApproach: string },
  fatherDirData: IDir | null
): Promise<boolean> {
  const runtime = useRuntimeStore()
  let approach = dragState.dragApproach
  dragState.dragApproach = ''

  if (runtime.dragItemData === null) {
    return false
  }

  if (runtime.dragItemData === dirData) {
    runtime.dragItemData = null
    return false
  }

  if (libraryUtils.isDragItemInDirChildren(dirData.uuid)) {
    runtime.dragItemData = null
    return false
  }

  // 检查源文件是否存在
  let sourcePath = libraryUtils.findDirPathByUuid(runtime.dragItemData.uuid)
  let isSourcePathExist = await window.electron.ipcRenderer.invoke('dirPathExists', sourcePath)
  if (!isSourcePathExist) {
    runtime.dragItemData = null
    await confirm({
      title: '错误',
      content: [t('此歌单/文件夹在磁盘中不存在，可能已被手动删除')],
      confirmShow: false
    })
    return true
  }

  if (approach === 'center') {
    if (dirData.children === undefined) {
      throw new Error(`dirData.children error: ${JSON.stringify(dirData.children)}`)
    }
    if (libraryUtils.getFatherLibraryTreeByUUID(runtime.dragItemData.uuid)?.uuid == dirData.uuid) {
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
      return false
    }
    const existingItem = dirData.children.find((item: any) => {
      return (
        runtime.dragItemData &&
        item.dirName === runtime.dragItemData.dirName &&
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
        await approachCenterEnd(dirData, runtime)
      }
      return false
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
    return false
  } else if (approach === 'top' || approach === 'bottom') {
    let dragItemDataFather = libraryUtils.getFatherLibraryTreeByUUID(runtime.dragItemData.uuid)
    if (fatherDirData?.children === undefined) {
      runtime.dragItemData = null
      throw new Error(`fatherDirData error: ${JSON.stringify(fatherDirData)}`)
    }
    if (dragItemDataFather === fatherDirData) {
      // 两个dir在同一目录下
      if (
        dirData.order !== undefined &&
        runtime.dragItemData.order !== undefined &&
        ((approach === 'top' && dirData.order - runtime.dragItemData.order === 1) ||
          (approach === 'bottom' && runtime.dragItemData.order - dirData.order === 1))
      ) {
        runtime.dragItemData = null
        return false
      }
      let removedElement = fatherDirData.children.splice(
        fatherDirData.children.indexOf(runtime.dragItemData),
        1
      )[0]
      fatherDirData.children.splice(
        approach === 'top'
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
      return false
    } else {
      if (fatherDirData.children === undefined) {
        throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
      }
      // 两个dir不在同一目录下
      const existingItem = fatherDirData.children.find((item: any) => {
        return (
          runtime.dragItemData &&
          item.dirName === runtime.dragItemData.dirName &&
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

          await window.electron.ipcRenderer.invoke('delDir', targetPath, getCurrentTimeDirName())
          fatherDirData.children.splice(
            approach === 'top'
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
        return false
      }
    }
  }
  return false
}
