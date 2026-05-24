import { markRaw } from 'vue'
import type { ComponentPublicInstance } from 'vue'

const resolveHTMLElement = (el: Element | ComponentPublicInstance | null) => {
  if (el && typeof (el as ComponentPublicInstance).$el !== 'undefined') {
    return ((el as ComponentPublicInstance).$el || null) as Element | null
  }
  return el as Element | null
}

export const useSongRowRefs = () => {
  const cellRefMap = markRaw({} as Record<string, HTMLElement | null>)
  const coverCellRefMap = markRaw(new Map<string, HTMLElement | null>())

  const setCellRef = (key: string, el: Element | ComponentPublicInstance | null) => {
    const dom = resolveHTMLElement(el) as HTMLElement | null
    cellRefMap[key] = dom
  }

  const setCoverCellRef = (filePath: string, el: Element | ComponentPublicInstance | null) => {
    const dom = resolveHTMLElement(el) as HTMLElement | null
    if (dom) {
      coverCellRefMap.set(filePath, dom)
    } else {
      coverCellRefMap.delete(filePath)
    }
  }

  return {
    cellRefMap,
    coverCellRefMap,
    setCellRef,
    setCoverCellRef
  }
}
