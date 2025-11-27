import { createVNode, render } from 'vue'
import musicBrainzDialog from './musicBrainzDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type { IMusicBrainzApplyPayload } from 'src/types/globals'

export interface MusicBrainzDialogInitialQuery {
  title?: string
  artist?: string
  album?: string
  durationSeconds?: number
  isrc?: string
}

export default ({
  filePath,
  initialQuery
}: {
  filePath: string
  initialQuery?: MusicBrainzDialogInitialQuery
}): Promise<'cancel' | { payload: IMusicBrainzApplyPayload }> => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = (data: { payload: IMusicBrainzApplyPayload }) => {
      render(null, div)
      div.remove()
      resolve(data)
    }

    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }

    const vnode = createVNode(musicBrainzDialog, {
      filePath,
      initialQuery,
      confirmCallback,
      cancelCallback
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
