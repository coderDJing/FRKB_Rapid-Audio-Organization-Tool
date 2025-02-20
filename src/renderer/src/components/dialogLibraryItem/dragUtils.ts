import type { IDir } from 'src/types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { getCurrentTimeDirName } from '@renderer/utils/utils'

export const handleDragStart = async (event: DragEvent, dirData: IDir) => {
  const runtime = useRuntimeStore()
  let songListPath = libraryUtils.findDirPathByUuid(dirData.uuid)
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
  runtime.dragItemData = dirData
  return false
}

export function handleDragOver(e: DragEvent, dirData: IDir): string {
  const runtime = useRuntimeStore()
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return ''
  }
  e.dataTransfer.dropEffect = 'move'
  if (runtime.dragItemData == dirData) {
    return ''
  }

  if (libraryUtils.isDragItemInDirChildren(dirData.uuid)) {
    return ''
  }
  if (dirData.type == 'songList') {
    if (e.offsetY <= 12) {
      return 'top'
    } else {
      return 'bottom'
    }
  } else {
    if (e.offsetY <= 8) {
      return 'top'
    } else if (e.offsetY > 8 && e.offsetY < 16) {
      return 'center'
    } else {
      return 'bottom'
    }
  }
}

export function handleDragEnter(e: DragEvent, dirData: IDir): string {
  return handleDragOver(e, dirData)
}

export function handleDragLeave(e: DragEvent): string {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  const runtime = useRuntimeStore()
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
  }
  return ''
}

const approachCenterEnd = async (dirData: IDir) => {
  const runtime = useRuntimeStore()
  if (dirData.children === undefined) {
    throw new Error(`dirData error: ${JSON.stringify(dirData)}`)
  }
  if (runtime.dragItemData === null || runtime.dragItemData.order === undefined) {
    throw new Error(`runtime.dragItemData error: ${JSON.stringify(runtime.dragItemData)}`)
  }
  let dragItemDataFather = libraryUtils.getFatherLibraryTreeByUUID(runtime.dragItemData.uuid)
  if (dragItemDataFather === null || dragItemDataFather.children === undefined) {
    throw new Error(`dragItemDataFather error: ${JSON.stringify(dragItemDataFather)}`)
  }
  dirData.children.unshift({ ...runtime.dragItemData, order: 1 })
  for (let item of dragItemDataFather.children) {
    if (item.order) {
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
  fatherDirData: IDir | null,
  approach: string
) {
  const runtime = useRuntimeStore()
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (dirData.children === undefined || dirData.order === undefined) {
    throw new Error(`dirData error: ${JSON.stringify(dirData)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }
  if (runtime.dragItemData.order === undefined) {
    throw new Error(`runtime.dragItemData error: ${JSON.stringify(runtime.dragItemData)}`)
  }
  try {
    if (runtime.dragItemData == dirData) {
      return
    }
    if (libraryUtils.isDragItemInDirChildren(dirData.uuid)) {
      return
    }
    if (approach == 'center') {
      let fatherLibraryTree = libraryUtils.getFatherLibraryTreeByUUID(runtime.dragItemData.uuid)
      if (fatherLibraryTree === null) {
        throw new Error(`fatherLibraryTree error: ${JSON.stringify(fatherLibraryTree)}`)
      }
      if (fatherLibraryTree.uuid == dirData.uuid) {
        let removedElement = dirData.children.splice(
          dirData.children.indexOf(runtime.dragItemData),
          1
        )[0]
        dirData.children.unshift(removedElement)
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
          if (oldOrder === undefined) {
            throw new Error(`oldOrder error: ${JSON.stringify(oldOrder)}`)
          }
          dirData.children.splice(dirData.children.indexOf(existingItem), 1)
          for (let item of dirData.children) {
            if (item.order) {
              if (item.order < oldOrder) {
                item.order++
              } else {
                break
              }
            }
          }
          await approachCenterEnd(dirData)
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
      if (fatherDirData?.children === undefined) {
        throw new Error(`fatherDirData error: ${JSON.stringify(fatherDirData)}`)
      }
      if (dragItemDataFather == fatherDirData) {
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
            let targetPath = libraryUtils.findDirPathByUuid(existingItem.uuid)

            await window.electron.ipcRenderer.invoke('delDir', targetPath, getCurrentTimeDirName())
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
            if (dragItemDataFather === null || dragItemDataFather.children === undefined) {
              throw new Error(`dragItemDataFather error: ${JSON.stringify(dragItemDataFather)}`)
            }
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
  } catch (error) {}
}
