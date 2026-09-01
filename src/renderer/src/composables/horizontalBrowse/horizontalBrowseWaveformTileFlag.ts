// detail 大波形分块 / 瓦片渲染的唯一开关。
//
// **回退方法：把下面的 true 改成 false**，即完全走现有「单张超宽位图」路径，行为逐字节不变。
// 该等价性由 horizontalBrowseWaveformTileBuffers.spec.ts 机器断言（关闭时块容器一行 style 都不碰）。
//
// 阶段 1~4 已实现（块抽象 / 暂停态分块 / 播放滚动复用 / P0-P1-P2 优先级调度），
// 默认开启以便真机验收；阶段 5「移除 flag 与旧超宽路径」刻意未做——按设计文档要求，
// 它必须等阶段 2~4 通过真机验收之后才能进行，否则失去回退能力。
//
// 分阶段实施与验收标准见 drafts/大波形分块瓦片渲染设计.md。
// 阶段 5 移除旧路径时，grep 本文件导出的符号即可定位所有接线点。
let tileRenderingEnabled = true

export const isHorizontalBrowseWaveformTileRenderingEnabled = () => tileRenderingEnabled

export const setHorizontalBrowseWaveformTileRenderingEnabled = (enabled: boolean) => {
  tileRenderingEnabled = enabled === true
}
