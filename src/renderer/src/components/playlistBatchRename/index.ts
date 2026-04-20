import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import PlaylistBatchRenameDialog from './PlaylistBatchRenameDialog.vue'
import openPreviewDialog from './previewDialog'
import type { IBatchRenamePreviewResult } from 'src/types/globals'

export interface BatchRenameSongListTarget {
  uuid: string
  path: string
  name: string
}

export default (options: {
  title: string
  songLists: BatchRenameSongListTarget[]
}): Promise<void> =>
  new Promise<void>((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const handleClose = () => {
      render(null, div)
      div.remove()
      resolve()
    }

    const handleProceed = async (payload: IBatchRenamePreviewResult) => {
      render(null, div)
      div.remove()
      await openPreviewDialog({
        title: options.title,
        items: Array.isArray(payload?.items) ? payload.items : []
      })
      resolve()
    }

    const vnode = createVNode(PlaylistBatchRenameDialog, {
      title: options.title,
      songLists: options.songLists,
      onClose: handleClose,
      onProceed: handleProceed
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
