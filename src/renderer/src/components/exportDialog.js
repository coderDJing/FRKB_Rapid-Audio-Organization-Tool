import { createVNode, render } from 'vue'
import exportDialog from './exportDialog.vue'

export default () => {
  return new Promise((resolve, reject) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = (data) => {
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
      confirmCallback,
      cancelCallback
    })
    render(vnode, div)
  })
}
