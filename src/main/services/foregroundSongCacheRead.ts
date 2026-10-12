let activeReads = 0

/** 只覆盖正在读歌单缓存的 worker，不包含扫完之后的后台修复。 */
export const hasForegroundSongCacheRead = (): boolean => activeReads > 0

export const trackForegroundSongCacheRead = async <T>(task: () => Promise<T>): Promise<T> => {
  activeReads += 1
  try {
    return await task()
  } finally {
    activeReads -= 1
  }
}

/** deadlineMs 是整次等待的截止时间，不是每一页重新起算。 */
export const waitForForegroundSongCacheRead = async (deadlineMs: number): Promise<void> => {
  while (hasForegroundSongCacheRead() && Date.now() < deadlineMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}
