import { createVNode, render } from 'vue'
import CuratedArtistLibraryDialog from './curatedArtistLibraryDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type { ICuratedArtistFavorite } from 'src/types/globals'

export default (artists: ICuratedArtistFavorite[] = []) => {
  return new Promise<ICuratedArtistFavorite[] | 'cancel'>((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const confirmCallback = (nextArtists: ICuratedArtistFavorite[]) => {
      render(null, div)
      div.remove()
      resolve(nextArtists)
    }

    const cancelCallback = () => {
      render(null, div)
      div.remove()
      resolve('cancel')
    }

    const vnode = createVNode(CuratedArtistLibraryDialog, {
      artists,
      confirmCallback,
      cancelCallback
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}
