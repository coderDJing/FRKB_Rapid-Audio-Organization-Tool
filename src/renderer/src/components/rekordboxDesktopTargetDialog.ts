import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import RekordboxDesktopTargetDialog from './rekordboxDesktopTargetDialog.vue'
import type { RekordboxDesktopPlaylistWriteTarget } from '@shared/rekordboxDesktopPlaylist'

export type RekordboxDesktopTargetDialogResult =
  | 'cancel'
  | {
      target: RekordboxDesktopPlaylistWriteTarget
    }

export default (params: {
  dialogTitle: string
  defaultPlaylistName: string
  trackCount?: number
}): Promise<RekordboxDesktopTargetDialogResult> => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = (payload: Exclude<RekordboxDesktopTargetDialogResult, 'cancel'>) => {
      render(null, div)
      div.remove()
      resolve(payload)
    }

    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }

    const vnode = createVNode(RekordboxDesktopTargetDialog, {
      ...params,
      confirmCallback,
      cancelCallback
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
