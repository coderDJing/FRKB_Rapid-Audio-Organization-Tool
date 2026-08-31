export const AUDIO_EDIT_MAX_DURATION_SEC = 30 * 60
export const AUDIO_EDIT_EPSILON_SEC = 1e-4

export type AudioEditClip = {
  id: string
  sourceStartSec: number
  sourceEndSec: number
}

export type AudioEditRange = {
  startSec: number
  endSec: number
}

export type AudioEditLoopGroup = {
  clips: AudioEditClip[]
  count: number
  insertPlanSec: number
}

export type AudioEditMarker = {
  sec: number
}

const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min))

// 与 Beat Grid 的秒精度一致，避免接缝四舍五入到 1ms / 0.1ms 后和网格线错开。
export const AUDIO_EDIT_SECONDS_DECIMALS = 6

export const roundAudioEditSec = (value: number) =>
  Number(Math.max(0, Number(value) || 0).toFixed(AUDIO_EDIT_SECONDS_DECIMALS))

export const isAudioEditRangeComplete = (range: Partial<AudioEditRange> | null | undefined) => {
  if (!range) return false
  const startSec = Number(range.startSec)
  const endSec = Number(range.endSec)
  return (
    Number.isFinite(startSec) &&
    Number.isFinite(endSec) &&
    endSec - startSec > AUDIO_EDIT_EPSILON_SEC
  )
}

export const normalizeAudioEditRange = (
  startSec: number,
  endSec: number
): AudioEditRange | null => {
  const left = roundAudioEditSec(startSec)
  const right = roundAudioEditSec(endSec)
  if (Math.abs(right - left) <= AUDIO_EDIT_EPSILON_SEC) return null
  return left <= right ? { startSec: left, endSec: right } : { startSec: right, endSec: left }
}

export const createIdentityAudioEditClips = (
  sourceDurationSec: number,
  createId: () => string
): AudioEditClip[] => {
  const durationSec = roundAudioEditSec(sourceDurationSec)
  if (durationSec <= AUDIO_EDIT_EPSILON_SEC) return []
  return [
    {
      id: createId(),
      sourceStartSec: 0,
      sourceEndSec: durationSec
    }
  ]
}

export const resolveAudioEditPlanDuration = (clips: readonly AudioEditClip[]) =>
  roundAudioEditSec(
    clips.reduce((sum, clip) => {
      const durationSec = roundAudioEditSec(clip.sourceEndSec - clip.sourceStartSec)
      return durationSec > AUDIO_EDIT_EPSILON_SEC ? sum + durationSec : sum
    }, 0)
  )

export const isIdentityAudioEditClips = (
  clips: readonly AudioEditClip[],
  sourceDurationSec: number
) => {
  if (sourceDurationSec <= AUDIO_EDIT_EPSILON_SEC) return clips.length === 0
  if (clips.length !== 1) return false
  const clip = clips[0]
  return (
    clip.sourceStartSec <= AUDIO_EDIT_EPSILON_SEC &&
    Math.abs(clip.sourceEndSec - sourceDurationSec) <= AUDIO_EDIT_EPSILON_SEC
  )
}

export const cloneAudioEditClips = (clips: readonly AudioEditClip[]): AudioEditClip[] =>
  clips.map((clip) => ({
    id: clip.id,
    sourceStartSec: clip.sourceStartSec,
    sourceEndSec: clip.sourceEndSec
  }))

export const cloneAudioEditLoopGroup = (
  group: AudioEditLoopGroup | null | undefined
): AudioEditLoopGroup | null =>
  group
    ? {
        clips: cloneAudioEditClips(group.clips),
        count: Math.max(0, Math.floor(Number(group.count) || 0)),
        insertPlanSec: roundAudioEditSec(group.insertPlanSec)
      }
    : null

const clipDurationSec = (clip: AudioEditClip) =>
  roundAudioEditSec(Math.max(0, clip.sourceEndSec - clip.sourceStartSec))

