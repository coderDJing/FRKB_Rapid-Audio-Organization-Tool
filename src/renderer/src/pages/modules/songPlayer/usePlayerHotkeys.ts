import { onMounted, onUnmounted, Ref, ref } from 'vue'
import hotkeys, { KeyHandler } from 'hotkeys-js'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'

// 使用 ReturnType 获取 useRuntimeStore 的返回类型，模拟 Store 类型
type RuntimeStoreType = ReturnType<typeof useRuntimeStore>

// 定义传递给 Composable 的参数类型
interface PlayerActions {
  play: () => void
  pause: () => void
  fastForward: () => void
  fastBackward: () => void
  nextSong: () => void
  previousSong: () => void
  delSong: () => void // 改回同步，因为 KeyHandler 不支持 async
  moveToListLibrary: () => void
  moveToLikeLibrary: () => void
  // 可以添加一个 togglePlayPause 方法来简化 space 键处理
  togglePlayPause?: () => void
}

interface PlayerState {
  waveformShow: Ref<boolean>
  selectSongListDialogShow: Ref<boolean>
  // showDelConfirm: Ref<boolean> // 这个状态由 hotkey 内部管理似乎更合适
  confirmShow: Readonly<Ref<boolean>> // 从 runtime store 获取，设为只读
  songsAreaSelectedCount: Readonly<Ref<number>> // 从 runtime store 获取
  activeMenuUUID: { value: string } // 从 runtime store 获取，允许修改
  isPlaying?: Readonly<Ref<boolean>> // 可选：传入播放状态以优化 space 键
}

export function usePlayerHotkeys(
  actions: PlayerActions,
  state: PlayerState,
  runtime: RuntimeStoreType // 传递 runtime store 实例
) {
  // 将 showDelConfirm 的管理移到内部，因为它是快捷键触发的副作用
  const internalShowDelConfirm = ref(false)

  const setupHotkeys = () => {
    const scope = 'windowGlobal' // 定义快捷键作用域

    const spaceHandler: KeyHandler = (event) => {
      event.preventDefault()
      if (!state.waveformShow.value) {
        return
      }
      if (actions.togglePlayPause) {
        actions.togglePlayPause()
      } else if (state.isPlaying) {
        if (state.isPlaying.value) {
          actions.pause()
        } else {
          actions.play()
        }
      } else {
        // 降级处理：如果既没有 togglePlayPause 也没有 isPlaying
        // 这种方式可能不准确，因为 play/pause 内部可能有自己的逻辑
        actions.pause() // 尝试暂停
        actions.play() // 尝试播放
      }
    }
    hotkeys('space', scope, spaceHandler)

    hotkeys('d,right', scope, (event) => {
      event.preventDefault()
      if (!state.waveformShow.value) {
        return
      }
      actions.fastForward()
    })

    // 移除对快进抑制状态的依赖（改由 playerReady 门槛控制）

    hotkeys('a,left', scope, (event) => {
      event.preventDefault()
      if (!state.waveformShow.value) {
        return
      }
      actions.fastBackward()
    })

    hotkeys('s,down', scope, (event) => {
      event.preventDefault()
      if (!state.waveformShow.value || state.selectSongListDialogShow.value) {
        return
      }
      actions.nextSong()
    })

    hotkeys('w,up', scope, (event) => {
      event.preventDefault()
      if (!state.waveformShow.value || state.selectSongListDialogShow.value) {
        return
      }
      actions.previousSong()
    })

    hotkeys('r', scope, (event) => {
      event.preventDefault()
      if (!state.waveformShow.value || state.selectSongListDialogShow.value) {
        return
      }
      runtime.setting.enablePlaybackRange = !runtime.setting.enablePlaybackRange
      window.electron.ipcRenderer.invoke('setSetting', JSON.parse(JSON.stringify(runtime.setting)))
    })

    const deleteHandler: KeyHandler = (event, handler) => {
      event.preventDefault()
      if (!state.waveformShow.value) {
        return
      }
      // 检查是否是 Delete 键触发，并且歌曲列表区有选中的歌曲
      if (handler.key === 'delete' && state.songsAreaSelectedCount.value > 0) {
        return // 如果列表区有选中，则此快捷键不响应，让列表区的删除逻辑处理
      }
      // 防止重复触发确认框
      if (internalShowDelConfirm.value || state.confirmShow.value) {
        return
      }

      // 重置活动菜单（如果需要）
      state.activeMenuUUID.value = ''

      internalShowDelConfirm.value = true // 标记开始处理
      // 调用 delSong，它是异步的，但我们在这里不 await 它
      // 注意：这意味着 internalShowDelConfirm 可能在 delSong 完成前就变回 false
      // 如果需要精确控制，delSong 需要提供回调或返回 Promise 让这里能处理
      actions.delSong()
      // 兜底：触发一次歌单内容变更事件，确保徽标数量刷新
      try {
        const uid = (runtime as any).playingData?.playingSongListUUID
        if (uid) {
          emitter.emit('playlistContentChanged', { uuids: [uid] })
        }
      } catch {}
      // 立即或稍后重置标记，取决于 delSong 的行为
      // 简单的处理是假设 delSong 会处理后续状态
      internalShowDelConfirm.value = false // 暂时立即重置
    }
    hotkeys('f,delete', scope, deleteHandler)

    hotkeys('q', scope, (event) => {
      event.preventDefault()
      if (!state.waveformShow.value || state.selectSongListDialogShow.value) {
        return
      }
      actions.moveToListLibrary()
    })

    hotkeys('e', scope, (event) => {
      event.preventDefault()
      if (!state.waveformShow.value || state.selectSongListDialogShow.value) {
        return
      }
      actions.moveToLikeLibrary()
    })
  }

  const cleanupHotkeys = () => {
    // 精确解绑在此处绑定的快捷键和作用域
    hotkeys.unbind('space', 'windowGlobal')
    hotkeys.unbind('d,right', 'windowGlobal')
    hotkeys.unbind('a,left', 'windowGlobal')
    hotkeys.unbind('s,down', 'windowGlobal')
    hotkeys.unbind('w,up', 'windowGlobal')
    hotkeys.unbind('f,delete', 'windowGlobal')
    hotkeys.unbind('q', 'windowGlobal')
    hotkeys.unbind('e', 'windowGlobal')
  }

  onMounted(() => {
    setupHotkeys()
  })

  onUnmounted(() => {
    cleanupHotkeys()
  })

  // 返回内部状态或方法（如果需要的话）
  // return { internalShowDelConfirm }
}
