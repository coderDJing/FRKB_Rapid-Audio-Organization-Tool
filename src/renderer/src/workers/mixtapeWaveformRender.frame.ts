import type {
  FrameBufferSlot,
  RenderFramePayload,
  RenderTilePayload
} from './mixtapeWaveformRender.types'

type CreateFrameRendererOptions = {
  mixTapeWebglEnabled: boolean
  mixTapeBufferMultiplier: number
  debugTrackLines: boolean
  rawWaveformMinZoom: number
  gridBarOnlyZoom: number
  gridBarWidthMin: number
  gridBarWidthMax: number
  gridBarWidthMaxZoom: number
  waveformTileWidth: number
  renderTileBitmap: (payload: RenderTilePayload) => ImageBitmap | null
  drawTrackGridLines: (
    ctx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number,
    bpm: number,
    firstBeatMs: number,
    range: { start: number; end: number },
    renderPx: number,
    barOnly: boolean,
    barWidth: number
  ) => void
}

export const createFrameRenderer = (options: CreateFrameRendererOptions) => {
  const {
    mixTapeWebglEnabled,
    mixTapeBufferMultiplier,
    debugTrackLines,
    rawWaveformMinZoom,
    gridBarOnlyZoom,
    gridBarWidthMin,
    gridBarWidthMax,
    gridBarWidthMaxZoom,
    waveformTileWidth,
    renderTileBitmap,
    drawTrackGridLines
  } = options

  let outputCanvas: OffscreenCanvas | null = null
  let outputCtx: OffscreenCanvasRenderingContext2D | null = null

  const frameBufferSlots = new Map<string, FrameBufferSlot>()
  const tileCache = new Map<string, { texture: WebGLTexture; used: number }>()
  const tileCacheIndex = new Map<string, Set<string>>()
  let tileCacheTick = 0
  let tileCacheLimit = 260

  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null
  let glReady = false
  let glProgramTex: WebGLProgram | null = null
  let glProgramColor: WebGLProgram | null = null
  let glQuadBuffer: WebGLBuffer | null = null
  let glTexLocations: {
    aPos: number
    uResolution: WebGLUniformLocation | null
    uRect: WebGLUniformLocation | null
    uTex: WebGLUniformLocation | null
    uTexRect: WebGLUniformLocation | null
  } | null = null
  let glColorLocations: {
    aPos: number
    uResolution: WebGLUniformLocation | null
    uRect: WebGLUniformLocation | null
    uColor: WebGLUniformLocation | null
  } | null = null
  let glActiveProgram: WebGLProgram | null = null

  const resolveFrameBufferMultiplier = (zoom: number) => {
    const safeZoom = Number.isFinite(zoom) ? zoom : 1
    if (safeZoom >= 6) return 4
    if (safeZoom >= 3) return 3.5
    return mixTapeBufferMultiplier
  }
  const resolveGridBarWidth = (zoom: number) => {
    const safeZoom = Number.isFinite(zoom) ? zoom : 1
    const minZoom = rawWaveformMinZoom
    const maxZoom = gridBarWidthMaxZoom
    if (safeZoom <= minZoom) return gridBarWidthMin
    if (safeZoom >= maxZoom) return gridBarWidthMax
    const ratio = (safeZoom - minZoom) / Math.max(0.0001, maxZoom - minZoom)
    return gridBarWidthMin + (gridBarWidthMax - gridBarWidthMin) * ratio
  }

  const buildTileCacheKey = (
    filePath: string,
    tileIndex: number,
    zoomValue: number,
    width: number,
    height: number,
    pixelRatio: number
  ) => {
    const zoomKey = Math.round(zoomValue * 1000)
    const ratioKey = Math.round(pixelRatio * 100)
    return `${filePath}::${tileIndex}::${zoomKey}::${width}x${height}@${ratioKey}`
  }

  const touchTileCache = (key: string) => {
    const entry = tileCache.get(key)
    if (!entry) return
    tileCacheTick += 1
    entry.used = tileCacheTick
  }

  const registerTileCacheKey = (filePath: string, key: string) => {
    const set = tileCacheIndex.get(filePath) || new Set<string>()
    set.add(key)
    tileCacheIndex.set(filePath, set)
  }

  const disposeTileCacheEntry = (entry?: { texture: WebGLTexture; used: number } | null) => {
    if (!entry) return
    if (gl && entry.texture) {
      try {
        gl.deleteTexture(entry.texture)
      } catch {}
    }
  }

  const pruneTileCache = () => {
    if (tileCache.size <= tileCacheLimit) return
    const entries = Array.from(tileCache.entries())
    entries.sort((a, b) => a[1].used - b[1].used)
    const removeCount = Math.max(0, tileCache.size - tileCacheLimit)
    for (let i = 0; i < removeCount; i += 1) {
      const [key, entry] = entries[i]
      disposeTileCacheEntry(entry)
      tileCache.delete(key)
      const filePath = key.split('::')[0] || ''
      if (!filePath) continue
      const set = tileCacheIndex.get(filePath)
      if (!set) continue
      set.delete(key)
      if (set.size === 0) {
        tileCacheIndex.delete(filePath)
      }
    }
  }

  const clearTileCacheForFile = (filePath: string) => {
    const keys = tileCacheIndex.get(filePath)
    if (keys) {
      for (const key of keys) {
        const entry = tileCache.get(key)
        disposeTileCacheEntry(entry || null)
        tileCache.delete(key)
      }
      tileCacheIndex.delete(filePath)
    }
  }

  const resolveFrameBufferId = (payload: RenderFramePayload) =>
    payload.bufferId || `z:${Math.round(payload.zoom * 1000)}`

  const createFrameBufferSlot = (): FrameBufferSlot => ({
    key: '',
    startX: 0,
    width: 0,
    height: 0,
    canvas: null,
    ctx: null,
    texture: null,
    texWidth: 0,
    texHeight: 0,
    fbo: null
  })

  const getFrameBufferSlot = (bufferId: string) => {
    const safeId = bufferId || 'default'
    let slot = frameBufferSlots.get(safeId)
    if (!slot) {
      slot = createFrameBufferSlot()
      frameBufferSlots.set(safeId, slot)
    }
    return slot
  }

  const resetFrameBufferSlot = (slot: FrameBufferSlot) => {
    slot.key = ''
    slot.startX = 0
    slot.width = 0
    slot.height = 0
    slot.texWidth = 0
    slot.texHeight = 0
  }

  const disposeFrameBufferSlot = (slot: FrameBufferSlot) => {
    if (gl && slot.texture) {
      try {
        gl.deleteTexture(slot.texture)
      } catch {}
    }
    if (gl && slot.fbo) {
      try {
        gl.deleteFramebuffer(slot.fbo)
      } catch {}
    }
    slot.texture = null
    slot.fbo = null
    slot.canvas = null
    slot.ctx = null
    resetFrameBufferSlot(slot)
  }

  const clearFrameBufferSlots = () => {
    for (const slot of frameBufferSlots.values()) {
      disposeFrameBufferSlot(slot)
    }
    frameBufferSlots.clear()
  }

  const clearAllCaches = () => {
    for (const entry of tileCache.values()) {
      disposeTileCacheEntry(entry)
    }
    tileCache.clear()
    tileCacheIndex.clear()
    tileCacheTick = 0
    clearFrameBufferSlots()
  }

  const ensureOutputCanvas = (width: number, height: number, pixelRatio: number) => {
    if (!outputCanvas) return { canvas: null, ctx: null }
    const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
    const scaledHeight = Math.max(1, Math.floor(height * pixelRatio))
    if (outputCanvas.width !== scaledWidth) outputCanvas.width = scaledWidth
    if (outputCanvas.height !== scaledHeight) outputCanvas.height = scaledHeight
    if (!outputCtx) {
      outputCtx = outputCanvas.getContext('2d')
    }
    if (outputCtx) {
      outputCtx.setTransform(1, 0, 0, 1, 0, 0)
      outputCtx.clearRect(0, 0, scaledWidth, scaledHeight)
      outputCtx.scale(pixelRatio, pixelRatio)
    }
    return { canvas: outputCanvas, ctx: outputCtx }
  }

  const ensureBufferCanvas = (
    slot: FrameBufferSlot,
    width: number,
    height: number,
    pixelRatio: number
  ) => {
    const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
    const scaledHeight = Math.max(1, Math.floor(height * pixelRatio))
    if (!slot.canvas) {
      slot.canvas = new OffscreenCanvas(scaledWidth, scaledHeight)
      slot.ctx = slot.canvas.getContext('2d')
    } else {
      if (slot.canvas.width !== scaledWidth) slot.canvas.width = scaledWidth
      if (slot.canvas.height !== scaledHeight) slot.canvas.height = scaledHeight
    }
    if (slot.ctx) {
      slot.ctx.setTransform(1, 0, 0, 1, 0, 0)
      slot.ctx.clearRect(0, 0, scaledWidth, scaledHeight)
      slot.ctx.scale(pixelRatio, pixelRatio)
    }
    return { canvas: slot.canvas, ctx: slot.ctx }
  }

  const buildFrameKey = (payload: RenderFramePayload) => {
    const trackSig = payload.tracks
      .map(
        (track) =>
          `${track.id}:${track.filePath}:${Math.round(track.trackWidth)}:${Math.round(
            Number(track.startX) || 0
          )}:${track.laneIndex}:${Math.round(track.bpm * 100)}:${Math.round(track.firstBeatMs)}`
      )
      .join('|')
    return [
      payload.width,
      payload.height,
      Math.round(payload.zoom * 1000),
      Math.round(payload.laneHeight * 10),
      Math.round(payload.laneGap * 10),
      Math.round(payload.lanePaddingTop * 10),
      Math.round(payload.renderPxPerSec * 100),
      Math.round(payload.pixelRatio * 100),
      payload.showGridLines ? 1 : 0,
      payload.renderVersion,
      Math.round(payload.startY),
      trackSig
    ].join('::')
  }

  const renderTracksToContextCpu = (
    ctx: OffscreenCanvasRenderingContext2D,
    payload: RenderFramePayload,
    viewStartX: number,
    viewStartY: number,
    viewWidth: number,
    viewHeight: number
  ) => {
    const showGridLines = payload.showGridLines !== false
    const allowTileBuild = payload.allowTileBuild !== false
    const barOnlyGrid = payload.zoom <= gridBarOnlyZoom
    const barWidth = resolveGridBarWidth(payload.zoom)
    const laneStride = payload.laneHeight + payload.laneGap
    const endX = viewStartX + viewWidth

    for (const track of payload.tracks) {
      const filePath = track.filePath
      if (!filePath) continue
      const trackWidth = track.trackWidth
      if (!trackWidth || !Number.isFinite(trackWidth)) continue
      const trackStartX = Number(track.startX) || 0
      const trackEndX = trackStartX + trackWidth
      const trackY = payload.lanePaddingTop + track.laneIndex * laneStride - viewStartY
      if (trackY > viewHeight || trackY + payload.laneHeight < 0) continue
      const visibleStart = Math.max(trackStartX, viewStartX)
      const visibleEnd = Math.min(trackEndX, endX)
      if (visibleEnd <= visibleStart) continue
      const localStart = visibleStart - trackStartX
      const localEnd = visibleEnd - trackStartX

      const tileStartIndex = Math.max(0, Math.floor(localStart / waveformTileWidth))
      const tileEndIndex = Math.max(
        tileStartIndex,
        Math.floor(Math.max(0, localEnd - 1) / waveformTileWidth)
      )
      for (let tileIndex = tileStartIndex; tileIndex <= tileEndIndex; tileIndex += 1) {
        const tileStart = tileIndex * waveformTileWidth
        const tileWidth = Math.max(0, Math.min(waveformTileWidth, trackWidth - tileStart))
        if (!tileWidth) continue
        const bitmap = allowTileBuild
          ? renderTileBitmap({
              cacheKey: '',
              filePath,
              zoom: payload.zoom,
              tileIndex,
              tileStart,
              tileWidth,
              trackWidth,
              durationSeconds: track.durationSeconds,
              laneHeight: payload.laneHeight,
              pixelRatio: payload.pixelRatio
            })
          : null
        if (bitmap) {
          ctx.drawImage(
            bitmap,
            trackStartX + tileStart - viewStartX,
            trackY,
            tileWidth,
            payload.laneHeight
          )
          try {
            bitmap.close()
          } catch {}
        }
      }

      const visibleWidth = Math.max(0, localEnd - localStart)
      if (showGridLines && visibleWidth > 0) {
        ctx.save()
        ctx.translate(trackStartX + localStart - viewStartX, trackY)
        drawTrackGridLines(
          ctx,
          visibleWidth,
          payload.laneHeight,
          track.bpm,
          track.firstBeatMs,
          { start: localStart, end: localEnd },
          payload.renderPxPerSec,
          barOnlyGrid,
          barWidth
        )
        ctx.restore()
      }

      if (debugTrackLines) {
        ctx.save()
        ctx.globalAlpha = 0.9
        ctx.fillStyle = 'rgba(255, 64, 64, 0.9)'
        ctx.fillRect(0, Math.round(trackY), viewWidth, 1)
        ctx.fillStyle = 'rgba(64, 200, 255, 0.9)'
        ctx.fillRect(0, Math.round(trackY + payload.laneHeight - 1), viewWidth, 1)
        ctx.restore()
      }
    }
  }

  const renderFrameCpu = (
    payload: RenderFramePayload,
    slot: FrameBufferSlot,
    drawOutput: boolean
  ) => {
    const { width, height, pixelRatio, startX, startY } = payload
    const key = buildFrameKey(payload)
    const bufferMultiplier = resolveFrameBufferMultiplier(payload.zoom)
    const bufferTargetWidth = Math.max(1, Math.floor(width * bufferMultiplier))
    const bufferMargin = Math.floor(((bufferMultiplier - 1) * width) / 2)
    const desiredBufferStart = Math.max(0, Math.floor(startX - bufferMargin))
    const canReuseBuffer =
      slot.canvas &&
      slot.key === key &&
      slot.width === bufferTargetWidth &&
      slot.height === height &&
      startX >= slot.startX &&
      startX + width <= slot.startX + slot.width

    if (!canReuseBuffer) {
      slot.key = key
      slot.startX = desiredBufferStart
      slot.width = bufferTargetWidth
      slot.height = height
      const ensured = ensureBufferCanvas(slot, slot.width, slot.height, pixelRatio)
      if (!ensured.ctx) return
      renderTracksToContextCpu(ensured.ctx, payload, slot.startX, startY, slot.width, slot.height)
    }

    if (!drawOutput) return
    const output = ensureOutputCanvas(width, height, pixelRatio)
    const ctx = output.ctx
    if (!ctx || !slot.canvas) return
    const srcX = Math.max(0, Math.floor((startX - slot.startX) * pixelRatio))
    const srcY = 0
    const srcW = Math.max(1, Math.floor(width * pixelRatio))
    const srcH = Math.max(1, Math.floor(height * pixelRatio))
    ctx.drawImage(slot.canvas, srcX, srcY, srcW, srcH, 0, 0, width, height)
  }

  const createShader = (type: number, source: string) => {
    if (!gl) return null
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader)
      return null
    }
    return shader
  }

  const createProgram = (vsSource: string, fsSource: string) => {
    if (!gl) return null
    const vs = createShader(gl.VERTEX_SHADER, vsSource)
    const fs = createShader(gl.FRAGMENT_SHADER, fsSource)
    if (!vs || !fs) return null
    const program = gl.createProgram()
    if (!program) return null
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program)
      return null
    }
    return program
  }

  const initWebGL = () => {
    if (glReady) return true
    if (!outputCanvas) return false
    const context =
      (outputCanvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: false
      }) as WebGL2RenderingContext | null) ||
      (outputCanvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: false
      }) as WebGLRenderingContext | null)
    if (!context) return false
    gl = context
    glReady = true
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    glQuadBuffer = gl.createBuffer()
    if (!glQuadBuffer) return false
    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW
    )
    const vsSource = `
      attribute vec2 a_pos;
      uniform vec2 u_resolution;
      uniform vec4 u_rect;
      uniform vec4 u_texRect;
      varying vec2 v_tex;
      void main() {
        vec2 pos = u_rect.xy + a_pos * u_rect.zw;
        vec2 zeroToOne = pos / u_resolution;
        vec2 clip = zeroToOne * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        v_tex = mix(u_texRect.xy, u_texRect.zw, a_pos);
      }
    `
    const fsTexSource = `
      precision mediump float;
      varying vec2 v_tex;
      uniform sampler2D u_tex;
      void main() {
        gl_FragColor = texture2D(u_tex, v_tex);
      }
    `
    const fsColorSource = `
      precision mediump float;
      uniform vec4 u_color;
      void main() {
        gl_FragColor = u_color;
      }
    `
    glProgramTex = createProgram(vsSource, fsTexSource)
    glProgramColor = createProgram(vsSource, fsColorSource)
    if (!glProgramTex || !glProgramColor) {
      glReady = false
      return false
    }
    glTexLocations = {
      aPos: gl.getAttribLocation(glProgramTex, 'a_pos'),
      uResolution: gl.getUniformLocation(glProgramTex, 'u_resolution'),
      uRect: gl.getUniformLocation(glProgramTex, 'u_rect'),
      uTex: gl.getUniformLocation(glProgramTex, 'u_tex'),
      uTexRect: gl.getUniformLocation(glProgramTex, 'u_texRect')
    }
    glColorLocations = {
      aPos: gl.getAttribLocation(glProgramColor, 'a_pos'),
      uResolution: gl.getUniformLocation(glProgramColor, 'u_resolution'),
      uRect: gl.getUniformLocation(glProgramColor, 'u_rect'),
      uColor: gl.getUniformLocation(glProgramColor, 'u_color')
    }
    gl.useProgram(glProgramTex)
    if (glTexLocations.uTex) gl.uniform1i(glTexLocations.uTex, 0)
    if (glTexLocations.uTexRect) gl.uniform4f(glTexLocations.uTexRect, 0, 0, 1, 1)
    glActiveProgram = null
    return true
  }

  const useTextureProgram = (width: number, height: number) => {
    if (!gl || !glProgramTex || !glTexLocations || !glQuadBuffer) return false
    if (glActiveProgram !== glProgramTex) {
      gl.useProgram(glProgramTex)
      glActiveProgram = glProgramTex
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer)
    if (glTexLocations.aPos >= 0) {
      gl.enableVertexAttribArray(glTexLocations.aPos)
      gl.vertexAttribPointer(glTexLocations.aPos, 2, gl.FLOAT, false, 0, 0)
    }
    if (glTexLocations.uResolution) gl.uniform2f(glTexLocations.uResolution, width, height)
    return true
  }

  const useColorProgram = (width: number, height: number) => {
    if (!gl || !glProgramColor || !glColorLocations || !glQuadBuffer) return false
    if (glActiveProgram !== glProgramColor) {
      gl.useProgram(glProgramColor)
      glActiveProgram = glProgramColor
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer)
    if (glColorLocations.aPos >= 0) {
      gl.enableVertexAttribArray(glColorLocations.aPos)
      gl.vertexAttribPointer(glColorLocations.aPos, 2, gl.FLOAT, false, 0, 0)
    }
    if (glColorLocations.uResolution) gl.uniform2f(glColorLocations.uResolution, width, height)
    return true
  }

  const setTextureRect = (u0: number, v0: number, u1: number, v1: number) => {
    if (!gl || !glTexLocations?.uTexRect) return
    gl.uniform4f(glTexLocations.uTexRect, u0, v0, u1, v1)
  }

  const drawTextureRect = (texture: WebGLTexture, x: number, y: number, w: number, h: number) => {
    if (!gl || !glTexLocations) return
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    if (glTexLocations.uRect) gl.uniform4f(glTexLocations.uRect, x, y, w, h)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  const drawColorRect = (
    x: number,
    y: number,
    w: number,
    h: number,
    color: { r: number; g: number; b: number; a: number }
  ) => {
    if (!gl || !glColorLocations) return
    if (glColorLocations.uRect) gl.uniform4f(glColorLocations.uRect, x, y, w, h)
    if (glColorLocations.uColor)
      gl.uniform4f(glColorLocations.uColor, color.r, color.g, color.b, color.a)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  const createTextureFromBitmap = (bitmap: ImageBitmap) => {
    if (!gl) return null
    const texture = gl.createTexture()
    if (!texture) return null
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    return texture
  }

  const ensureBufferTexture = (
    slot: FrameBufferSlot,
    width: number,
    height: number,
    pixelRatio: number
  ) => {
    if (!gl) return null
    const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
    const scaledHeight = Math.max(1, Math.floor(height * pixelRatio))
    if (!slot.texture) {
      slot.texture = gl.createTexture()
      if (!slot.texture) return null
      gl.bindTexture(gl.TEXTURE_2D, slot.texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    } else {
      gl.bindTexture(gl.TEXTURE_2D, slot.texture)
    }
    if (scaledWidth !== slot.texWidth || scaledHeight !== slot.texHeight) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        scaledWidth,
        scaledHeight,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null
      )
      slot.texWidth = scaledWidth
      slot.texHeight = scaledHeight
    }
    if (!slot.fbo) {
      slot.fbo = gl.createFramebuffer()
    }
    if (!slot.fbo) return null
    gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, slot.texture, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) return null
    return { texture: slot.texture, width: scaledWidth, height: scaledHeight }
  }

  const getTileTexture = (
    filePath: string,
    zoom: number,
    tileIndex: number,
    tileStart: number,
    tileWidth: number,
    trackWidth: number,
    durationSeconds: number,
    laneHeight: number,
    pixelRatio: number,
    allowBuild: boolean = true
  ) => {
    const cacheKey = buildTileCacheKey(
      filePath,
      tileIndex,
      zoom,
      Math.max(1, Math.floor(tileWidth)),
      Math.max(1, Math.floor(laneHeight)),
      pixelRatio
    )
    let cached = tileCache.get(cacheKey)
    if (!cached) {
      if (!allowBuild) return null
      const bitmap = renderTileBitmap({
        cacheKey,
        filePath,
        zoom,
        tileIndex,
        tileStart,
        tileWidth,
        trackWidth,
        durationSeconds,
        laneHeight,
        pixelRatio
      })
      if (!bitmap) return null
      const texture = createTextureFromBitmap(bitmap)
      try {
        bitmap.close()
      } catch {}
      if (!texture) return null
      tileCacheTick += 1
      tileCache.set(cacheKey, { texture, used: tileCacheTick })
      registerTileCacheKey(filePath, cacheKey)
      pruneTileCache()
      cached = tileCache.get(cacheKey)
    }
    if (cached) {
      touchTileCache(cacheKey)
      return cached.texture
    }
    return null
  }

  const renderFrameWebgl = (
    payload: RenderFramePayload,
    slot: FrameBufferSlot,
    drawOutput: boolean
  ) => {
    if (!gl && !initWebGL()) return
    if (!gl) return
    const { width, height, pixelRatio, startX, startY } = payload
    const showGridLines = payload.showGridLines !== false
    const allowTileBuild = payload.allowTileBuild !== false
    const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
    const scaledHeight = Math.max(1, Math.floor(height * pixelRatio))
    const key = buildFrameKey(payload)
    const bufferMultiplier = resolveFrameBufferMultiplier(payload.zoom)
    const bufferTargetWidth = Math.max(1, Math.floor(width * bufferMultiplier))
    const bufferMargin = Math.floor(((bufferMultiplier - 1) * width) / 2)
    const desiredBufferStart = Math.max(0, Math.floor(startX - bufferMargin))
    const canReuseBuffer =
      slot.texture &&
      slot.key === key &&
      slot.width === bufferTargetWidth &&
      slot.height === height &&
      startX >= slot.startX &&
      startX + width <= slot.startX + slot.width

    if (!canReuseBuffer) {
      slot.key = key
      slot.startX = desiredBufferStart
      slot.width = bufferTargetWidth
      slot.height = height
      const bufferTarget = ensureBufferTexture(slot, slot.width, slot.height, pixelRatio)
      if (!bufferTarget) {
        renderFrameCpu(payload, slot, drawOutput)
        return
      }
      if (!slot.fbo) return
      gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fbo)
      gl.viewport(0, 0, bufferTarget.width, bufferTarget.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (!useTextureProgram(slot.width, slot.height)) return
      setTextureRect(0, 0, 1, 1)
      const laneStride = payload.laneHeight + payload.laneGap
      const endX = slot.startX + slot.width
      for (const track of payload.tracks) {
        const filePath = track.filePath
        if (!filePath) continue
        const trackWidth = track.trackWidth
        if (!trackWidth || !Number.isFinite(trackWidth)) continue
        const trackStartX = Number(track.startX) || 0
        const trackEndX = trackStartX + trackWidth
        const trackY = payload.lanePaddingTop + track.laneIndex * laneStride - startY
        if (trackY > slot.height || trackY + payload.laneHeight < 0) continue
        const visibleStart = Math.max(trackStartX, slot.startX)
        const visibleEnd = Math.min(trackEndX, endX)
        if (visibleEnd <= visibleStart) continue
        const localStart = visibleStart - trackStartX
        const localEnd = visibleEnd - trackStartX

        const tileStartIndex = Math.max(0, Math.floor(localStart / waveformTileWidth))
        const tileEndIndex = Math.max(
          tileStartIndex,
          Math.floor(Math.max(0, localEnd - 1) / waveformTileWidth)
        )
        for (let tileIndex = tileStartIndex; tileIndex <= tileEndIndex; tileIndex += 1) {
          const tileStart = tileIndex * waveformTileWidth
          const tileWidth = Math.max(0, Math.min(waveformTileWidth, trackWidth - tileStart))
          if (!tileWidth) continue
          const texture = getTileTexture(
            filePath,
            payload.zoom,
            tileIndex,
            tileStart,
            tileWidth,
            trackWidth,
            track.durationSeconds,
            payload.laneHeight,
            payload.pixelRatio,
            allowTileBuild
          )
          if (texture) {
            drawTextureRect(
              texture,
              trackStartX + tileStart - slot.startX,
              trackY,
              tileWidth,
              payload.laneHeight
            )
          }
        }
      }

      if (showGridLines) {
        if (!useColorProgram(slot.width, slot.height)) return
        const barOnlyGrid = payload.zoom <= gridBarOnlyZoom
        const barWidth = resolveGridBarWidth(payload.zoom)
        for (const track of payload.tracks) {
          const trackWidth = track.trackWidth
          if (!trackWidth || !Number.isFinite(trackWidth)) continue
          const trackStartX = Number(track.startX) || 0
          const trackEndX = trackStartX + trackWidth
          const trackY = payload.lanePaddingTop + track.laneIndex * laneStride - startY
          if (trackY > slot.height || trackY + payload.laneHeight < 0) continue
          const visibleStart = Math.max(trackStartX, slot.startX)
          const visibleEnd = Math.min(trackEndX, endX)
          if (visibleEnd <= visibleStart) continue
          const localStart = visibleStart - trackStartX
          const localEnd = visibleEnd - trackStartX
          const interval = (60 / track.bpm) * payload.renderPxPerSec
          if (!Number.isFinite(interval) || interval <= 0) continue
          const offsetPx = (track.firstBeatMs / 1000) * payload.renderPxPerSec
          const startIndex = Math.floor((localStart - offsetPx) / interval) - 2
          const endIndex = Math.ceil((localEnd - offsetPx) / interval) + 2
          for (let i = startIndex; i <= endIndex; i += 1) {
            const rawX = offsetPx + i * interval
            if (rawX < localStart - interval || rawX > localEnd + interval) continue
            const mod32 = ((i % 32) + 32) % 32
            const mod4 = ((i % 4) + 4) % 4
            const level = mod32 === 0 ? 'bar' : mod4 === 0 ? 'beat4' : 'beat'
            if (barOnlyGrid && level !== 'bar') continue
            if (level === 'beat') continue
            const x = Math.round(rawX + trackStartX - slot.startX)
            if (level === 'bar') {
              drawColorRect(x, trackY, barWidth, payload.laneHeight, {
                r: 0,
                g: 0.43,
                b: 0.86,
                a: 0.95
              })
            } else if (level === 'beat4') {
              drawColorRect(x, trackY, 1.5, payload.laneHeight, {
                r: 0.47,
                g: 0.78,
                b: 1,
                a: 0.85
              })
            } else {
              drawColorRect(x, trackY, 1, payload.laneHeight, { r: 1, g: 1, b: 1, a: 0.4 })
            }
          }
        }
      }

      if (debugTrackLines) {
        for (const track of payload.tracks) {
          const trackWidth = track.trackWidth
          if (!trackWidth || !Number.isFinite(trackWidth)) continue
          const trackY = payload.lanePaddingTop + track.laneIndex * laneStride - startY
          if (trackY > slot.height || trackY + payload.laneHeight < 0) continue
          drawColorRect(0, Math.round(trackY), slot.width, 1, { r: 1, g: 0.25, b: 0.25, a: 0.9 })
          drawColorRect(0, Math.round(trackY + payload.laneHeight - 1), slot.width, 1, {
            r: 0.25,
            g: 0.78,
            b: 1,
            a: 0.9
          })
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }

    if (!drawOutput) return
    if (outputCanvas) {
      if (outputCanvas.width !== scaledWidth) outputCanvas.width = scaledWidth
      if (outputCanvas.height !== scaledHeight) outputCanvas.height = scaledHeight
    }
    gl.viewport(0, 0, scaledWidth, scaledHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (!slot.texture) return
    if (!useTextureProgram(width, height)) return
    const u0 = slot.width > 0 ? (startX - slot.startX) / slot.width : 0
    const u1 = slot.width > 0 ? (startX - slot.startX + width) / slot.width : 1
    const vSpan = slot.height > 0 ? height / slot.height : 1
    setTextureRect(u0, 1, u1, 1 - vSpan)
    drawTextureRect(slot.texture, 0, 0, width, height)
  }

  const renderFrame = (payload: RenderFramePayload, options: { cacheOnly?: boolean } = {}) => {
    const bufferId = resolveFrameBufferId(payload)
    const slot = getFrameBufferSlot(bufferId)
    const drawOutput = !options.cacheOnly
    if (mixTapeWebglEnabled && initWebGL()) {
      renderFrameWebgl(payload, slot, drawOutput)
    } else {
      renderFrameCpu(payload, slot, drawOutput)
    }
  }

  const initCanvas = (canvas: OffscreenCanvas) => {
    outputCanvas = canvas
    outputCtx = null
    gl = null
    glReady = false
    glProgramTex = null
    glProgramColor = null
    glQuadBuffer = null
    glActiveProgram = null
    clearFrameBufferSlots()
    initWebGL()
    if (!glReady && outputCanvas) {
      outputCtx = outputCanvas.getContext('2d')
    }
  }

  const warmTileTexture = (task: RenderTilePayload) => {
    getTileTexture(
      task.filePath,
      task.zoom,
      task.tileIndex,
      task.tileStart,
      task.tileWidth,
      task.trackWidth,
      task.durationSeconds,
      task.laneHeight,
      task.pixelRatio
    )
  }

  const ensureTileCacheLimit = (targetLimit: number) => {
    if (targetLimit > tileCacheLimit) {
      tileCacheLimit = targetLimit
    }
  }

  const getTileCacheSize = () => tileCache.size

  return {
    initCanvas,
    renderFrame,
    warmTileTexture,
    clearTileCacheForFile,
    clearAllCaches,
    ensureTileCacheLimit,
    getTileCacheSize
  }
}
