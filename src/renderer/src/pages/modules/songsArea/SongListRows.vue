<script setup lang="ts">
import { PropType, reactive, markRaw } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { ISongInfo, ISongsAreaColumn } from '../../../../../types/globals'
import type { ComponentPublicInstance } from 'vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'

const props = defineProps({
  songs: {
    type: Array as PropType<ISongInfo[]>,
    required: true
  },
  visibleColumns: {
    type: Array as PropType<ISongsAreaColumn[]>,
    required: true
  },
  selectedSongFilePaths: {
    type: Array as PropType<string[]>,
    required: true
  },
  playingSongFilePath: {
    type: String as PropType<string | undefined>,
    default: undefined
  },
  totalWidth: {
    type: Number,
    required: true
  },
  // 新增：拖拽相关的props
  sourceLibraryName: {
    type: String,
    required: true
  },
  sourceSongListUUID: {
    type: String,
    required: true
  },
  // 新增：可选传入滚动容器（OverlayScrollbars 的 viewport 元素）
  scrollHostElement: {
    type: Object as PropType<HTMLElement | null | undefined>,
    default: undefined
  },
  // 父组件传入的滚动位与视口高度（优先使用）
  externalScrollTop: {
    type: Number as PropType<number | undefined>,
    default: undefined
  },
  externalViewportHeight: {
    type: Number as PropType<number | undefined>,
    default: undefined
  },
  // 歌单根目录（用于在主进程将缩略图缓存到该目录下）
  songListRootDir: {
    type: String as PropType<string | undefined>,
    default: undefined
  }
})

const emit = defineEmits<{
  (e: 'song-click', event: MouseEvent, song: ISongInfo): void
  (e: 'song-contextmenu', event: MouseEvent, song: ISongInfo): void
  (e: 'song-dblclick', song: ISongInfo): void
  // 新增：拖拽相关的事件
  (e: 'song-dragstart', event: DragEvent, song: ISongInfo): void
  (e: 'song-dragend', event: DragEvent): void
  (e: 'rows-rendered', count: number): void
}>()

// 记录每个单元格 DOM，用于气泡锚定（非响应，减少依赖跟踪）
const cellRefMap = markRaw({} as Record<string, HTMLElement | null>)
const getCellKey = (song: ISongInfo, colKey: string) => `${song.filePath}__${colKey}`
const setCellRef = (key: string, el: Element | ComponentPublicInstance | null) => {
  let dom: HTMLElement | null = null
  if (el) {
    if (el instanceof HTMLElement) {
      dom = el
    } else if ((el as any).$el instanceof HTMLElement) {
      dom = (el as any).$el as HTMLElement
    }
  }
  cellRefMap[key] = dom
}

// 渲染完成观测：当 songs 变化后，等待一帧统计行数并上报
import { nextTick, watch, ref as vRef, computed, onMounted, onUnmounted } from 'vue'
const rowsRoot = vRef<HTMLElement | null>(null)
const runtime = useRuntimeStore()
const onlyWhenOverflowComputed = computed(() => !(runtime.setting as any)?.songListBubbleAlways)
// 按需展示气泡：仅在鼠标悬停的单元格渲染 bubbleBox，避免批量挂载
const hoveredCellKey = vRef<string | null>(null)
// 移除 rows 渲染观测，避免大 DOM 遍历

// --- 虚拟滚动实现 ---
const defaultRowHeight = 30 // 兜底默认行高
const rowHeight = vRef<number>(defaultRowHeight)
// 动态测量实际行高（考虑边框等因素）
function measureRowHeight() {
  const root = rowsRoot.value
  if (!root) return
  const el = root.querySelector('.song-row-content') as HTMLElement | null
  const h = el?.offsetHeight
  if (h && h > 0 && h !== rowHeight.value) {
    rowHeight.value = h
  }
}
const BUFFER_ROWS = 12
const scrollTop = vRef(0)
const viewportHeight = vRef(0)
const totalHeight = computed(() => (props.songs?.length || 0) * rowHeight.value)