export const mergeAdjacentAudioEditClips = (clips: readonly AudioEditClip[]): AudioEditClip[] => {
  const merged: AudioEditClip[] = []
  for (const clip of clips) {
    if (clipDurationSec(clip) <= AUDIO_EDIT_EPSILON_SEC) continue
    const previous = merged[merged.length - 1]
    if (
      previous &&
      Math.abs(previous.sourceEndSec - clip.sourceStartSec) <= AUDIO_EDIT_EPSILON_SEC
    ) {
      previous.sourceEndSec = clip.sourceEndSec
      continue
    }
    merged.push({
      id: clip.id,
      sourceStartSec: clip.sourceStartSec,
      sourceEndSec: clip.sourceEndSec
    })
  }
  return merged
}

export const mapAudioEditPlanToSource = (
  clips: readonly AudioEditClip[],
  planSec: number
): { sourceSec: number; clipIndex: number; clipPlanStartSec: number } | null => {
  const durationSec = resolveAudioEditPlanDuration(clips)
  const safePlanSec = clampNumber(roundAudioEditSec(planSec), 0, durationSec)
  let cursorSec = 0
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index]
    const lengthSec = clipDurationSec(clip)
    if (lengthSec <= AUDIO_EDIT_EPSILON_SEC) continue
    const clipEndSec = roundAudioEditSec(cursorSec + lengthSec)
    const isLast = index === clips.length - 1
    const contains =
      safePlanSec + AUDIO_EDIT_EPSILON_SEC >= cursorSec &&
      (isLast
        ? safePlanSec <= clipEndSec + AUDIO_EDIT_EPSILON_SEC
        : safePlanSec < clipEndSec - AUDIO_EDIT_EPSILON_SEC)
    if (contains) {
      const offsetSec = clampNumber(safePlanSec - cursorSec, 0, lengthSec)
      return {
        sourceSec: roundAudioEditSec(clip.sourceStartSec + offsetSec),
        clipIndex: index,
        clipPlanStartSec: cursorSec
      }
    }
    cursorSec = clipEndSec
  }
  return null
}

export const mapAudioEditSourceToPlan = (
  clips: readonly AudioEditClip[],
  sourceSec: number
): number | null => {
  let cursorSec = 0
  for (const clip of clips) {
    const lengthSec = clipDurationSec(clip)
    if (lengthSec <= AUDIO_EDIT_EPSILON_SEC) {
      continue
    }
    if (
      sourceSec + AUDIO_EDIT_EPSILON_SEC >= clip.sourceStartSec &&
      sourceSec <= clip.sourceEndSec + AUDIO_EDIT_EPSILON_SEC
    ) {
      const offsetSec = clampNumber(sourceSec - clip.sourceStartSec, 0, lengthSec)
      return roundAudioEditSec(cursorSec + offsetSec)
    }
    cursorSec = roundAudioEditSec(cursorSec + lengthSec)
  }
  return null
}

export const splitAudioEditClipsAt = (
  clips: readonly AudioEditClip[],
  planSec: number,
  createId: () => string
): AudioEditClip[] => {
  const mapped = mapAudioEditPlanToSource(clips, planSec)
  if (!mapped) return cloneAudioEditClips(clips)
  const clip = clips[mapped.clipIndex]
  const offsetSec = roundAudioEditSec(mapped.sourceSec - clip.sourceStartSec)
  if (
    offsetSec <= AUDIO_EDIT_EPSILON_SEC ||
    clip.sourceEndSec - mapped.sourceSec <= AUDIO_EDIT_EPSILON_SEC
  ) {
    return cloneAudioEditClips(clips)
  }
  const next = cloneAudioEditClips(clips)
  next.splice(
    mapped.clipIndex,
    1,
    {
      id: clip.id,
      sourceStartSec: clip.sourceStartSec,
      sourceEndSec: mapped.sourceSec
    },
    {
      id: createId(),
      sourceStartSec: mapped.sourceSec,
      sourceEndSec: clip.sourceEndSec
    }
  )
  return next
}

