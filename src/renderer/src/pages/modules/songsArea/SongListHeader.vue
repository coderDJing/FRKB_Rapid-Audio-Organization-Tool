<script setup lang="ts">
import { ref, computed, PropType, watch } from 'vue'
import { ISongsAreaColumn } from '../../../../../types/globals' // Corrected path
import { UseDraggableOptions, vDraggable } from 'vue-draggable-plus'

// 类型定义
type VDraggableBinding = [list: ISongsAreaColumn[], options?: UseDraggableOptions<ISongsAreaColumn>]

// Props
const props = defineProps({
  columns: {
    type: Array as PropType<ISongsAreaColumn[]>,
    required: true
  },
  t: {
    type: Function as PropType<(key: string) => string>,
    required: true
  },
  ascendingOrder: {
    type: String,
    required: true
  },
  descendingOrder: {
    type: String,
    required: true
  },
  totalWidth: {
    type: Number,
    required: true
  }
})

// Emits
const emit = defineEmits<{
  (e: 'update:columns', value: ISongsAreaColumn[]): void
  (e: 'column-click', column: ISongsAreaColumn): void
  (e: 'header-contextmenu', event: MouseEvent): void
  (e: 'drag-start'): void
  (e: 'drag-end'): void
}>()

// 创建一个 ref 来存储可见的、可拖拽的列
const draggableVisibleColumns = ref<ISongsAreaColumn[]>([])
const draggableInstanceKey = ref(0) // 新增：用于强制重新渲染 draggable 容器的 key

// 监听 props.columns 的变化，以更新 draggableVisibleColumns
watch(
  () => props.columns,
  (newFullColumns) => {
    draggableVisibleColumns.value = newFullColumns.filter((item) => item.show)
    draggableInstanceKey.value++ // 关键：当可见列数据源可能改变实例时，更新 key
  },
  { immediate: true, deep: true } // immediate 确保初始加载，deep 监听 show 属性等变化
)

// 列宽调整逻辑
let startX = 0
let resizingColInternal: ISongsAreaColumn | null = null // 使用 internal 后缀避免与 props 中的命名冲突
let isResizing = false
let initWidth = 0
const isResizeClick = ref(false) // 用于防止调整大小时触发单击

const startResize = (e: MouseEvent, col: ISongsAreaColumn) => {
  if (col.key === 'coverUrl') {
    return
  }
  e.stopPropagation()
  e.preventDefault()
  isResizing = true
  isResizeClick.value = true
  startX = e.clientX
  resizingColInternal = col
  initWidth = col.width
  document.addEventListener('mousemove', resize)
  document.addEventListener('mouseup', stopResize)
}

const resize = (e: MouseEvent) => {
  e.stopPropagation()
  e.preventDefault()
  if (!isResizing || !resizingColInternal) return
  const deltaX = e.clientX - startX
  const newWidth = Math.max(50, initWidth + deltaX) // 设置最小宽度

  // 直接修改列对象（它是 props.columns 中的一个引用）的宽度
  // vue-draggable-plus 也期望直接操作这个数组
  resizingColInternal.width = newWidth
  // 调整大小时，不需要立即发出 update:columns，因为拖拽库可能在操作同一个数组
  // stopResize 时会统一发出
}

const stopResize = (e: MouseEvent) => {
  e.stopPropagation()
  e.preventDefault()
  if (!isResizing) return
  isResizing = false
  document.removeEventListener('mousemove', resize)
  document.removeEventListener('mouseup', stopResize)

  // 在调整大小结束后，发出 columns 更新事件
  // 使用 [...props.columns] 创建一个新数组的浅拷贝以触发父组件的响应性
  emit('update:columns', [...props.columns])

  setTimeout(() => {
    isResizeClick.value = false
  }, 0)
}

// 拖拽逻辑
const onStartDraggable = () => {
  emit('drag-start')
}

const onEndDraggable = () => {
  // v-draggable 的 onUpdate 会在顺序改变后调用，那里会 emit('update:columns')
  // onEnd 主要用于清理拖拽状态
  emit('drag-end')
}

