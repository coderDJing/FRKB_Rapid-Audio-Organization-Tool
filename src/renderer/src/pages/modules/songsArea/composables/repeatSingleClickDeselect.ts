const REPEAT_SINGLE_CLICK_DESELECT_DELAY_MS = 220

type RepeatSingleClickDeselectOptions = {
  getSelectedKeys: () => string[]
  setSelectedKeys: (keys: string[]) => void
}

export const createRepeatSingleClickDeselect = ({
  getSelectedKeys,
  setSelectedKeys
}: RepeatSingleClickDeselectOptions) => {
  let pendingDeselectTimer: ReturnType<typeof setTimeout> | null = null
  let pendingDeselectKey = ''

  const cancelPendingRepeatSingleClickDeselect = () => {
    if (pendingDeselectTimer) {
      clearTimeout(pendingDeselectTimer)
      pendingDeselectTimer = null
    }
    pendingDeselectKey = ''
  }

  const scheduleRepeatSingleClickDeselect = (rowKey: string) => {
    cancelPendingRepeatSingleClickDeselect()
    pendingDeselectKey = rowKey
    pendingDeselectTimer = setTimeout(() => {
      pendingDeselectTimer = null
      const selectedKeys = getSelectedKeys()
      if (selectedKeys.length === 1 && selectedKeys[0] === pendingDeselectKey) {
        setSelectedKeys([])
      }
      pendingDeselectKey = ''
    }, REPEAT_SINGLE_CLICK_DESELECT_DELAY_MS)
  }

  const handlePlainRowClickSelection = (event: MouseEvent, rowKey: string) => {
    if (event.detail > 1) {
      cancelPendingRepeatSingleClickDeselect()
      return
    }

    const selectedKeys = getSelectedKeys()
    if (selectedKeys.length === 1 && selectedKeys[0] === rowKey) {
      scheduleRepeatSingleClickDeselect(rowKey)
      return
    }

    cancelPendingRepeatSingleClickDeselect()
    setSelectedKeys([rowKey])
  }

  return {
    handlePlainRowClickSelection,
    cancelPendingRepeatSingleClickDeselect
  }
}
