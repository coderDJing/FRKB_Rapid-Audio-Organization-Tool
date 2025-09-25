import { computed, ref, type ShallowRef } from 'vue'
import type { ISongInfo, ISongsAreaColumn } from '../../../../../../types/globals'
import { MIN_WIDTH_BY_KEY } from '../minWidth'
import type { useRuntimeStore } from '@renderer/stores/runtime'

interface UseSongsAreaColumnsParams {
  runtime: ReturnType<typeof useRuntimeStore>
  originalSongInfoArr: ShallowRef<ISongInfo[]>
}

export function useSongsAreaColumns(params: UseSongsAreaColumnsParams) {
  const { runtime, originalSongInfoArr } = params

  // 统一额外初始宽度：在最小值基础上增加 40
  const INIT_EXTRA_WIDTH = 40

  // 基础列定义（不包含 width），避免写死无意义的宽度数字
  const baseColumns: Omit<ISongsAreaColumn, 'width'>[] = [
    { columnName: 'columns.cover', key: 'cover', show: true },
    { columnName: 'columns.index', key: 'index', show: true },
    { columnName: 'columns.title', key: 'title', show: true, filterType: 'text' },
    {
      columnName: 'columns.artist',
      key: 'artist',
      show: true,
      filterType: 'text',
      order: 'asc'
    },
    { columnName: 'columns.duration', key: 'duration', show: true, filterType: 'duration' },
    { columnName: 'columns.album', key: 'album', show: true, filterType: 'text' },
    { columnName: 'columns.genre', key: 'genre', show: true, filterType: 'text' },
    { columnName: 'columns.label', key: 'label', show: true, filterType: 'text' },
    { columnName: 'columns.bitrate', key: 'bitrate', show: true },
    { columnName: 'columns.format', key: 'container', show: true, filterType: 'text' }
  ]

  // 通过最小宽度映射 + 40 生成实际的默认列（带 width）
  const defaultColumns: ISongsAreaColumn[] = baseColumns.map((col) => ({
    ...col,
    width: (MIN_WIDTH_BY_KEY[col.key] ?? 0) + INIT_EXTRA_WIDTH
  }))

  const columnData = ref<ISongsAreaColumn[]>(
    (() => {
      const savedData = localStorage.getItem('songColumnData')
      let finalColumns: ISongsAreaColumn[]

      if (!savedData) {
        finalColumns = JSON.parse(JSON.stringify(defaultColumns))
      } else {
        try {
          const parsedSavedColumns: ISongsAreaColumn[] = JSON.parse(savedData)
          const defaultColumnsMap = new Map(defaultColumns.map((col) => [col.key, col]))

          finalColumns = parsedSavedColumns
            .map((savedCol) => {
              const defaultCol = defaultColumnsMap.get(savedCol.key)
              if (defaultCol) {
                const mergedCol = {
                  ...defaultCol,
                  show: savedCol.show !== undefined ? savedCol.show : defaultCol.show,
                  width: savedCol.width !== undefined ? savedCol.width : defaultCol.width,
                  order: (Object.prototype.hasOwnProperty.call(savedCol, 'order')
                    ? savedCol.order
                    : undefined) as ISongsAreaColumn['order'],
                  key: defaultCol.key,
                  columnName: defaultCol.columnName,
                  filterType: defaultCol.filterType,
                  filterActive:
                    (runtime.setting.persistSongFilters ? savedCol.filterActive : false) ?? false,
                  filterValue: runtime.setting.persistSongFilters
                    ? savedCol.filterValue
                    : undefined,
                  filterOp: runtime.setting.persistSongFilters ? savedCol.filterOp : undefined,
                  filterDuration: runtime.setting.persistSongFilters
                    ? savedCol.filterDuration
                    : undefined
                }
                return mergedCol
              }
              return null
            })
            .filter((col) => col !== null) as ISongsAreaColumn[]

          defaultColumns.forEach((defaultCol) => {
            if (!finalColumns.some((fc) => fc.key === defaultCol.key)) {
              finalColumns.push(JSON.parse(JSON.stringify(defaultCol)))
            }
          })

          finalColumns = finalColumns.filter((fc) => defaultColumnsMap.has(fc.key))
        } catch (error) {
          console.error('解析本地存储的 songColumnData 出错，使用默认列配置:', error)
          finalColumns = JSON.parse(JSON.stringify(defaultColumns))
        }
      }

      const hasOrderAfterMerge = finalColumns.some((col) => col.order !== undefined)
      if (!hasOrderAfterMerge) {
        const durationColIndex = finalColumns.findIndex((col) => col.key === 'duration')
        if (durationColIndex !== -1) {
          finalColumns[durationColIndex] = { ...finalColumns[durationColIndex], order: 'asc' }
        } else {
          const titleColIndex = finalColumns.findIndex((col) => col.key === 'title')
          if (titleColIndex !== -1) {
            finalColumns[titleColIndex] = { ...finalColumns[titleColIndex], order: 'asc' }
          }
        }
      }

      finalColumns = finalColumns.map((col) => {
        const minWidth = MIN_WIDTH_BY_KEY[col.key] ?? col.width
        if (col.width < minWidth) {
          return { ...col, width: minWidth }
        }
        return col
      })

      return finalColumns
    })()
  )

  // --- 工具 ---
  function sortArrayByProperty<T>(
    array: T[],
    property: keyof T,
    order: 'asc' | 'desc' = 'asc'
  ): T[] {
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
    return [...array].sort((a, b) => {
      const valueA = String((a as any)[property] || '')
      const valueB = String((b as any)[property] || '')
      return order === 'asc' ? collator.compare(valueA, valueB) : collator.compare(valueB, valueA)
    })
  }

  function parseDurationToSeconds(mmss: string): number {
    if (!mmss || typeof mmss !== 'string') return NaN
    const parts = mmss.split(':')
    if (parts.length !== 2) return NaN
    const m = Number(parts[0])
    const s = Number(parts[1])
    if (Number.isNaN(m) || Number.isNaN(s)) return NaN
    return m * 60 + s
  }

  // --- 持久化 ---
  const persistColumnData = () => {
    localStorage.setItem('songColumnData', JSON.stringify(columnData.value))
  }

  // --- 根据列筛选过滤并按当前排序排序 ---
  function applyFiltersAndSorting() {
    let filtered = [...originalSongInfoArr.value]

    for (const col of columnData.value) {
      if (!col.filterActive) continue
      if (col.filterType === 'text' && col.filterValue && col.key) {
        const keyword = String(col.filterValue).toLowerCase()
        filtered = filtered.filter((song) => {
          const value = String((song as any)[col.key] ?? '').toLowerCase()
          return value.includes(keyword)
        })
      } else if (col.filterType === 'duration' && col.filterOp && col.filterDuration) {
        const target = parseDurationToSeconds(col.filterDuration)
        filtered = filtered.filter((song) => {
          const dur = parseDurationToSeconds(String((song as any)['duration'] ?? ''))
          if (Number.isNaN(dur) || Number.isNaN(target)) return false
          if (col.filterOp === 'eq') return dur === target
          if (col.filterOp === 'gte') return dur >= target
          if (col.filterOp === 'lte') return dur <= target
          return true
        })
      }
    }

    const sortedCol = columnData.value.find((c) => c.order)
    if (sortedCol) {
      filtered = sortArrayByProperty<ISongInfo>(
        filtered,
        sortedCol.key as keyof ISongInfo,
        sortedCol.order!
      )
    }

    runtime.songsArea.songInfoArr = filtered
  }

  // --- 列更新 ---
  const handleColumnsUpdate = (newColumns: ISongsAreaColumn[]) => {
    columnData.value = newColumns
    persistColumnData()
    applyFiltersAndSorting()
    runtime.songsArea.selectedSongFilePath.length = 0
  }

  // --- 右键菜单与可见性切换 ---
  const colRightClickMenuShow = ref(false)
  const triggeringColContextEvent = ref<MouseEvent | null>(null)
  const contextmenuEvent = (event: MouseEvent) => {
    triggeringColContextEvent.value = event
    colRightClickMenuShow.value = true
  }

  const handleToggleColumnVisibility = (columnKey: string) => {
    const columnIndex = columnData.value.findIndex((col) => col.key === columnKey)
    if (columnIndex !== -1) {
      const newColumns = columnData.value.map((col, index) => {
        if (index === columnIndex) {
          return { ...col, show: !col.show }
        }
        return col
      })
      columnData.value = newColumns
      persistColumnData()
    }
  }

  // --- 列头排序点击 ---
  const colMenuClick = (col: ISongsAreaColumn) => {
    if (col.key === 'index' || col.key === 'cover') return

    const newColumnData = columnData.value.map((item) => {
      if (item.key !== col.key) {
        return { ...item, order: undefined }
      }
      const newOrderForItem = item.order === 'asc' ? 'desc' : item.order === 'desc' ? 'asc' : 'asc'
      return { ...item, order: newOrderForItem as 'asc' | 'desc' }
    })
    columnData.value = newColumnData.map((c) =>
      c.key === 'cover' ? { ...c, order: undefined } : c
    )
    persistColumnData()
    applyFiltersAndSorting()

    if (runtime.playingData.playingSongListUUID === runtime.songsArea.songListUUID) {
      runtime.playingData.playingSongListData = runtime.songsArea.songInfoArr
    }
  }

  const columnDataArr = computed(() => columnData.value.filter((item) => item.show))

  const totalColumnsWidth = computed(() => {
    if (!columnDataArr.value || columnDataArr.value.length === 0) return 0
    return columnDataArr.value.reduce((sum, col) => sum + (col.width || 0), 0)
  })

  return {
    columnData,
    columnDataArr,
    totalColumnsWidth,
    colRightClickMenuShow,
    triggeringColContextEvent,
    contextmenuEvent,
    handleToggleColumnVisibility,
    handleColumnsUpdate,
    colMenuClick,
    applyFiltersAndSorting
  }
}
