const DRAG_RELEASE_ALIGNED_TARGET_NOTIFY_EPSILON_SEC = 0.035

/**
 * native seek 返回的实际落点只有明显偏离请求目标时才需要再次发布 seek intent。
 * 微小差异仍属于同一次拖动松手；重复发布会无谓增加 presentation revision，
 * 触发第二张内容等价的 replacement frame 和第二次 buffer promote。
 */
export const shouldNotifyHorizontalBrowseAlignedDragReleaseSeek = (
  requestedTargetSec: number,
  alignedTargetSec: number
) => {
  const requested = Number(requestedTargetSec)
  const aligned = Number(alignedTargetSec)
  if (!Number.isFinite(requested) || !Number.isFinite(aligned)) return true
  return Math.abs(aligned - requested) > DRAG_RELEASE_ALIGNED_TARGET_NOTIFY_EPSILON_SEC
}
