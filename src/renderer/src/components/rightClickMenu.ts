import { createVNode, render } from 'vue'
import rightClickMenu from './rightClickMenu'
import { IMenu } from 'src/types/globals'

interface IArgs {
  menuArr: IMenu[][]
  clickEvent: MouseEvent
}
export default ({ menuArr, clickEvent }: IArgs): Promise<IMenu | 'cancel'> => {
  return new Promise((resolve, reject) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = (item: IMenu) => {
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
