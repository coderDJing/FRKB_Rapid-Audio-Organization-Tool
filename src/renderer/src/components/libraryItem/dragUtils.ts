import type { IDir } from 'src/types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { getCurrentTimeDirName } from '@renderer/utils/utils'
import dropIntoDialog from '../dropIntoDialog'

export interface DragState {
  dragApproach: 'top' | 'center' | 'bottom' | ''
}

// 拖拽开始时的验证和初始化
export const handleDragStart = async (event: DragEvent, uuid: string): Promise<boolean> => {
  try {
    const runtime = useRuntimeStore()
    const songListPath = libraryUtils.findDirPathByUuid(uuid)

    const exists = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
    if (!exists) {
      event.preventDefault()
      await confirm({
        title: t('错误'),
        content: [t('此歌单/文件夹在磁盘中不存在，可能已被手动删除')],
        confirmShow: false
      })
      return true // 需要从列表中删除
    }

    runtime.dragItemData = libraryUtils.getLibraryTreeByUUID(uuid)
    return false
  } catch (error) {
    console.error('Drag start failed:', error)
    event.preventDefault()
    return false
  }
}

// 计算拖拽指示器位置
const calculateDragApproach = (offsetY: number, isFolder: boolean): 'top' | 'center' | 'bottom' => {
  if (!isFolder) {
    return offsetY <= 12 ? 'top' : 'bottom'
  }

  if (offsetY <= 8) return 'top'
  if (offsetY > 8 && offsetY < 16) return 'center'
  return 'bottom'
}

// 验证拖拽操作是否有效
const isValidDrop = (
  dragItemData: IDir | null,
  targetDir: IDir,
  dragApproach: 'top' | 'center' | 'bottom' | ''
): boolean => {
  // 基础验证
  if (!dragItemData || !targetDir) return false

  // 不能拖拽到自身或其子项
  if (
    dragItemData.uuid === targetDir.uuid ||
    libraryUtils.isDragItemInDirChildren(dragItemData.uuid)
  ) {
    return false
  }

  const dragItemFather = libraryUtils.getFatherLibraryTreeByUUID(dragItemData.uuid)
  const targetDirFather = libraryUtils.getFatherLibraryTreeByUUID(targetDir.uuid)

  // 不能拖拽到父目录
  if (dragItemFather === targetDir) return false

  // 同级目录的特殊处理
  if (dragItemFather === targetDirFather) {
    const sourceOrder = dragItemData.order ?? 0
    const targetOrder = targetDir.order ?? 0
    const orderDiff = sourceOrder - targetOrder

    // 相邻项的特殊处理
    if (Math.abs(orderDiff) === 1) {
      // 向下拖到下一项的顶部 或 向上拖到上一项的底部时不允许
      if (
        (orderDiff === 1 && dragApproach === 'bottom') ||
        (orderDiff === -1 && dragApproach === 'top')
      ) {
        return false
      }
    }
  }

  return true
}

// 处理拖拽悬停
export const handleDragOver = (e: DragEvent, dirData: IDir | null, dragState: DragState): void => {
  if (!dirData) return
  const runtime = useRuntimeStore()

  // 重置状态
  dragState.dragApproach = ''

  // 外部拖拽处理
  if (!runtime.dragItemData) {
    if (dirData.type === 'songList') {
      e.dataTransfer!.dropEffect = 'copy'
      dragState.dragApproach = 'center'
    } else {
      e.dataTransfer!.dropEffect = 'none'
    }
    return
  }
  let dragApproach = calculateDragApproach(e.offsetY, dirData.type === 'dir')
  // 内部拖拽处理
  if (!isValidDrop(runtime.dragItemData, dirData, dragApproach)) {
    e.dataTransfer!.dropEffect = 'none'
    dragState.dragApproach = ''
    return
  }

  e.dataTransfer!.dropEffect = 'move'
  dragState.dragApproach = dragApproach
}

// 处理拖拽进入
export const handleDragEnter = (e: DragEvent, dirData: IDir | null, dragState: DragState): void => {
  if (!dirData) return
  handleDragOver(e, dirData, dragState)
}