let viewportEl: HTMLElement | null = null
let onScrollBound: ((e: Event) => void) | null = null
let resizeObserver: ResizeObserver | null = null
let rafId = 0
let lastScrollTop = -1
let hostEl: HTMLElement | null = null

function resolveViewportEl(): HTMLElement | null {
  // 1) 优先使用传入的 viewport
  if (props.scrollHostElement instanceof HTMLElement) {
    const vp = props.scrollHostElement
    // 检测 vp 是否实际滚动，否则回退到 content
    const host = vp.closest('.os-host') as HTMLElement | null
    hostEl = host || null
    const content = host?.querySelector('.os-content') as HTMLElement | null
    if (vp.scrollHeight > vp.clientHeight + 1) return vp
    if (content && content.scrollHeight > content.clientHeight + 1) return content
    return vp
  }
  // 2) 从当前节点向上找到 os-host，再找 viewport / content
  const root = rowsRoot.value
  if (!root) return null
  const host = root.closest('.os-host') as HTMLElement | null
  hostEl = host || null
  const vp = host?.querySelector('.os-viewport') as HTMLElement | null
  const content = host?.querySelector('.os-content') as HTMLElement | null
  if (vp && vp.scrollHeight > vp.clientHeight + 1) return vp
  if (content && content.scrollHeight > content.clientHeight + 1) return content
  return vp || content || host || null
}

function detectScrollCarrier(): { el: HTMLElement | null; height: number; top: number } {
  const host = hostEl || rowsRoot.value?.closest('.os-host') || null
  const vp = (host as HTMLElement | null)?.querySelector?.('.os-viewport') as HTMLElement | null
  const content = (host as HTMLElement | null)?.querySelector?.('.os-content') as HTMLElement | null
  const candidates: HTMLElement[] = []
  if (viewportEl) candidates.push(viewportEl)
  if (vp && !candidates.includes(vp)) candidates.push(vp)
  if (content && !candidates.includes(content)) candidates.push(content)
  if (host && !candidates.includes(host)) candidates.push(host as HTMLElement)
  for (const el of candidates) {
    const h = el.clientHeight
    const sh = el.scrollHeight
    if (h > 0 && sh > h + 1) {
      return { el, height: h, top: el.scrollTop }
    }
  }
  // 兜底
  return {
    el: (viewportEl || vp || content || (host as HTMLElement | null)) as HTMLElement | null,
    height:
      (viewportEl || vp || content || (host as HTMLElement | null))?.clientHeight ||
      window.innerHeight,
    top: (viewportEl || vp || content || (host as HTMLElement | null))?.scrollTop || 0
  }
}

function attachListeners() {
  viewportEl = resolveViewportEl()
  if (!viewportEl) return
  // 初始化尺寸与滚动位
  const initCarrier = detectScrollCarrier()
  viewportHeight.value = initCarrier.height
  scrollTop.value = initCarrier.top

  onScrollBound = (e: Event) => {
    // 仅读取 scrollTop，避免布局抖动
    const carrier = detectScrollCarrier()
    scrollTop.value = carrier.top
    viewportHeight.value = carrier.height
  }
  viewportEl.addEventListener('scroll', onScrollBound, { passive: true })
  // 同时在 content/host 上也监听，以防实际滚动元素不同
  const host = hostEl
  const vp = host?.querySelector('.os-viewport') as HTMLElement | null
  const content = host?.querySelector('.os-content') as HTMLElement | null
  if (vp && vp !== viewportEl) vp.addEventListener('scroll', onScrollBound, { passive: true })
  if (content && content !== viewportEl)
    content.addEventListener('scroll', onScrollBound, { passive: true })

  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver((entries) => {
      const carrier = detectScrollCarrier()
      viewportHeight.value = carrier.height
    })
    if (viewportEl) resizeObserver.observe(viewportEl)
    if (vp && vp !== viewportEl) resizeObserver.observe(vp)
    if (content && content !== viewportEl) resizeObserver.observe(content)
  }

  // rAF 兜底：即使 scroll 事件未触发，也能侦测滚动
  const tick = () => {
    const carrier = detectScrollCarrier()
    const st = carrier.top
    if (st !== lastScrollTop) {
      lastScrollTop = st
      scrollTop.value = st
      viewportHeight.value = carrier.height
      // 每次滚动尝试测量一次行高（首屏或样式变化后）
      measureRowHeight()
    }
    rafId = requestAnimationFrame(tick)
  }
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(tick)
}

