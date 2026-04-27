import { createVNode, render } from 'vue'
import SimilarTracksDialog from './similarTracksDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type { ISongInfo } from 'src/types/globals'

export default (song: ISongInfo) => {
  return new Promise<void>((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const handleClose = () => {
      render(null, div)
      div.remove()
      resolve()
    }

    const vnode = createVNode(SimilarTracksDialog, {
      song,
      onClose: handleClose
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
