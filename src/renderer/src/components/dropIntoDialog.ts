import { createVNode, render } from 'vue'
import dropIntoDialog from './dropIntoDialog.vue'
import { IImportSongsFormData } from 'src/types/globals'

interface IArgs {
  songListUuid: string
  libraryName: string
}

export default ({ songListUuid, libraryName }: IArgs) => {
  return new Promise((resolve, reject) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = (result: IImportSongsFormData) => {
      render(null, div)
      div.remove()
      resolve(result)
    }

    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }
    const vnode = createVNode(dropIntoDialog, {
      songListUuid,
      libraryName,
      confirmCallback,
      cancelCallback
    })
    render(vnode, div)
  })
}
