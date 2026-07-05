import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import SelectSongListDialog from './selectSongListDialog.vue'
import type {
  LibraryTransferActionMode,
  LibraryTransferTarget
} from '@renderer/utils/libraryTransfer'

type SelectSongListDialogResult = 'cancel' | { uuid: string }

export default (params: {
  libraryName: LibraryTransferTarget
  actionMode?: LibraryTransferActionMode
}): Promise<SelectSongListDialogResult> => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const cleanup = () => {
      render(null, div)
      div.remove()
    }

    const confirmCallback = (uuid: string) => {
      cleanup()
      resolve({ uuid })
    }

    const cancelCallback = () => {
      cleanup()
      resolve('cancel')
    }

    const vnode = createVNode(SelectSongListDialog, {
      libraryName: params.libraryName,
      actionMode: params.actionMode || 'move',
      onConfirm: confirmCallback,
      onCancel: cancelCallback
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
