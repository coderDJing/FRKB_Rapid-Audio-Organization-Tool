import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import PresetManagerDialog from './PresetManagerDialog.vue'
import type { BatchRenameSongListTarget } from './index'
import type { IBatchRenameTrackInput } from 'src/types/globals'

export default (options: {
  title: string
  songLists: BatchRenameSongListTarget[]
  tracks?: IBatchRenameTrackInput[]
  selectedPresetId?: string
}): Promise<string | null> =>
  new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const onClose = (presetId?: string | null) => {
      render(null, div)
      div.remove()
      resolve(typeof presetId === 'string' ? presetId : null)
    }

    const vnode = createVNode(PresetManagerDialog, {
      title: options.title,
      songLists: options.songLists,
      tracks: options.tracks || [],
      selectedPresetId: options.selectedPresetId || '',
      onClose
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
