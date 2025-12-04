import { computed, watch } from 'vue'

interface UseLibraryFilterOptions {
  props: { filterText?: string | Record<string, any> }
  dirData: any
  dirChildRendered: { value: boolean }
  dirChildShow: { value: boolean }
}

export function useLibraryFilter({
  props,
  dirData,
  dirChildRendered,
  dirChildShow
}: UseLibraryFilterOptions) {
  const keyword = computed(() =>
    String((props as any).filterText || '')
      .trim()
      .toLowerCase()
  )

  const matchesSelf = computed(() => {
    if (!keyword.value) return true
    return dirData?.type === 'songList' && dirData?.dirName?.toLowerCase().includes(keyword.value)
  })

  const hasMatchingDescendant = (node?: any): boolean => {
    if (!keyword.value) return true
    if (!node?.children) return false
    for (const c of node.children) {
      if (c.type === 'songList' && c.dirName?.toLowerCase().includes(keyword.value)) return true
      if (c.type === 'dir' && hasMatchingDescendant(c)) return true
    }
    return false
  }

  const shouldShow = computed(() => {
    if (!keyword.value) return true
    return matchesSelf.value || hasMatchingDescendant(dirData)
  })

  watch(keyword, () => {
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
