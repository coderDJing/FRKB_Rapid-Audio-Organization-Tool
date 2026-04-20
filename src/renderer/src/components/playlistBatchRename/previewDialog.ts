import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import PreviewDialog from './PreviewDialog.vue'
import type { IBatchRenamePreviewItem } from 'src/types/globals'

export default (options: { title: string; items: IBatchRenamePreviewItem[] }) =>
  new Promise<void>((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const onClose = () => {
      render(null, div)
      div.remove()
      resolve()
    }

    const vnode = createVNode(PreviewDialog, {
      title: options.title,
      items: options.items,
      onClose
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
