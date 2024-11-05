import { createVNode, render } from 'vue'
import globalCallShortcutDialog from './globalCallShortcutDialog'

export default () => {
  return new Promise((resolve, reject) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = () => {
      render(null, div)
      div.remove()
      resolve('success')
    }

    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }
    const vnode = createVNode(globalCallShortcutDialog, {
      confirmCallback,
      cancelCallback
    })
    render(vnode, div)
  })
}
