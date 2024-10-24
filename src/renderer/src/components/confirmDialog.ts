import { createVNode, render } from 'vue'
import confirmDialog from './confirmDialog.vue'

interface DialogOptions {
  title: string
  content: string[]
  confirmShow?: boolean
  textAlign?: string
  innerHeight?: number
  innerWidth?: number
}

export default (options: DialogOptions) => {
  return new Promise<string>((resolve, reject) => {
    const div = document.createElement('div')
    div.setAttribute('class', 'dialog')
    document.body.appendChild(div)

    const confirmCallback = () => {
      render(null, div)
      div.remove()
      resolve('confirm')
    }
    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }
    const vnode = createVNode(confirmDialog, {
      ...options,
      confirmCallback,
      cancelCallback
    })
    render(vnode, div)
  })
}
