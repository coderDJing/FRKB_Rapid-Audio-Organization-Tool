import { createVNode, render } from 'vue'
import rightClickMenu from './rightClickMenu.vue'

export default ({ menuArr, clickEvent }) => {
  return new Promise((resolve, reject) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = (item) => {
      render(null, div)
      div.remove()
      resolve(item)
    }

    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }
    const vnode = createVNode(rightClickMenu, {
      menuArr,
      clickEvent,
      confirmCallback,
      cancelCallback
    })
    render(vnode, div)
  })
}