export const extractAudioEditRange = (
  clips: readonly AudioEditClip[],
  range: AudioEditRange,
  createId: () => string
): { remaining: AudioEditClip[]; extracted: AudioEditClip[] } => {
  const startSec = roundAudioEditSec(range.startSec)
  const endSec = roundAudioEditSec(range.endSec)
  if (endSec - startSec <= AUDIO_EDIT_EPSILON_SEC) {
    return { remaining: cloneAudioEditClips(clips), extracted: [] }
  }
  const splitStart = splitAudioEditClipsAt(clips, startSec, createId)
  const splitBoth = splitAudioEditClipsAt(splitStart, endSec, createId)
  const extracted: AudioEditClip[] = []
  const remaining: AudioEditClip[] = []
  let cursorSec = 0
  for (const clip of splitBoth) {
    const lengthSec = clipDurationSec(clip)
    const clipStartSec = cursorSec
    const clipEndSec = roundAudioEditSec(cursorSec + lengthSec)
    cursorSec = clipEndSec
    if (lengthSec <= AUDIO_EDIT_EPSILON_SEC) continue
    const inside =
      clipStartSec + AUDIO_EDIT_EPSILON_SEC >= startSec &&
      clipEndSec <= endSec + AUDIO_EDIT_EPSILON_SEC
    if (inside) extracted.push({ ...clip, id: createId() })
    else remaining.push(clip)
  }
  return {
    remaining: mergeAdjacentAudioEditClips(remaining),
    extracted: extracted
  }
}

export const insertAudioEditClipsAt = (
  clips: readonly AudioEditClip[],
  planSec: number,
  inserted: readonly AudioEditClip[],
  createId: () => string
): AudioEditClip[] => {
  if (!inserted.length) return cloneAudioEditClips(clips)
  const durationSec = resolveAudioEditPlanDuration(clips)
  const insertSec = clampNumber(roundAudioEditSec(planSec), 0, durationSec)
  const split = splitAudioEditClipsAt(clips, insertSec, createId)
  const copies = inserted.map((clip) => ({
    id: createId(),
    sourceStartSec: clip.sourceStartSec,
    sourceEndSec: clip.sourceEndSec
  }))
  if (insertSec <= AUDIO_EDIT_EPSILON_SEC) {
    return mergeAdjacentAudioEditClips([...copies, ...split])
  }
  if (Math.abs(insertSec - durationSec) <= AUDIO_EDIT_EPSILON_SEC) {
    return mergeAdjacentAudioEditClips([...split, ...copies])
  }
  let cursorSec = 0
  const before: AudioEditClip[] = []
  const after: AudioEditClip[] = []
  for (const clip of split) {
    const lengthSec = clipDurationSec(clip)
    const clipEndSec = roundAudioEditSec(cursorSec + lengthSec)
    if (clipEndSec <= insertSec + AUDIO_EDIT_EPSILON_SEC) before.push(clip)
    else after.push(clip)
    cursorSec = clipEndSec
  }
  return mergeAdjacentAudioEditClips([...before, ...copies, ...after])
}

export const wouldExceedAudioEditDuration = (
  currentDurationSec: number,
  extraDurationSec: number
) => roundAudioEditSec(currentDurationSec + extraDurationSec) > AUDIO_EDIT_MAX_DURATION_SEC

export const migrateAudioEditMarkers = <T extends AudioEditMarker>(
  markers: readonly T[],
  previousClips: readonly AudioEditClip[],
  nextClips: readonly AudioEditClip[],
  removedRange: AudioEditRange | null
): T[] => {
  const result: T[] = []
  for (const marker of markers) {
    const sec = Number(marker.sec)
    if (!Number.isFinite(sec)) continue
    if (removedRange) {
      if (
        sec + AUDIO_EDIT_EPSILON_SEC >= removedRange.startSec &&
        sec < removedRange.endSec - AUDIO_EDIT_EPSILON_SEC
      ) {
        continue
      }
    }
    const sourceSec = mapAudioEditPlanToSource(previousClips, sec)?.sourceSec
    if (sourceSec === undefined) continue
    const nextSec = mapAudioEditSourceToPlan(nextClips, sourceSec)
    if (nextSec === null) continue
    result.push({ ...marker, sec: nextSec })
  }
  return result
}

