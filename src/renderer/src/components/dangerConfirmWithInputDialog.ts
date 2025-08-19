import { createVNode, render } from 'vue'
import DangerConfirm from './dangerConfirmWithInputDialog.vue'

interface DangerConfirmOptions {
  title: string
  description: string
  confirmKeyword?: string
  placeholder?: string
  innerHeight?: number
  innerWidth?: number
}

export default (options: DangerConfirmOptions) => {
  return new Promise<{ text: string } | 'cancel'>((resolve) => {
    const div = document.createElement('div')
    div.setAttribute('class', 'dialog')
    document.body.appendChild(div)

    const onConfirm = (payload: { text: string }) => {
      render(null, div)
      div.remove()
      resolve(payload)
    }
    const onCancel = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }

    const vnode = createVNode(DangerConfirm, {
      ...options,
      onConfirm,
      onCancel
    })
    render(vnode, div)
  })
}
