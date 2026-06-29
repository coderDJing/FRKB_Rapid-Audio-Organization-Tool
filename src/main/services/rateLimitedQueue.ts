/**
 * 通用串行限流队列
 *
 * 背景：外部音乐数据 API 都有速率限制，必须串行 + 最小间隔，否则批量调用必撞 429/503。
 * 各渠道官方政策（已查证，2026-06）：
 *  - AcoustID：官方明文 ≤ 3 req/s（acoustId.ts 已自带 400ms 队列，未使用本工具）。
 *  - MusicBrainz：官方明文平均 1 req/s per IP，超限 503（musicBrainz.ts 已自带 1100ms 队列）。
 *  - ListenBrainz labs（similar-recordings）：官方无公开数字、实测不返回任何 X-RateLimit-* 头，
 *    只能用固定保守间隔 + 对 429/503 退避。
 *  - Last.fm：官方无具体数字（"several calls per second" 会被封），错误码 29 = Rate Limit。
 *
 * 该工具抽取自 musicBrainz.ts 的 scheduleRequest/processQueue/withRetry 模式，
 * 额外内置了对限流错误的指数退避，供 ListenBrainz / Last.fm 复用。
 */

interface QueueItem<T> {
  fn: () => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

export interface RateLimitedQueueOptions {
  /** 两次请求之间的最小间隔（毫秒）。 */
  minInterval: number
  /** 限流错误（429/503）时的最大重试次数，默认 3。 */
  maxRetries?: number
  /** 退避基准毫秒，默认 1000。第 n 次重试等待 base * 2^(n-1)，并叠加 minInterval。 */
  retryBaseMs?: number
  /**
   * 判断某个错误是否为「限流类」错误（值得退避重试）。
   * 默认匹配常见的 *_RATE_LIMITED / *_UNAVAILABLE / HTTP_429 / HTTP_503 文案。
   */
  isRateLimitError?: (error: unknown) => boolean
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error ?? '')
}

const defaultIsRateLimitError = (error: unknown): boolean => {
  const message = getErrorMessage(error)
  if (!message) return false
  return (
    message.includes('RATE_LIMITED') ||
    message.includes('UNAVAILABLE') ||
    message.includes('HTTP_429') ||
    message.includes('HTTP_503') ||
    message.includes('LASTFM_29')
  )
}

export interface RateLimitedQueue {
  /** 将一个异步任务排入队列，按最小间隔串行执行；限流错误自动退避重试。 */
  schedule<T>(fn: () => Promise<T>): Promise<T>
  /** 清空尚未开始执行的排队任务（已在执行中的不受影响）。返回被丢弃的任务数。 */
  clear(): number
  /** 当前排队中（尚未开始）的任务数。 */
  size(): number
}

export function createRateLimitedQueue(options: RateLimitedQueueOptions): RateLimitedQueue {
  const minInterval = Math.max(0, options.minInterval)
  const maxRetries = Math.max(1, options.maxRetries ?? 3)
  const retryBaseMs = Math.max(0, options.retryBaseMs ?? 1000)
  const isRateLimitError = options.isRateLimitError ?? defaultIsRateLimitError

  const queue: QueueItem<unknown>[] = []
  let processing = false

  const runWithRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error
        const canRetry = attempt < maxRetries && isRateLimitError(error)
        if (!canRetry) throw error
        // 指数退避：base * 2^(attempt-1) + 一个最小间隔，给上游喘息时间
        const backoff = retryBaseMs * Math.pow(2, attempt - 1) + minInterval
        await sleep(backoff)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(getErrorMessage(lastError))
  }

  const processQueue = () => {
    if (processing) return
    const item = queue.shift()
    if (!item) return
    processing = true
    runWithRetry(item.fn)
      .then((res) => item.resolve(res))
      .catch((err) => item.reject(err))
      .finally(() => {
        // 无论成败，等待最小间隔后再处理下一个，保证串行限速
        setTimeout(() => {
          processing = false
          processQueue()
        }, minInterval)
      })
  }

  return {
    schedule<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          fn: fn as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject
        })
        processQueue()
      })
    },
    clear(): number {
      const droppedItems = queue.splice(0)
      const dropped = droppedItems.length
      for (const item of droppedItems) {
        item.reject(new Error('RATE_LIMITED_QUEUE_CLEARED'))
      }
      return dropped
    },
    size(): number {
      return queue.length
    }
  }
}
