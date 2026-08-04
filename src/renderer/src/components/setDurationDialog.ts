import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import SetDurationDialog from './setDurationDialog.vue'
import type { ISongInfo } from 'src/types/globals'

export default (songs: ISongInfo[]) =>
  new Promise<void>((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const close = () => {
      render(null, container)
      container.remove()
      resolve()
    }

    const vnode = createVNode(SetDurationDialog, { songs, onClose: close })
    attachAppContext(vnode)
    render(vnode, container)
  })