export const shiftAudioEditRangeAfterMutation = (
  range: AudioEditRange | null,
  previousClips: readonly AudioEditClip[],
  nextClips: readonly AudioEditClip[],
  removedRange: AudioEditRange | null
): AudioEditRange | null => {
  if (!range) return null
  if (
    removedRange &&
    range.startSec + AUDIO_EDIT_EPSILON_SEC >= removedRange.startSec &&
    range.endSec <= removedRange.endSec + AUDIO_EDIT_EPSILON_SEC
  ) {
    return null
  }
  const startSource = mapAudioEditPlanToSource(previousClips, range.startSec)?.sourceSec
  const endSource = mapAudioEditPlanToSource(
    previousClips,
    Math.max(range.startSec, range.endSec - AUDIO_EDIT_EPSILON_SEC)
  )?.sourceSec
  if (startSource === undefined || endSource === undefined) return null
  const nextStart = mapAudioEditSourceToPlan(nextClips, startSource)
  const nextEnd = mapAudioEditSourceToPlan(nextClips, endSource)
  if (nextStart === null || nextEnd === null) return null
  return normalizeAudioEditRange(nextStart, nextEnd + AUDIO_EDIT_EPSILON_SEC)
}

export const shiftAudioEditRangeAfterInsertion = (
  range: AudioEditRange | null,
  insertSec: number,
  insertedDurationSec: number
): AudioEditRange | null => {
  if (!range) return null
  const durationSec = roundAudioEditSec(insertedDurationSec)
  if (durationSec <= AUDIO_EDIT_EPSILON_SEC) return { ...range }
  const pointSec = roundAudioEditSec(insertSec)
  if (pointSec > range.startSec + AUDIO_EDIT_EPSILON_SEC) return { ...range }
  return {
    startSec: roundAudioEditSec(range.startSec + durationSec),
    endSec: roundAudioEditSec(range.endSec + durationSec)
  }
}

export const shiftAudioEditRangeAfterRemoval = (
  range: AudioEditRange | null,
  removedRange: AudioEditRange
): AudioEditRange | null => {
  if (!range) return null
  const removed = normalizeAudioEditRange(removedRange.startSec, removedRange.endSec)
  if (!removed) return { ...range }
  if (removed.startSec >= range.endSec - AUDIO_EDIT_EPSILON_SEC) return { ...range }
  const removedDurationSec = removed.endSec - removed.startSec
  if (removed.endSec <= range.startSec + AUDIO_EDIT_EPSILON_SEC) {
    return {
      startSec: roundAudioEditSec(range.startSec - removedDurationSec),
      endSec: roundAudioEditSec(range.endSec - removedDurationSec)
    }
  }
  const mapBoundary = (seconds: number) => {
    if (seconds <= removed.startSec + AUDIO_EDIT_EPSILON_SEC) return seconds
    if (seconds >= removed.endSec - AUDIO_EDIT_EPSILON_SEC) {
      return roundAudioEditSec(seconds - removedDurationSec)
    }
    return removed.startSec
  }
  return normalizeAudioEditRange(mapBoundary(range.startSec), mapBoundary(range.endSec))
}

export const cloneAudioEditRanges = (ranges: readonly AudioEditRange[]): AudioEditRange[] =>
  ranges.map((range) => ({ startSec: range.startSec, endSec: range.endSec }))