function detachListeners() {
  if (viewportEl && onScrollBound) {
    viewportEl.removeEventListener('scroll', onScrollBound)
  }
  onScrollBound = null
  cancelAnimationFrame(rafId)
  if (resizeObserver && viewportEl) {
    try {
      resizeObserver.unobserve(viewportEl)
    } catch {}
  }
  resizeObserver = null
  viewportEl = null
}

onMounted(() => {
  // 初次尝试
  attachListeners()
  // 若延迟挂载（OverlayScrollbars defer），下一帧重试
  nextTick(() => {
    if (!viewportEl) attachListeners()
  })
  // 首屏预取
  primePrefetchWindow()
})

onUnmounted(() => {
  detachListeners()
})

// 监听传入的 scrollHostElement 变化，及时重挂监听
watch(
  () => props.scrollHostElement,
  () => {
    detachListeners()
    nextTick(() => attachListeners())
  }
)

const effectiveScrollTop = computed(() => props.externalScrollTop ?? scrollTop.value)
const effectiveViewportHeight = computed(() => props.externalViewportHeight ?? viewportHeight.value)

const startIndex = computed(() => {
  const raw = Math.floor(effectiveScrollTop.value / rowHeight.value) - BUFFER_ROWS
  return Math.max(0, raw)
})
const visibleCount = computed(() => {
  const vh =
    effectiveViewportHeight.value && effectiveViewportHeight.value > 0
      ? effectiveViewportHeight.value
      : rowsRoot.value?.parentElement?.clientHeight || window.innerHeight
  const base = Math.ceil(vh / rowHeight.value) + BUFFER_ROWS * 2
  return Math.max(base, BUFFER_ROWS * 2 + 1)
})
const endIndex = computed(() => {
  return Math.min(props.songs?.length || 0, startIndex.value + visibleCount.value)
})
const offsetTopPx = computed(() => startIndex.value * rowHeight.value)
const visibleSongsWithIndex = computed(() => {
  const out: { song: ISongInfo; idx: number }[] = []
  const arr = props.songs || []
  for (let i = startIndex.value; i < endIndex.value; i++) {
    out.push({ song: arr[i], idx: i })
  }
  return out
})

// （迁移至封面缓存与预取函数定义之后）

// 预取移动至封面缓存定义之后，避免初始化顺序问题

// 事件委托，减少每行 addEventListener 带来的开销
const onRowsClick = (e: MouseEvent) => {
  e.stopPropagation()
  const row = (e.target as HTMLElement)?.closest('.song-row-item') as HTMLElement | null
  if (!row) return
  const fp = row.dataset.filepath
  const song = props.songs.find((s) => s.filePath === fp)
  if (song) emit('song-click', e, song)
}
const onRowsContextmenu = (e: MouseEvent) => {
  e.stopPropagation()
  const row = (e.target as HTMLElement)?.closest('.song-row-item') as HTMLElement | null
  if (!row) return
  const fp = row.dataset.filepath
  const song = props.songs.find((s) => s.filePath === fp)
  if (song) emit('song-contextmenu', e, song)
}
const onRowsDblclick = (e: MouseEvent) => {
  e.stopPropagation()
  const row = (e.target as HTMLElement)?.closest('.song-row-item') as HTMLElement | null
  if (!row) return
  const fp = row.dataset.filepath
  const song = props.songs.find((s) => s.filePath === fp)
  if (song) emit('song-dblclick', song)
}

