import { createVNode, render } from 'vue'
import ChoiceDialog from './choiceDialog.vue'

export interface ChoiceOption {
  key: string
  label: string
}

export default (options: {
  title?: string
  content?: string[]
  options: ChoiceOption[]
  innerHeight?: number
  innerWidth?: number
}): Promise<string> => {
  return new Promise<string>((resolve) => {
    const div = document.createElement('div')
    div.setAttribute('class', 'dialog')
    document.body.appendChild(div)

    const onSelect = (key: string) => {
      render(null, div)
      div.remove()
      resolve(key)
    }

    const vnode = createVNode(ChoiceDialog, {
      ...options,
      onSelect
    })
    render(vnode, div)
  })
}
