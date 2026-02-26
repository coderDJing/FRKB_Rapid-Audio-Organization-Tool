import { computed, watch, type Ref } from 'vue'

interface UseLibraryFilterOptions {
  props: { filterText?: string | Record<string, any> }
  dirDataRef: Ref<any | null>
  dirChildRendered: { value: boolean }
  dirChildShow: { value: boolean }
}

export function useLibraryFilter({
  props,
  dirDataRef,
  dirChildRendered,
  dirChildShow
}: UseLibraryFilterOptions) {
  const getDirData = () => dirDataRef.value

  const keyword = computed(() =>
    String((props as any).filterText || '')
      .trim()
      .toLowerCase()
  )

  const matchesSelf = computed(() => {
    const dirData = getDirData()
    if (!dirData) return false
    if (!keyword.value) return true
    return (
      (dirData?.type === 'songList' || dirData?.type === 'mixtapeList') &&
      dirData?.dirName?.toLowerCase().includes(keyword.value)
    )
  })

  const hasMatchingDescendant = (node?: any): boolean => {
    if (!keyword.value) return true
    if (!node?.children) return false
    for (const c of node.children) {
      if (
        (c.type === 'songList' || c.type === 'mixtapeList') &&
        c.dirName?.toLowerCase().includes(keyword.value)
      )
        return true
      if (c.type === 'dir' && hasMatchingDescendant(c)) return true
    }
    return false
  }

  const shouldShow = computed(() => {
    const dirData = getDirData()
    if (!dirData) return false
    if (!keyword.value) return true
    return matchesSelf.value || hasMatchingDescendant(dirData)
  })

  watch(keyword, () => {
    const dirData = getDirData()
    if (!dirData) return
    if (!keyword.value) return
    if (dirData?.type === 'dir' && hasMatchingDescendant(dirData)) {
      dirChildRendered.value = true
      dirChildShow.value = true
    }
  })

  return {
    keyword,
    matchesSelf,
    shouldShow
  }
}
