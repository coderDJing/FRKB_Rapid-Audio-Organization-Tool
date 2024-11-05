import { createVNode, render } from 'vue'
import exportDialog from './exportDialog.vue'

export default ({
  title
}: {
  title: string
}): Promise<'cancel' | { folderPathVal: string; deleteSongsAfterExport: boolean }> => {
  return new Promise((resolve, reject) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = (data: { folderPathVal: string; deleteSongsAfterExport: boolean }) => {
      render(null, div)
      div.remove()
      resolve(data)
    }

    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }
    const vnode = createVNode(exportDialog, {
      title,
      confirmCallback,
      cancelCallback
    })
    render(vnode, div)
  })
}