const onRowsMouseOver = (e: MouseEvent) => {
  const cell = (e.target as HTMLElement)?.closest('.cell-title') as HTMLElement | null
  if (!cell) return
  const key = cell.dataset.key
  if (key) hoveredCellKey.value = key
}
const onRowsMouseLeave = (e: MouseEvent) => {
  const rt = (e && (e.relatedTarget as HTMLElement | null)) || null
  // 若移入了气泡框（teleport 到 body，具有 .frkb-bubble 类），不要清空 hovered 状态
  if (rt && typeof rt.closest === 'function' && rt.closest('.frkb-bubble')) {
    return
  }
  hoveredCellKey.value = null
}

// --- 封面懒加载（有限并发 + 非响应式缓存） ---
const coverUrlCache = markRaw(new Map<string, string | null>()) // filePath -> blob url
const inflight = markRaw(new Map<string, Promise<string | null>>())
let running = 0
const MAX_CONCURRENCY = 12
const pendingQueue: Array<() => void> = []
const coversTick = vRef(0) // 轻量信号：封面就绪时触发一次性重渲染
function fetchCoverUrl(filePath: string): Promise<string | null> {
  if (!filePath) return Promise.resolve(null)
  const cached = coverUrlCache.get(filePath)
  if (cached !== undefined) return Promise.resolve(cached)
  const inq = inflight.get(filePath)
  if (inq) return inq
  const task = new Promise<string | null>((resolve) => {
    const run = async () => {
      try {
        const resp = (await window.electron.ipcRenderer.invoke(
          'getSongCoverThumb',
          filePath,
          48,
          props.songListRootDir
        )) as { format: string; data?: Uint8Array | { data: number[] }; dataUrl?: string } | null
        if (resp && (resp as any).dataUrl) {
          const url = (resp as any).dataUrl as string
          coverUrlCache.set(filePath, url)
          coversTick.value++
          resolve(url)
        } else if (resp && (resp as any).data) {
          const raw: any = (resp as any).data
          const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw.data || raw)
          const blob = new Blob([bytes.buffer], { type: (resp as any).format || 'image/jpeg' })
          const url = URL.createObjectURL(blob)
          coverUrlCache.set(filePath, url)
          coversTick.value++
          resolve(url)
        } else {
          coverUrlCache.set(filePath, null)
          coversTick.value++
          resolve(null)
        }
      } catch {
        coverUrlCache.set(filePath, null)
        coversTick.value++
        resolve(null)
      } finally {
        inflight.delete(filePath)
        running--
        pump()
      }
    }
    // 避免重复入队
    const alreadyQueued = pendingQueue.findIndex((fn: any) => (fn as any).__fp === filePath) !== -1
    if (!alreadyQueued) {
      ;(run as any).__fp = filePath
      pendingQueue.push(run)
    }
    pump()
  })
  inflight.set(filePath, task)
  return task
}

function getCoverUrl(filePath: string): string | null | undefined {
  return coverUrlCache.get(filePath)
}

function pump() {
  while (running < MAX_CONCURRENCY && pendingQueue.length > 0) {
    const fn = pendingQueue.shift()!
    running++
    fn()
  }
}

function onImgError(filePath: string) {
  coverUrlCache.set(filePath, null)
  coversTick.value++
}

// 预取当前可视窗口内的封面（避免首屏空白）——放到缓存定义之后
function primePrefetchWindow() {
  const arr = props.songs || []
  // 预取范围：当前窗口前后一屏，提升首屏与轻滚动命中率
  const prefetchStart = Math.max(0, startIndex.value - visibleCount.value)
  const prefetchEnd = Math.min(arr.length, endIndex.value + visibleCount.value)
  for (let i = prefetchStart; i < prefetchEnd; i++) {
    const fp = arr[i]?.filePath
    if (fp && !coverUrlCache.has(fp)) fetchCoverUrl(fp)
  }
}

// 在所有依赖（computed + 缓存 + 函数）都已初始化后再注册预取 watchers
watch(
  () => visibleSongsWithIndex.value.map((v) => v.song?.filePath).join('|'),
  () => {
    primePrefetchWindow()
  },
  { immediate: true }
)

watch(
  () => [startIndex.value, endIndex.value, props.songs?.length] as const,
  () => primePrefetchWindow(),
  { deep: false }
)
</script>

