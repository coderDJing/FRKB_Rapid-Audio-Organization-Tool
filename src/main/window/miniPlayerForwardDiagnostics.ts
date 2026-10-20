type PlayheadForwardRecord = {
  sequence: number | null
  publishedAtMs: number | null
  receivedAtMs: number
  forwardedAtMs: number
  targetWindowId: number | null
  outcome: 'sent' | 'window-unavailable' | 'send-failed'
  error?: string
}

/** 只供 RC 排查进度消息间隔；最多保存 128 条，异常报告到达时才读取并落盘。 */
export const createMiniPlayerForwardDiagnostics = () => {
  const recent: PlayheadForwardRecord[] = []
  return {
    record: (record: PlayheadForwardRecord) => {
      recent.push(record)
      if (recent.length > 128) recent.shift()
    },
    snapshot: (previousSequence?: number | null, incomingSequence?: number | null) => ({
      latest: recent.at(-1),
      previous:
        previousSequence == null
          ? undefined
          : recent.find((item) => item.sequence === previousSequence),
      incoming:
        incomingSequence == null
          ? undefined
          : recent.find((item) => item.sequence === incomingSequence)
    }),
    clear: () => {
      recent.length = 0
    }
  }
}
