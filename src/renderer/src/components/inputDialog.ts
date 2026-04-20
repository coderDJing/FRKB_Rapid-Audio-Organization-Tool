import { createVNode, render } from 'vue'
import InputDialog from './InputDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'

export default (options: {
  title: string
  value?: string
  placeholder?: string
  confirmText?: string
}): Promise<string | 'cancel'> =>
  new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const onConfirm = (value: string) => {
      render(null, div)
      div.remove()
      resolve(value)
    }

    const onCancel = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }

    const vnode = createVNode(InputDialog, {
      ...options,
      onConfirm,
      onCancel
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