export const mergeAudioEditPlanRanges = (ranges: readonly AudioEditRange[]): AudioEditRange[] => {
  const sorted = cloneAudioEditRanges(ranges)
    .map((range) => normalizeAudioEditRange(range.startSec, range.endSec))
    .filter((range): range is AudioEditRange => range !== null)
    .sort((left, right) => left.startSec - right.startSec)
  const merged: AudioEditRange[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && range.startSec <= previous.endSec + AUDIO_EDIT_EPSILON_SEC) {
      previous.endSec = Math.max(previous.endSec, range.endSec)
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

const shiftAudioEditPlanRangeAfterInsertion = (
  range: AudioEditRange,
  insertSec: number,
  insertedDurationSec: number
): AudioEditRange | null => {
  const durationSec = roundAudioEditSec(insertedDurationSec)
  const pointSec = roundAudioEditSec(insertSec)
  if (durationSec <= AUDIO_EDIT_EPSILON_SEC) return { ...range }
  if (range.endSec <= pointSec + AUDIO_EDIT_EPSILON_SEC) return { ...range }
  if (range.startSec >= pointSec - AUDIO_EDIT_EPSILON_SEC) {
    return {
      startSec: roundAudioEditSec(range.startSec + durationSec),
      endSec: roundAudioEditSec(range.endSec + durationSec)
    }
  }
  return {
    startSec: range.startSec,
    endSec: roundAudioEditSec(range.endSec + durationSec)
  }
}

export const applyAudioEditInsertedRangesMutation = (
  ranges: readonly AudioEditRange[],
  mutation:
    | { kind: 'insert'; insertSec: number; durationSec: number }
    | { kind: 'remove'; range: AudioEditRange }
): AudioEditRange[] => {
  if (mutation.kind === 'remove') {
    return mergeAudioEditPlanRanges(
      ranges
        .map((range) => shiftAudioEditRangeAfterRemoval(range, mutation.range))
        .filter((range): range is AudioEditRange => range !== null)
    )
  }
  const durationSec = roundAudioEditSec(mutation.durationSec)
  const shifted = ranges
    .map((range) => shiftAudioEditPlanRangeAfterInsertion(range, mutation.insertSec, durationSec))
    .filter((range): range is AudioEditRange => range !== null)
  if (durationSec <= AUDIO_EDIT_EPSILON_SEC) return mergeAudioEditPlanRanges(shifted)
  const inserted = normalizeAudioEditRange(
    mutation.insertSec,
    roundAudioEditSec(mutation.insertSec + durationSec)
  )
  return mergeAudioEditPlanRanges(inserted ? [...shifted, inserted] : shifted)
}

export const createSourceRangeClips = (
  sourceStartSec: number,
  sourceEndSec: number,
  createId: () => string
): AudioEditClip[] => {
  const range = normalizeAudioEditRange(sourceStartSec, sourceEndSec)
  if (!range) return []
  return [
    {
      id: createId(),
      sourceStartSec: range.startSec,
      sourceEndSec: range.endSec
    }
  ]
}

export const resolveLoopGroupEndPlanSec = (group: AudioEditLoopGroup) =>
  roundAudioEditSec(
    group.insertPlanSec + Math.max(0, group.count) * resolveAudioEditPlanDuration(group.clips)
  )

export const parseAudioEditVersionBaseTitle = (title: string) => {
  const raw = String(title || '').trim()
  const matched = /^(.*) \((\d+)\)$/.exec(raw)
  if (!matched) return raw
  return matched[1].trim() || raw
}

export const resolveNextAudioEditVersionNumber = (
  baseTitle: string,
  existingNames: readonly string[]
) => {
  const escaped = baseTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matcher = new RegExp(`^${escaped} \\((\\d+)\\)$`)
  let maxUsed = 1
  for (const name of existingNames) {
    const matched = matcher.exec(String(name || '').trim())
    if (!matched) continue
    const value = Number(matched[1])
    if (Number.isFinite(value)) maxUsed = Math.max(maxUsed, value)
  }
  return maxUsed + 1
}

export const buildAudioEditVersionLabel = (baseTitle: string, versionNumber: number) =>
  `${baseTitle} (${versionNumber})`

export const formatAudioEditClock = (sec: number) => {
  const safeSec = Math.max(0, Number(sec) || 0)
  const minutes = Math.floor(safeSec / 60)
  const seconds = Math.floor(safeSec % 60)
  const millis = Math.round((safeSec - Math.floor(safeSec)) * 100)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(2, '0')}`
}

export const estimateAudioEditBeats = (durationSec: number, bpm: number) => {
  const beatSec = Number(bpm) > 0 ? 60 / Number(bpm) : 0
  if (!(beatSec > 0)) return 0
  return Math.max(1, Math.round(durationSec / beatSec))
}

export const buildAudioEditPlaybackSequence = (clips: readonly AudioEditClip[]) => {
  const segments: Array<{
    sourceStartSec: number
    sourceEndSec: number
    planStartSec: number
    planEndSec: number
  }> = []
  let planCursorSec = 0
  for (const clip of clips) {
    const lengthSec = clipDurationSec(clip)
    if (lengthSec <= AUDIO_EDIT_EPSILON_SEC) continue
    const planStartSec = planCursorSec
    planCursorSec = roundAudioEditSec(planCursorSec + lengthSec)
    segments.push({
      sourceStartSec: clip.sourceStartSec,
      sourceEndSec: clip.sourceEndSec,
      planStartSec,
      planEndSec: planCursorSec
    })
  }
  return {
    segments,
    totalPlanSec: planCursorSec
  }
}
