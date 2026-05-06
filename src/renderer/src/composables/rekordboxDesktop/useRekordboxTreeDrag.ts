import { ref } from 'vue'
import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { ensureRekordboxDesktopWriteAvailable } from '@renderer/utils/rekordboxDesktopWriteAvailability'
import { clearRekordboxSourceCachesByKind } from '@renderer/utils/rekordboxLibraryCache'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type { RekordboxDesktopMovePlaylistResponse } from '@shared/rekordboxDesktopPlaylist'
import {
  calculateDragApproach,
  cloneTreeNodes,
  isDescendantNode,
  isMovableTreeNode,
  moveTreeNode
} from './useRekordboxTreeUtils'

type ShowFailureFn = (message: string, logPath?: string) => Promise<void>
type LoadTreeFn = (preferredPlaylistId?: number) => Promise<void>
type RunWritingFn = <T>(task: () => Promise<T>) => Promise<T>

export function useRekordboxTreeDrag(
  rawTreeNodes: { value: IPioneerPlaylistTreeNode[] },
  dialogWriting: { value: boolean },
  selectedArea: { value: 'recent' | 'tree' | '' },
  searchKeyword: { value: string },
  showFailureDialog: ShowFailureFn,
  loadTree: LoadTreeFn,
  runWithDialogWriting: RunWritingFn
) {
  const runtime = useRuntimeStore()
  const dragSourceId = ref<number | null>(null)
  const dragTarget = ref<{
    nodeId: number
    approach: '' | 'top' | 'center' | 'bottom'
  } | null>(null)

  const resetDragState = () => {
    dragSourceId.value = null
    dragTarget.value = null
  }

  const handleDragStartNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    if (dialogWriting.value || !isMovableTreeNode(node) || searchKeyword.value) {
      event.preventDefault()
      return
    }
    dragSourceId.value = node.id
    dragTarget.value = null
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(node.id))
    }
  }

  const updateDragTarget = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    if (dialogWriting.value) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
      dragTarget.value = null
      return
    }
    if (!event.dataTransfer || dragSourceId.value === null) return
    if (!isMovableTreeNode(node) || searchKeyword.value) {
      event.dataTransfer.dropEffect = 'none'
      dragTarget.value = null
      return
    }
    if (node.id === dragSourceId.value) {
      event.dataTransfer.dropEffect = 'none'
      dragTarget.value = null
      return
    }
    if (isDescendantNode(rawTreeNodes.value, dragSourceId.value, node.id)) {
      event.dataTransfer.dropEffect = 'none'
      dragTarget.value = null
      return
    }
    const approach = calculateDragApproach(event.offsetY, node.isFolder)
    if (approach === 'center' && !node.isFolder) {
      event.dataTransfer.dropEffect = 'none'
      dragTarget.value = null
      return
    }
    event.dataTransfer.dropEffect = 'move'
    dragTarget.value = {
      nodeId: node.id,
      approach
    }
  }

  const handleDragOverNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    updateDragTarget(event, node)
  }

  const handleDragEnterNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    updateDragTarget(event, node)
  }

  const handleDragLeaveNode = (_event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    if (dialogWriting.value) return
    if (dragTarget.value?.nodeId === node.id) {
      dragTarget.value = null
    }
  }

  const handleDragEndNode = () => {
    if (dialogWriting.value) return
    resetDragState()
  }

  const handleDropNode = async (_event: DragEvent, node: IPioneerPlaylistTreeNode) => {
    if (dialogWriting.value) {
      resetDragState()
      return
    }
    if (dragSourceId.value === null || !dragTarget.value) {
      resetDragState()
      return
    }
    const sourceId = dragSourceId.value
    const targetState = { ...dragTarget.value }
    resetDragState()
    if (!targetState.approach) return

    const moved = moveTreeNode(rawTreeNodes.value, sourceId, node.id, targetState.approach)
    if (!moved) return

    const previousTree = cloneTreeNodes(rawTreeNodes.value)
    rawTreeNodes.value = moved.nodes
    selectedArea.value = 'tree'
    runtime.dialogSelectedSongListUUID = String(sourceId)

    await runWithDialogWriting(async () => {
      if (!(await ensureRekordboxDesktopWriteAvailable('move'))) {
        rawTreeNodes.value = previousTree
        return
      }

      const response = (await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('desktop', 'move-playlist'),
        {
          playlistId: moved.playlistId,
          parentId: moved.parentId,
          seq: moved.seq
        }
      )) as RekordboxDesktopMovePlaylistResponse

      if (!response.ok) {
        rawTreeNodes.value = previousTree
        await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
        return
      }

      clearRekordboxSourceCachesByKind('desktop')
      await loadTree(sourceId)
    })
  }

  return {
    dragSourceId,
    dragTarget,
    resetDragState,
    handleDragStartNode,
    handleDragOverNode,
    handleDragEnterNode,
    handleDragLeaveNode,
    handleDragEndNode,
    handleDropNode
  }
}