// 处理拖拽离开
export function handleDragLeave(dragState: DragState): void {
  dragState.dragApproach = ''
}

// 处理文件移动
async function handleFileMove(
  dragItemData: IDir,
  targetDir: IDir,
  existingItem?: IDir
): Promise<void> {
  const runtime = useRuntimeStore()

  // 如果存在同名文件，先删除
  if (existingItem) {
    const targetPath = libraryUtils.findDirPathByUuid(existingItem.uuid)
    if (targetPath === '') {
      throw new Error('无法找到目标路径')
    }
    await window.electron.ipcRenderer.invoke('delDir', targetPath, getCurrentTimeDirName())
  }

  // 移动文件
  const sourcePath = libraryUtils.findDirPathByUuid(dragItemData.uuid)
  const targetPath = libraryUtils.findDirPathByUuid(targetDir.uuid)
  if (sourcePath === '' || targetPath === '') {
    throw new Error('无法找到源路径或目标路径')
  }
  await window.electron.ipcRenderer.invoke('moveToDirSample', sourcePath, targetPath)
}

// 更新数据结构
async function updateDataStructure(
  dragItemData: IDir,
  targetDir: IDir,
  approach: string,
  fatherDirData: IDir | null
): Promise<void> {
  try {
    const dragItemFather = libraryUtils.getFatherLibraryTreeByUUID(dragItemData.uuid)
    if (!dragItemFather?.children) {
      console.error('Source parent directory not found or has no children')
      return
    }

    // 从原位置移除
    const itemIndex = dragItemFather.children.findIndex((item) => item.uuid === dragItemData.uuid)
    if (itemIndex === -1) {
      console.error('Source item not found in parent directory')
      return
    }

    // 创建深拷贝并保留所有属性
    const movedItem = JSON.parse(JSON.stringify(dragItemFather.children[itemIndex]))
    dragItemFather.children.splice(itemIndex, 1)

    // 重新排序原位置
    libraryUtils.reOrderChildren(dragItemFather.children)

    await window.electron.ipcRenderer.invoke(
      'reOrderSubDir',
      libraryUtils.findDirPathByUuid(dragItemFather.uuid),
      JSON.stringify(dragItemFather.children)
    )

    // 添加到新位置
    if (approach === 'center' && targetDir.type === 'dir') {
      if (!targetDir.children) {
        targetDir.children = []
      }

      // 设置为第一个项目
      movedItem.order = 1
      targetDir.children.unshift(movedItem)

      // 更新其他项目的order
      for (let i = 1; i < targetDir.children.length; i++) {
        const child = targetDir.children[i]
        if (child?.order !== undefined) {
          child.order++
        }
      }

      // 重新排序并更新目标目录
      libraryUtils.reOrderChildren(targetDir.children)
      console.log(111)
      await window.electron.ipcRenderer.invoke(
        'reOrderSubDir',
        libraryUtils.findDirPathByUuid(targetDir.uuid),
        JSON.stringify(targetDir.children)
      )
      //todo 从文件夹中拖出到文件夹外 会报错（可能要先执行正常的排序操作之类的前置操作）
      console.log(222)

      // 更新移动项的.description.json
      await window.electron.ipcRenderer.invoke(
        'updateDirDescription',
        libraryUtils.findDirPathByUuid(movedItem.uuid),
        JSON.stringify({ ...movedItem, children: undefined })
      )
    } else if (fatherDirData?.children) {
      const targetIndex = fatherDirData.children.findIndex((item) => item.uuid === targetDir.uuid)
      if (targetIndex === -1) {
        console.error('Target position not found')
        return
      }

      const insertIndex = approach === 'top' ? targetIndex : targetIndex + 1
      movedItem.order = approach === 'top' ? (targetDir.order ?? 1) : (targetDir.order ?? 0) + 1

      fatherDirData.children.splice(insertIndex, 0, movedItem)

      // 更新受影响项目的order
      for (let i = insertIndex + 1; i < fatherDirData.children.length; i++) {
        const child = fatherDirData.children[i]
        if (child?.order !== undefined) {
          child.order++
        }
      }

      // 重新排序并更新目标父目录
      libraryUtils.reOrderChildren(fatherDirData.children)
      await window.electron.ipcRenderer.invoke(
        'reOrderSubDir',
        libraryUtils.findDirPathByUuid(fatherDirData.uuid),
        JSON.stringify(fatherDirData.children)
      )

      // 更新移动项的.description.json
      await window.electron.ipcRenderer.invoke(
        'updateDirDescription',
        libraryUtils.findDirPathByUuid(movedItem.uuid),
        JSON.stringify({ ...movedItem, children: undefined })
      )
    }
  } catch (error) {
    console.error('Failed to update data structure:', error)
    throw error // 重新抛出错误以便上层处理
  }
}

