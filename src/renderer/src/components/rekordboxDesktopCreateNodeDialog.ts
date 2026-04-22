import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import RekordboxDesktopCreateNodeDialog from './rekordboxDesktopCreateNodeDialog.vue'

export default (params: {
  dialogTitle: string
  placeholder: string
  defaultValue?: string
  confirmText?: string
  confirmCallback: (value: string) => Promise<boolean>
}): Promise<'cancel' | 'confirm'> => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const handleClose = (result: 'cancel' | 'confirm') => {
      render(null, div)
      div.remove()
      resolve(result)
    }

    const vnode = createVNode(RekordboxDesktopCreateNodeDialog, {
      ...params,
      cancelCallback: () => handleClose('cancel'),
      closeCallback: () => handleClose('confirm')
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