// v-draggable 的数据和选项
// vue-draggable-plus 会直接修改传入的 list (即 draggableVisibleColumns.value)
const vDraggableData = computed<VDraggableBinding>(() => [
  draggableVisibleColumns.value, // 将 draggableVisibleColumns.value 直接传递给 v-draggable
  {
    animation: 150,
    direction: 'horizontal',
    onUpdate: () => {
      // 当列顺序通过拖拽更新后 (draggableVisibleColumns.value 已被修改)
      // 我们需要根据 draggableVisibleColumns.value (新的可见列顺序)
      // 和 props.columns (原始完整列表，用于获取隐藏列)
      // 来重建完整的列顺序
      const newOrderedVisibleColumns = draggableVisibleColumns.value
      const reconstructedFullList: ISongsAreaColumn[] = []
      let currentVisibleIdx = 0

      for (const originalCol of props.columns) {
        if (originalCol.show) {
          // 这个 "槽位" 在原始结构中是给可见列的
          // 用 newOrderedVisibleColumns 中的下一个列来填充它
          if (currentVisibleIdx < newOrderedVisibleColumns.length) {
            reconstructedFullList.push(newOrderedVisibleColumns[currentVisibleIdx])
            currentVisibleIdx++
          } else {
          }
        } else {
          // 这个 "槽位" 是给隐藏列的，保留它
          reconstructedFullList.push(originalCol)
        }
      }
      emit('update:columns', reconstructedFullList)
    },
    onStart: onStartDraggable,
    onEnd: onEndDraggable
  }
])

// 处理列头点击事件（用于排序）
const handleColumnClick = (col: ISongsAreaColumn) => {
  if (isResizeClick.value) {
    return // 如果正在调整大小（或刚刚调整完），则不触发点击
  }
  emit('column-click', col)
}

// 处理表头区域的右键菜单事件
const handleContextMenu = (event: MouseEvent) => {
  emit('header-contextmenu', event)
}
</script>

<template>
  <div
    @contextmenu.stop="handleContextMenu"
    class="songListHeader songItem lightBackground"
    :style="{
      position: 'sticky',
      top: '0',
      'z-index': '10',
      'background-color': '#191919',
      'border-bottom': '1px solid #2b2b2b',
      'min-width': totalWidth + 'px'
    }"
    :key="draggableInstanceKey"
    v-draggable="vDraggableData"
  >
    <div
      class="unselectable header-column"
      v-for="col of draggableVisibleColumns"
      :key="col.key"
      :class="[
        'lightBackground',
        { coverDiv: col.key == 'coverUrl', titleDiv: col.key != 'coverUrl' }
      ]"
      :style="'width:' + col.width + 'px'"
      style="padding-left: 10px; box-sizing: border-box; display: flex; align-items: center"
      @click="handleColumnClick(col)"
    >
      <div style="flex-grow: 1; overflow: hidden; display: flex; align-items: center">
        <div
          style="white-space: nowrap; display: flex; align-items: center"
          :style="{ color: col.order ? '#0078d4' : '#cccccc' }"
        >
          {{ t(col.columnName) }}
          <img
            v-if="col.order === 'asc'"
            :src="ascendingOrder"
            style="width: 20px; height: 20px; margin-left: 4px"
          />
          <img
            v-if="col.order === 'desc'"
            :src="descendingOrder"
            style="width: 20px; height: 20px; margin-left: 4px"
          />
        </div>
      </div>
      <div
        v-if="col.key !== 'coverUrl'"
        class="resize-handle"
        style="width: 5px; cursor: e-resize; flex-shrink: 0; height: 100%"
        @mousedown.stop="startResize($event, col)"
      ></div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 从 songsArea.vue 迁移并调整的相关样式 */
.songListHeader {
  // 主容器特定类名
  height: 30px;
  display: flex;
  font-size: 14px;
}

.header-column {
  // 表头中的每一列
  flex-shrink: 0;
  /* 确保列不会收缩 */
  /* 其他通过 :class 和 :style 动态应用 */
}

.lightBackground {
  background-color: #191919;
}

/* coverDiv 和 titleDiv 的基础样式 */
.coverDiv,
.titleDiv {
  height: 100%;
  /* 占满父容器高度 */
  box-sizing: border-box;
  border-right: 1px solid #2b2b2b;
  /* padding-left 和其他在 template 中通过 style 属性设置 */
}

.titleDiv {
  /* white-space 和 overflow 由内部 div 控制 */
}

.unselectable {
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
}

.resize-handle {
  /* 确保此元素在其他内容之上以便于拖动，如果需要 */
  // position: relative;
  // z-index: 1;
}

/* 如果需要，可以从 songsArea.vue 复制其他相关样式，例如 .unselectable */
</style>