<template>
  <div
    ref="rowsRoot"
    @click="onRowsClick"
    @contextmenu.prevent="onRowsContextmenu"
    @dblclick="onRowsDblclick"
    @mouseover="onRowsMouseOver"
    @mouseleave="onRowsMouseLeave"
  >
    <!-- 使用占位高度撑开总可滚动高度，内部仅渲染可视窗口行 -->
    <div :style="{ height: totalHeight + 'px', position: 'relative' }">
      <div :style="{ position: 'absolute', top: offsetTopPx + 'px', left: 0, right: 0 }">
        <div
          v-for="item in visibleSongsWithIndex"
          :key="item.song.filePath"
          class="song-row-item unselectable"
          :data-filepath="item.song.filePath"
          :draggable="true"
          @dragstart.stop="$emit('song-dragstart', $event, item.song)"
          @dragend.stop="$emit('song-dragend', $event)"
        >
          <div
            class="song-row-content"
            :class="{
              lightBackground:
                item.idx % 2 === 1 && !selectedSongFilePaths.includes(item.song.filePath),
              darkBackground:
                item.idx % 2 === 0 && !selectedSongFilePaths.includes(item.song.filePath),
              selectedSong: selectedSongFilePaths.includes(item.song.filePath),
              playingSong: item.song.filePath === playingSongFilePath
            }"
            :style="{ 'min-width': `var(--songs-total-width, ${totalWidth}px)` }"
          >
            <template v-for="col in visibleColumns" :key="col.key">
              <div
                v-if="col.key === 'index'"
                class="cell-title"
                :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
              >
                {{ item.idx + 1 }}
              </div>
              <div
                v-else-if="col.key === 'cover'"
                class="cell-cover"
                :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
              >
                <div class="cover-wrapper" :data-ct="coversTick">
                  <img
                    v-if="getCoverUrl(item.song.filePath)"
                    :src="getCoverUrl(item.song.filePath) as string"
                    alt="cover"
                    decoding="async"
                    :key="getCoverUrl(item.song.filePath) || item.song.filePath + '-ph'"
                    @error="onImgError(item.song.filePath)"
                  />
                  <div v-else class="cover-skeleton"></div>
                </div>
              </div>
              <div
                v-else
                class="cell-title"
                :style="{ width: `var(--songs-col-${col.key}, ${col.width}px)` }"
                :ref="(el) => setCellRef(getCellKey(item.song, col.key), el)"
                :data-key="getCellKey(item.song, col.key)"
              >
                {{ item.song[col.key as keyof ISongInfo] }}
                <bubbleBox
                  v-if="hoveredCellKey === getCellKey(item.song, col.key)"
                  :dom="cellRefMap[getCellKey(item.song, col.key)] || undefined"
                  :title="String((item.song as any)[col.key] ?? '')"
                  :only-when-overflow="onlyWhenOverflowComputed"
                />
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.song-row-item {
  font-size: 14px;
}

.song-row-content {
  display: flex;
  height: 30px; // Standard row height
  contain: content;

  &.lightBackground {
    background-color: #191919;
  }
  &.darkBackground {
    background-color: #000000;
  }
  &.selectedSong {
    background-color: #37373d;
  }
  &.playingSong {
    color: #0078d4 !important;
    font-weight: bold;
  }
}

.cell-title {
  height: 100%;
  box-sizing: border-box;
  border-right: 1px solid #2b2b2b;
  border-bottom: 1px solid #2b2b2b;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding-left: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell-cover {
  height: 100%;
  box-sizing: border-box;
  border-right: 1px solid #2b2b2b;
  border-bottom: 1px solid #2b2b2b;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.cover-wrapper {
  width: 100%;
  height: 100%;
  overflow: hidden; // 多余部分被遮挡
  display: flex;
  align-items: center;
  justify-content: center;
}
.cover-wrapper img {
  width: 100%;
  height: 100%;
  object-fit: cover; // 占满宽高
  display: block;
}
.cover-skeleton {
  width: 100%;
  height: 100%;
  // background: #333;
}

.unselectable {
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
}
</style>
