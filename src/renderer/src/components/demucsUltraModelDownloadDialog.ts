import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import DemucsUltraModelDownloadDialog from './demucsUltraModelDownloadDialog.vue'

type OpenDemucsUltraModelDownloadDialogArgs = {
  initialInfo?: unknown
}

export default (args: OpenDemucsUltraModelDownloadDialogArgs = {}) =>
  new Promise<boolean>((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let ready = false
    const close = () => {
      render(null, container)
      container.remove()
      resolve(ready)
    }
    const vnode = createVNode(DemucsUltraModelDownloadDialog, {
      initialInfo: args.initialInfo,
      onReady: () => {
        ready = true
      },
      onClose: close
    })
    attachAppContext(vnode)
    render(vnode, container)
  })
