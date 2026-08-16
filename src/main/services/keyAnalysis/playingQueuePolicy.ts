/** 浏览器模式播放只提升已在队列中的任务，不因此新建分析。 */
export const shouldEnqueuePlayingAnalysis = (
  onlyIfQueued: boolean | undefined,
  isQueued: boolean
) => onlyIfQueued !== true || isQueued === true