// 更新播放状态
function updatePlayingState(dragItemData: IDir): void {
  try {
    const runtime = useRuntimeStore()
    const libraryTree = libraryUtils.getLibraryTreeByUUID(dragItemData.uuid)
    if (!libraryTree) {
      console.warn('Library tree not found for uuid:', dragItemData.uuid)
      return
    }

    const flatUUID = libraryUtils.getAllUuids(libraryTree)

    // 更新当前选中的歌单
    if (flatUUID.includes(runtime.songsArea.songListUUID)) {
      runtime.songsArea.songListUUID = ''
    }

    // 更新正在播放的歌单
    if (flatUUID.includes(runtime.playingData.playingSongListUUID)) {
      runtime.playingData.playingSongListUUID = ''
      runtime.playingData.playingSongListData = []
      runtime.playingData.playingSong = null
    }
  } catch (error) {
    console.error('Failed to update playing state:', error)
  }
}

// 处理拖拽放下
export const handleDrop = async (
  e: DragEvent,
  dirData: IDir | null,
  dragState: DragState,
  fatherDirData: IDir | null
): Promise<boolean> => {
  if (!dirData || !fatherDirData) return false
  const runtime = useRuntimeStore()
  const approach = dragState.dragApproach
  dragState.dragApproach = ''

  try {
    if (runtime.dragItemData) {
      // 处理拖入文件夹的情况
      if (approach === 'center' && dirData.type === 'dir') {
        const existingItem = dirData.children?.find(
          (item) =>
            item.dirName === runtime.dragItemData?.dirName &&
            item.uuid !== runtime.dragItemData?.uuid
        )

        if (existingItem) {
          const shouldReplace = await confirm({
            title: t('移动'),
            content: [
              t('目标文件夹下已存在："') + runtime.dragItemData.dirName + t('"'),
              t('是否继续执行替换'),
              t('（被替换的歌单或文件夹将被删除）')
            ]
          })

          if (shouldReplace !== 'confirm') return false
        }
        let dragItemData = JSON.parse(JSON.stringify(runtime.dragItemData))
        // 先更新文件系统
        await handleFileMove(dragItemData, dirData, existingItem)

        // 更新数据结构

        await updateDataStructure(dragItemData, dirData, approach, fatherDirData)

        // 更新播放状态
        updatePlayingState(dragItemData)

        return false
      }

      // 处理同级排序
      if (fatherDirData && approach !== 'center') {
        await updateDataStructure(runtime.dragItemData, dirData, approach, fatherDirData)
      }
    } else if (e.dataTransfer?.files.length) {
      let files = Array.from(e.dataTransfer.files)
      let result = await dropIntoDialog({
        songListUuid: dirData.uuid,
        libraryName: runtime.libraryAreaSelected
      })
      if (result === 'cancel') {
        return false
      }
      runtime.importingSongListUUID = result.importingSongListUUID
      runtime.isProgressing = true
      let filePaths = []

      for (let item of files) {
        filePaths.push(item.path)
      }
      window.electron.ipcRenderer.send('startImportSongs', {
        filePaths: filePaths,
        songListPath: result.songListPath,
        isDeleteSourceFile: result.isDeleteSourceFile,
        isComparisonSongFingerprint: result.isComparisonSongFingerprint,
        isPushSongFingerprintLibrary: result.isPushSongFingerprintLibrary,
        songListUUID: result.importingSongListUUID
      })
    }
    return false
  } catch (error) {
    console.error('Drop operation failed:', error)
    return false
  } finally {
    runtime.dragItemData = null
  }
}
