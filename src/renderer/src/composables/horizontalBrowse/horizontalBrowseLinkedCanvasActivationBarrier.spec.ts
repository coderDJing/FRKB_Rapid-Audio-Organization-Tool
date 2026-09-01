import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  queueHorizontalBrowseLinkedCanvasActivation,
  resetHorizontalBrowseLinkedCanvasActivationBarrier
} from './horizontalBrowseLinkedCanvasActivationBarrier'

let nextRafId = 1
let rafCallbacks = new Map<number, FrameRequestCallback>()

const flushAnimationFrame = () => {
  const callbacks = [...rafCallbacks.values()]
  rafCallbacks.clear()
  callbacks.forEach((callback) => callback(performance.now()))
}

beforeEach(() => {
  vi.useFakeTimers()
  nextRafId = 1
  rafCallbacks = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextRafId++
    rafCallbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks.delete(id)
  })
})

afterEach(() => {
  resetHorizontalBrowseLinkedCanvasActivationBarrier()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('queueHorizontalBrowseLinkedCanvasActivation', () => {
  it('两轨都就绪后在同一任务内提交，并吸收绘制前的同轨校正帧', () => {
    const committed: string[] = []
    queueHorizontalBrowseLinkedCanvasActivation('down', () => committed.push('down-old'))
    queueHorizontalBrowseLinkedCanvasActivation('up', () => committed.push('up'))

    flushAnimationFrame()
    queueHorizontalBrowseLinkedCanvasActivation('down', () => committed.push('down-latest'))
    expect(committed).toEqual([])

    flushAnimationFrame()

    expect(committed).toEqual(['up', 'down-latest'])
  })

  it('只有一轨可用时通过超时提交，避免永久等待', () => {
    const commit = vi.fn()
    queueHorizontalBrowseLinkedCanvasActivation('down', commit)

    vi.advanceTimersByTime(119)
    expect(commit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledOnce()
  })
})
