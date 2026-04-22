import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import RekordboxDesktopStorageDirDialog from './rekordboxDesktopStorageDirDialog.vue'

export default (params?: { initialPath?: string }): Promise<string | 'cancel'> => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const handleClose = (result: string | 'cancel') => {
      render(null, div)
      div.remove()
      resolve(result)
    }

    const vnode = createVNode(RekordboxDesktopStorageDirDialog, {
      initialPath: params?.initialPath || '',
      confirmCallback: (path: string) => handleClose(path),
      cancelCallback: () => handleClose('cancel')
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
