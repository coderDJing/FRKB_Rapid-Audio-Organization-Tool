import type {
  MixxxWaveformData,
  RawWaveformData,
  RawWaveformLevel,
  RenderTilePayload
} from './mixtapeWaveformRender.types'

type RgbComponents = {
  low: { r: number; g: number; b: number }
  mid: { r: number; g: number; b: number }
  high: { r: number; g: number; b: number }
}

type CreateTileRendererOptions = {
  mixxxCache: Map<string, MixxxWaveformData>
  rawCache: Map<string, RawWaveformData>
  rawPyramidCache: Map<string, RawWaveformLevel[]>
  rawWaveformMinZoom: number
  summaryZoom: number
  mixxxRgbComponents: RgbComponents
  postToMain: (message: any, transfer?: Transferable[]) => void
}

export const createTileRenderer = (options: CreateTileRendererOptions) => {
  const {
    mixxxCache,
    rawCache,
    rawPyramidCache,
    rawWaveformMinZoom,
    summaryZoom,
    mixxxRgbComponents,
    postToMain
  } = options

  let tileCanvas: OffscreenCanvas | null = null
  let tileCtx: OffscreenCanvasRenderingContext2D | null = null
  let scratchCanvas: OffscreenCanvas | null = null
  let scratchCtx: OffscreenCanvasRenderingContext2D | null = null

  const toColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

  const ensureCanvas = (
    target: OffscreenCanvas | null,
    ctx: OffscreenCanvasRenderingContext2D | null,
    width: number,
    height: number,
    pixelRatio: number
  ) => {
    const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
    const scaledHeight = Math.max(1, Math.floor(height * pixelRatio))
    if (!target) {
      target = new OffscreenCanvas(scaledWidth, scaledHeight)
      ctx = target.getContext('2d')
    } else if (target.width !== scaledWidth || target.height !== scaledHeight) {
      target.width = scaledWidth
      target.height = scaledHeight
    }
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, scaledWidth, scaledHeight)
      ctx.scale(pixelRatio, pixelRatio)
    }
    return { canvas: target, ctx }
  }

  const ensureScratch = (width: number, height: number) => {
    if (!scratchCanvas) {
      scratchCanvas = new OffscreenCanvas(
        Math.max(1, Math.floor(width)),
        Math.max(1, Math.floor(height))
      )
      scratchCtx = scratchCanvas.getContext('2d')
    } else if (
      scratchCanvas.width !== Math.max(1, Math.floor(width)) ||
      scratchCanvas.height !== Math.max(1, Math.floor(height))
    ) {
      scratchCanvas.width = Math.max(1, Math.floor(width))
      scratchCanvas.height = Math.max(1, Math.floor(height))
    }
    if (scratchCtx) {
      scratchCtx.setTransform(1, 0, 0, 1, 0, 0)
      scratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height)
    }
    return { canvas: scratchCanvas, ctx: scratchCtx }
  }

  const buildRawWaveformPyramid = (raw: RawWaveformData): RawWaveformLevel[] => {
    const levels: RawWaveformLevel[] = []
    const base: RawWaveformLevel = { ...raw, factor: 1 }
    levels.push(base)
    let current = base
    while (current.frames > 256 && levels.length < 8) {
      const nextFrames = Math.floor(current.frames / 2)
      if (nextFrames <= 1) break
      const minLeft = new Float32Array(nextFrames)
      const maxLeft = new Float32Array(nextFrames)
      const minRight = new Float32Array(nextFrames)
      const maxRight = new Float32Array(nextFrames)
      for (let i = 0; i < nextFrames; i += 1) {
        const i0 = i * 2
        const i1 = Math.min(current.frames - 1, i0 + 1)
        minLeft[i] = Math.min(current.minLeft[i0] ?? 0, current.minLeft[i1] ?? 0)
        maxLeft[i] = Math.max(current.maxLeft[i0] ?? 0, current.maxLeft[i1] ?? 0)
        minRight[i] = Math.min(current.minRight[i0] ?? 0, current.minRight[i1] ?? 0)
        maxRight[i] = Math.max(current.maxRight[i0] ?? 0, current.maxRight[i1] ?? 0)
      }
      const next: RawWaveformLevel = {
        duration: current.duration,
        sampleRate: current.sampleRate,
        rate: current.rate / 2,
        frames: nextFrames,
        minLeft,
        maxLeft,
        minRight,
        maxRight,
        factor: current.factor * 2
      }
      levels.push(next)
      current = next
    }
    return levels
  }

  const resolveRawWaveformLevel = (
    filePath: string,
    raw: RawWaveformData,
    samplesPerPixel: number
  ) => {
    let levels = rawPyramidCache.get(filePath)
    if (!levels) {
      levels = buildRawWaveformPyramid(raw)
      rawPyramidCache.set(filePath, levels)
    }
    if (!levels.length) return raw
    if (!Number.isFinite(samplesPerPixel) || samplesPerPixel <= 1) return levels[0]
    let target = 1
    while (target * 2 <= samplesPerPixel && target < 128) {
      target *= 2
    }
    let best = levels[0]
    let bestDiff = Math.abs(best.factor - target)
    for (const level of levels) {
      const diff = Math.abs(level.factor - target)
      if (diff < bestDiff) {
        best = level
        bestDiff = diff
      }
    }
    return best
  }

  const drawMixxxRgbWaveform = (
    ctx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number,
    waveformData: MixxxWaveformData,
    pixelRatio: number,
    range: {
      startFrame: number
      endFrame: number
      startTime: number
      endTime: number
      raw?: RawWaveformData | null
    }
  ) => {
    if (width <= 0 || height <= 0) return

    const low = waveformData.bands.low
    const mid = waveformData.bands.mid
    const high = waveformData.bands.high
    const all = waveformData.bands.all
    const frameCount = Math.min(
      low.left.length,
      low.right.length,
      mid.left.length,
      mid.right.length,
      high.left.length,
      high.right.length,
      all.left.length,
      all.right.length
    )
    if (!frameCount) return

    const rawStart = Number.isFinite(range.startFrame) ? range.startFrame : 0
    const rawEnd = Number.isFinite(range.endFrame) ? range.endFrame : frameCount
    const startFrame = Math.max(0, Math.min(frameCount - 1, Math.floor(rawStart)))
    const endFrame = Math.max(startFrame + 1, Math.min(frameCount, Math.ceil(rawEnd)))
    const visibleFrames = endFrame - startFrame
    if (visibleFrames <= 0) return

    const rawData = range.raw || null
    const rawMinLeft = rawData?.minLeft || null
    const rawMaxLeft = rawData?.maxLeft || null
    const rawMinRight = rawData?.minRight || null
    const rawMaxRight = rawData?.maxRight || null
    const rawRate = Number(rawData?.rate || 0)
    const rawStartTime = Number(range.startTime || 0)
    const rawEndTime = Number(range.endTime || 0)
    const rawSpan = rawEndTime - rawStartTime
    const hasRaw =
      rawData &&
      rawMinLeft &&
      rawMaxLeft &&
      rawMinRight &&
      rawMaxRight &&
      rawRate > 0 &&
      Number.isFinite(rawSpan) &&
      rawSpan > 0

    const length = Math.max(1, Math.floor(width * pixelRatio))
    const gain = (visibleFrames * 2) / length
    const offset = startFrame * 2
    const halfBreadth = height / 2
    const heightFactor = halfBreadth / 255
    const rawHeightFactor = halfBreadth
    const pixelWidth = 1 / pixelRatio
    ctx.globalCompositeOperation = 'source-over'
    ctx.imageSmoothingEnabled = false

    const columns = new Array<{
      r: number
      g: number
      b: number
      avgTop: number
      avgBottom: number
      peakTop: number
      peakBottom: number
    } | null>(length)

    const useInterpolatedSamples = gain <= 2
    const rawFrames = hasRaw
      ? Math.min(rawMinLeft.length, rawMaxLeft.length, rawMinRight.length, rawMaxRight.length)
      : 0
    const rawStartPos = hasRaw ? rawStartTime * rawRate : 0
    const rawEndPos = hasRaw ? rawEndTime * rawRate : 0
    const rawVisible = hasRaw ? Math.max(1, rawEndPos - rawStartPos) : 0
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t

    for (let x = 0; x < length; x += 1) {
      const xSampleWidth = gain * x
      const xVisualSampleIndex = xSampleWidth + offset
      const maxSamplingRange = gain / 2

      let maxLow = 0
      let maxMid = 0
      let maxHigh = 0
      let maxAllLeft = 0
      let maxAllRight = 0
      let maxAllAvgLeft = 0
      let maxAllAvgRight = 0

      if (useInterpolatedSamples) {
        const framePos = Math.max(startFrame, Math.min(endFrame - 1, xVisualSampleIndex / 2))
        const i0 = Math.floor(framePos)
        const i1 = Math.min(endFrame - 1, i0 + 1)
        const t = framePos - i0
        const lerpVal = (a: number, b: number) => a + (b - a) * t

        const lowLeft = lerpVal(low.left[i0], low.left[i1])
        const lowRight = lerpVal(low.right[i0], low.right[i1])
        const midLeft = lerpVal(mid.left[i0], mid.left[i1])
        const midRight = lerpVal(mid.right[i0], mid.right[i1])
        const highLeft = lerpVal(high.left[i0], high.left[i1])
        const highRight = lerpVal(high.right[i0], high.right[i1])
        const allAvgLeft = lerpVal(all.left[i0], all.left[i1])
        const allAvgRight = lerpVal(all.right[i0], all.right[i1])
        const peakLeft0 = all.peakLeft ? all.peakLeft[i0] : all.left[i0]
        const peakLeft1 = all.peakLeft ? all.peakLeft[i1] : all.left[i1]
        const peakRight0 = all.peakRight ? all.peakRight[i0] : all.right[i0]
        const peakRight1 = all.peakRight ? all.peakRight[i1] : all.right[i1]
        const allLeft = lerpVal(peakLeft0, peakLeft1)
        const allRight = lerpVal(peakRight0, peakRight1)

        maxLow = Math.max(lowLeft, lowRight)
        maxMid = Math.max(midLeft, midRight)
        maxHigh = Math.max(highLeft, highRight)
        maxAllLeft = allLeft
        maxAllRight = allRight
        maxAllAvgLeft = allAvgLeft
        maxAllAvgRight = allAvgRight
      } else {
        let visualFrameStart = Math.floor(xVisualSampleIndex / 2 - maxSamplingRange + 0.5)
        let visualFrameStop = Math.floor(xVisualSampleIndex / 2 + maxSamplingRange + 0.5)
        visualFrameStart = Math.max(startFrame, Math.min(endFrame - 1, visualFrameStart))
        visualFrameStop = Math.max(startFrame, Math.min(endFrame - 1, visualFrameStop))
        if (visualFrameStop < visualFrameStart) {
          const tmp = visualFrameStop
          visualFrameStop = visualFrameStart
          visualFrameStart = tmp
        }

        for (let i = visualFrameStart; i <= visualFrameStop; i += 1) {
          const lowLeft = low.left[i]
          const lowRight = low.right[i]
          const midLeft = mid.left[i]
          const midRight = mid.right[i]
          const highLeft = high.left[i]
          const highRight = high.right[i]
          const allAvgLeft = all.left[i]
          const allAvgRight = all.right[i]
          const allLeft = all.peakLeft ? all.peakLeft[i] : allAvgLeft
          const allRight = all.peakRight ? all.peakRight[i] : allAvgRight

          if (lowLeft > maxLow) maxLow = lowLeft
          if (lowRight > maxLow) maxLow = lowRight
          if (midLeft > maxMid) maxMid = midLeft
          if (midRight > maxMid) maxMid = midRight
          if (highLeft > maxHigh) maxHigh = highLeft
          if (highRight > maxHigh) maxHigh = highRight

          if (allLeft > maxAllLeft) maxAllLeft = allLeft
          if (allRight > maxAllRight) maxAllRight = allRight
          if (allAvgLeft > maxAllAvgLeft) maxAllAvgLeft = allAvgLeft
          if (allAvgRight > maxAllAvgRight) maxAllAvgRight = allAvgRight
        }
      }

      const allUnscaled = maxLow + maxMid + maxHigh
      let eqGain = 1
      if (allUnscaled > 0) {
        eqGain = (maxLow + maxMid + maxHigh) / allUnscaled
      }

      const red =
        maxLow * mixxxRgbComponents.low.r +
        maxMid * mixxxRgbComponents.mid.r +
        maxHigh * mixxxRgbComponents.high.r
      const green =
        maxLow * mixxxRgbComponents.low.g +
        maxMid * mixxxRgbComponents.mid.g +
        maxHigh * mixxxRgbComponents.high.g
      const blue =
        maxLow * mixxxRgbComponents.low.b +
        maxMid * mixxxRgbComponents.mid.b +
        maxHigh * mixxxRgbComponents.high.b

      const maxColor = Math.max(red, green, blue)
      if (maxColor <= 0) {
        columns[x] = null
        continue
      }

      const r = toColorChannel((red / maxColor) * 255)
      const g = toColorChannel((green / maxColor) * 255)
      const b = toColorChannel((blue / maxColor) * 255)

      let avgTop = heightFactor * eqGain * maxAllAvgLeft
      let avgBottom = heightFactor * eqGain * maxAllAvgRight
      let peakTop = heightFactor * eqGain * maxAllLeft
      let peakBottom = heightFactor * eqGain * maxAllRight

      if (hasRaw && rawMinLeft && rawMaxLeft && rawMinRight && rawMaxRight && rawFrames > 1) {
        const rawPos = rawStartPos + (x / Math.max(1, length - 1)) * rawVisible
        const rawIndex = Math.max(0, Math.min(rawFrames - 1, rawPos))
        const i0 = Math.floor(rawIndex)
        const i1 = Math.min(rawFrames - 1, i0 + 1)
        const t = rawIndex - i0
        const rawMinLeftValue = lerp(rawMinLeft[i0] || 0, rawMinLeft[i1] || 0, t)
        const rawMaxLeftValue = lerp(rawMaxLeft[i0] || 0, rawMaxLeft[i1] || 0, t)
        const rawMinRightValue = lerp(rawMinRight[i0] || 0, rawMinRight[i1] || 0, t)
        const rawMaxRightValue = lerp(rawMaxRight[i0] || 0, rawMaxRight[i1] || 0, t)
        const leftPeak = Math.max(Math.abs(rawMinLeftValue), Math.abs(rawMaxLeftValue))
        const rightPeak = Math.max(Math.abs(rawMinRightValue), Math.abs(rawMaxRightValue))
        avgTop = leftPeak * rawHeightFactor
        avgBottom = rightPeak * rawHeightFactor
        peakTop = avgTop
        peakBottom = avgBottom
      }

      columns[x] = {
        r,
        g,
        b,
        avgTop,
        avgBottom,
        peakTop,
        peakBottom
      }
    }

    const drawBand = (alpha: number, usePeak: boolean) => {
      ctx.globalAlpha = alpha
      for (let x = 0; x < length - 1; x += 1) {
        const current = columns[x]
        const next = columns[x + 1]
        if (!current && !next) continue
        const color = current ?? next
        if (!color) continue
        const curTop = usePeak ? (current?.peakTop ?? 0) : (current?.avgTop ?? 0)
        const curBottom = usePeak ? (current?.peakBottom ?? 0) : (current?.avgBottom ?? 0)
        const nextTop = usePeak ? (next?.peakTop ?? curTop) : (next?.avgTop ?? curTop)
        const nextBottom = usePeak
          ? (next?.peakBottom ?? curBottom)
          : (next?.avgBottom ?? curBottom)
        const x0 = x * pixelWidth
        const x1 = (x + 1) * pixelWidth

        ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`
        ctx.beginPath()
        ctx.moveTo(x0, halfBreadth - curTop)
        ctx.lineTo(x1, halfBreadth - nextTop)
        ctx.lineTo(x1, halfBreadth + nextBottom)
        ctx.lineTo(x0, halfBreadth + curBottom)
        ctx.closePath()
        ctx.fill()
      }
    }

    if (hasRaw) {
      drawBand(1, false)
    } else {
      drawBand(0.22, true)
      drawBand(0.9, false)
    }
    ctx.globalAlpha = 1
  }

  const renderEmptyPlaceholder = (
    ctx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number
  ) => {
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.3)'
    ctx.setLineDash([4, 4])
    const midY = height / 2
    ctx.beginPath()
    ctx.moveTo(0, midY)
    ctx.lineTo(width, midY)
    ctx.stroke()
    ctx.setLineDash([])
  }

  const renderSummaryBar = (
    ctx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number
  ) => {
    const barHeight = Math.max(4, Math.round(height * 0.55))
    const y = Math.round((height - barHeight) / 2)
    ctx.fillStyle = 'rgba(90, 170, 255, 0.35)'
    ctx.fillRect(0, y, width, barHeight)
  }

  const renderTileBitmap = (payload: RenderTilePayload): ImageBitmap | null => {
    const {
      filePath,
      zoom,
      tileStart,
      tileWidth,
      trackWidth,
      durationSeconds,
      laneHeight,
      pixelRatio
    } = payload
    const mixxx = mixxxCache.get(filePath)
    const rawData = zoom >= rawWaveformMinZoom ? rawCache.get(filePath) || null : null

    const ensured = ensureCanvas(tileCanvas, tileCtx, tileWidth, laneHeight, pixelRatio)
    tileCanvas = ensured.canvas
    tileCtx = ensured.ctx
    if (!tileCanvas || !tileCtx) return null

    if (zoom <= summaryZoom + 0.0001) {
      renderSummaryBar(tileCtx, tileWidth, laneHeight)
      return tileCanvas.transferToImageBitmap()
    }

    if (!mixxx) {
      renderEmptyPlaceholder(tileCtx, tileWidth, laneHeight)
      return tileCanvas.transferToImageBitmap()
    }

    const low = mixxx.bands.low
    const mid = mixxx.bands.mid
    const high = mixxx.bands.high
    const all = mixxx.bands.all
    const frameCount = Math.min(
      low.left.length,
      low.right.length,
      mid.left.length,
      mid.right.length,
      high.left.length,
      high.right.length,
      all.left.length,
      all.right.length
    )
    if (!frameCount || !trackWidth) {
      renderEmptyPlaceholder(tileCtx, tileWidth, laneHeight)
      return tileCanvas.transferToImageBitmap()
    }

    const startFrame = Math.floor((tileStart / Math.max(1, trackWidth)) * frameCount)
    const endFrame = Math.ceil(((tileStart + tileWidth) / Math.max(1, trackWidth)) * frameCount)
    const startTime = durationSeconds ? (tileStart / Math.max(1, trackWidth)) * durationSeconds : 0
    const endTime = durationSeconds
      ? ((tileStart + tileWidth) / Math.max(1, trackWidth)) * durationSeconds
      : 0
    const rawSpan = Math.max(0, endTime - startTime)
    const rawSamplesPerPixel =
      rawData && rawSpan > 0 ? (rawData.rate * rawSpan) / Math.max(1, tileWidth * pixelRatio) : 0
    const resolvedRaw =
      rawData && rawSamplesPerPixel > 0
        ? resolveRawWaveformLevel(filePath, rawData, rawSamplesPerPixel)
        : rawData

    const renderScale = 1
    if (renderScale > 1) {
      const scratch = ensureScratch(tileWidth * renderScale, laneHeight)
      if (scratch && scratch.ctx) {
        drawMixxxRgbWaveform(scratch.ctx, tileWidth * renderScale, laneHeight, mixxx, pixelRatio, {
          startFrame,
          endFrame,
          startTime,
          endTime,
          raw: resolvedRaw
        })
        tileCtx.save()
        tileCtx.imageSmoothingEnabled = false
        tileCtx.clearRect(0, 0, tileWidth, laneHeight)
        tileCtx.drawImage(
          scratch.canvas,
          0,
          0,
          scratch.canvas.width,
          scratch.canvas.height,
          0,
          0,
          tileWidth,
          laneHeight
        )
        tileCtx.restore()
        return tileCanvas.transferToImageBitmap()
      }
    }

    drawMixxxRgbWaveform(tileCtx, tileWidth, laneHeight, mixxx, pixelRatio, {
      startFrame,
      endFrame,
      startTime,
      endTime,
      raw: resolvedRaw
    })
    return tileCanvas.transferToImageBitmap()
  }

  const renderTileMessage = (payload: RenderTilePayload) => {
    const bitmap = renderTileBitmap(payload)
    if (!bitmap) return
    postToMain({ type: 'rendered', cacheKey: payload.cacheKey, bitmap }, [bitmap])
  }

  const drawTrackGridLines = (
    ctx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number,
    bpm: number,
    firstBeatMs: number,
    range: { start: number; end: number },
    renderPx: number,
    barOnly: boolean,
    barWidth: number
  ) => {
    if (!Number.isFinite(bpm) || bpm <= 0) return
    const interval = (60 / bpm) * renderPx
    if (!interval || !Number.isFinite(interval)) return
    const offsetPx = (Number(firstBeatMs) / 1000) * renderPx
    const startX = range.start
    const endX = range.end
    if (endX <= startX || width <= 0 || height <= 0) return
    const startIndex = Math.floor((startX - offsetPx) / interval) - 2
    const endIndex = Math.ceil((endX - offsetPx) / interval) + 2

    ctx.save()
    for (let i = startIndex; i <= endIndex; i += 1) {
      const rawX = offsetPx + i * interval
      if (rawX < startX - interval || rawX > endX + interval) continue
      const mod32 = ((i % 32) + 32) % 32
      const mod4 = ((i % 4) + 4) % 4
      const level = mod32 === 0 ? 'bar' : mod4 === 0 ? 'beat4' : 'beat'
      if (barOnly && level !== 'bar') continue
      if (level === 'beat') continue
      const x = Math.round(rawX - startX)
      if (level === 'bar') {
        ctx.globalAlpha = 0.95
        ctx.fillStyle = 'rgba(0, 110, 220, 0.98)'
        ctx.fillRect(x, 0, barWidth, height)
      } else if (level === 'beat4') {
        ctx.globalAlpha = 0.85
        ctx.fillStyle = 'rgba(120, 200, 255, 0.98)'
        ctx.fillRect(x, 0, 1.8, height)
      } else {
        ctx.globalAlpha = 0.35
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)'
        ctx.fillRect(x, 0, 1, height)
      }
    }
    ctx.restore()
  }

  return {
    buildRawWaveformPyramid,
    renderTileBitmap,
    renderTileMessage,
    drawTrackGridLines
  }
}
