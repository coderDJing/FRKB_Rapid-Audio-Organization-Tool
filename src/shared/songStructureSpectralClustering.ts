/**
 * MSAF scluster / McFee & Ellis 2014 风格的光谱聚类实现。
 *
 * 公式与处理顺序参考：
 * https://github.com/urinieto/msaf/tree/main/msaf/algorithms/scluster
 * MSAF 对应实现采用 ISC 许可证。本文件为针对 FRKB bar 特征的 TypeScript 重写。
 */
import { EigenvalueDecomposition, Matrix } from 'ml-matrix'
import { clamp, clamp01, percentile, ramp } from './songStructureCommon'
import {
  cosineSimilarity,
  type SongStructureSpectralBarFeature
} from './songStructureSpectralFeatures'

const RECURRENCE_EXCLUSION_BARS = 4
const RECURRENCE_SMOOTH_RADIUS = 4
const EIGENVECTOR_SMOOTH_RADIUS = 4
const DEFAULT_CLUSTER_COUNT = 5
const MIN_CLUSTER_COUNT = 3
const MAX_CLUSTER_COUNT = 5
const KMEANS_RESTARTS = 16
const KMEANS_MAX_ITERATIONS = 160
const MIN_SECTION_BARS = 4
const BOUNDARY_REFINE_RADIUS_BARS = 2
const MAX_SPECTRAL_BARS = 320
const NOVELTY_CONTRAST_FLOOR = 0.045
const NOVELTY_PROMINENCE_FLOOR = 0.012
export const SONG_STRUCTURE_BUILD_RAMP_MIN_SCORE = 0.34
const CLIP_CONTRAST_SCALE = 0.58
const PHRASE_CONTRAST_SCALE = 0.72

export type SongStructureSpectralBoundary = {
  index: number
  score: number
  buildRamp?: number
}

export type SongStructureSpectralClusteringResult = {
  boundaries: SongStructureSpectralBoundary[]
  clusterIds: number[]
  clusterCount: number
}

type KMeansResult = {
  assignments: number[]
  inertia: number
}

type BoundaryEvidence = {
  score: number
  contrast: number
  prominence: number
  buildRamp: number
}

const squaredDistance = (left: readonly number[], right: readonly number[]) => {
  const length = Math.min(left.length, right.length)
  let total = 0
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    total += delta * delta
  }
  return total
}

const averageVectors = (
  values: readonly (readonly number[])[],
  startIndex: number,
  endIndex: number
) => {
  const start = clamp(Math.floor(startIndex), 0, values.length)
  const end = clamp(Math.ceil(endIndex), start, values.length)
  const dimensions = values[0]?.length ?? 0
  const result = new Array(dimensions).fill(0)
  if (end <= start) return result
  for (let index = start; index < end; index += 1) {
    const vector = values[index]
    if (!vector) continue
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      result[dimension] += (vector[dimension] ?? 0) / (end - start)
    }
  }
  return result
}

const createSquareMatrix = (size: number) =>
  Array.from({ length: size }, () => new Array(size).fill(0))

const buildRecurrenceAffinity = (bars: readonly SongStructureSpectralBarFeature[]) => {
  const count = bars.length
  const distances = createSquareMatrix(count)
  const neighborCount = clamp(Math.round(Math.sqrt(count)), 4, 18)
  const selectedDistances: number[] = []
  const selectedByRow: Array<Set<number>> = Array.from({ length: count }, () => new Set())

  for (let leftIndex = 0; leftIndex < count; leftIndex += 1) {
    const candidates: Array<{ index: number; distance: number }> = []
    for (let rightIndex = 0; rightIndex < count; rightIndex += 1) {
      if (Math.abs(leftIndex - rightIndex) < RECURRENCE_EXCLUSION_BARS) continue
      const similarity = cosineSimilarity(
        bars[leftIndex]?.recurrenceVector ?? [],
        bars[rightIndex]?.recurrenceVector ?? []
      )
      const distance = clamp(1 - similarity, 0, 2)
      distances[leftIndex]![rightIndex] = distance
      candidates.push({ index: rightIndex, distance })
    }
    candidates.sort((left, right) => left.distance - right.distance || left.index - right.index)
    for (const candidate of candidates.slice(0, neighborCount)) {
      selectedByRow[leftIndex]?.add(candidate.index)
      if (candidate.distance > 1e-8) selectedDistances.push(candidate.distance)
    }
  }

  const sigma = Math.max(0.035, percentile(selectedDistances, 0.5))
  const affinity = createSquareMatrix(count)
  for (let leftIndex = 0; leftIndex < count; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < count; rightIndex += 1) {
      const selected =
        selectedByRow[leftIndex]?.has(rightIndex) && selectedByRow[rightIndex]?.has(leftIndex)
      if (!selected) continue
      const distance = distances[leftIndex]?.[rightIndex] ?? distances[rightIndex]?.[leftIndex] ?? 0
      const value = Math.exp(-(distance * distance) / (2 * sigma * sigma))
      affinity[leftIndex]![rightIndex] = value
      affinity[rightIndex]![leftIndex] = value
    }
  }
  return affinity
}

const enhanceRecurrenceDiagonals = (affinity: readonly (readonly number[])[]) => {
  const count = affinity.length
  const result = createSquareMatrix(count)
  for (let leftIndex = 0; leftIndex < count; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < count; rightIndex += 1) {
      const diagonalValues: number[] = []
      for (
        let offset = -RECURRENCE_SMOOTH_RADIUS;
        offset <= RECURRENCE_SMOOTH_RADIUS;
        offset += 1
      ) {
        const left = leftIndex + offset
        const right = rightIndex + offset
        if (left < 0 || right < 0 || left >= count || right >= count) continue
        diagonalValues.push(affinity[left]?.[right] ?? 0)
      }
      result[leftIndex]![rightIndex] = percentile(diagonalValues, 0.5)
    }
  }
  return result
}

const buildPathAffinity = (bars: readonly SongStructureSpectralBarFeature[]) => {
  const count = bars.length
  const pathDistances: number[] = []
  for (let index = 0; index < count - 1; index += 1) {
    pathDistances.push(
      squaredDistance(bars[index]?.localVector ?? [], bars[index + 1]?.localVector ?? [])
    )
  }
  const sigma = Math.max(
    1e-5,
    percentile(
      pathDistances.filter((value) => value > 1e-9),
      0.5
    )
  )
  const result = createSquareMatrix(count)
  for (let index = 0; index < count - 1; index += 1) {
    const similarity = Math.exp(-(pathDistances[index] ?? 0) / sigma)
    result[index]![index + 1] = similarity
    result[index + 1]![index] = similarity
  }
  return result
}

const sumRows = (matrix: readonly (readonly number[])[]) =>
  matrix.map((row) => row.reduce((total, value) => total + value, 0))

const buildBalancedAffinity = (
  recurrence: readonly (readonly number[])[],
  path: readonly (readonly number[])[]
) => {
  const count = recurrence.length
  const recurrenceDegree = sumRows(recurrence)
  const pathDegree = sumRows(path)
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < count; index += 1) {
    const combined = (recurrenceDegree[index] ?? 0) + (pathDegree[index] ?? 0)
    numerator += (pathDegree[index] ?? 0) * combined
    denominator += combined * combined
  }
  const recurrenceWeight = denominator > 1e-12 ? clamp01(numerator / denominator) : 0.5
  const result = createSquareMatrix(count)
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      result[row]![column] =
        recurrenceWeight * (recurrence[row]?.[column] ?? 0) +
        (1 - recurrenceWeight) * (path[row]?.[column] ?? 0)
    }
  }
  return result
}

const buildNormalizedLaplacian = (affinity: readonly (readonly number[])[]) => {
  const count = affinity.length
  const degrees = sumRows(affinity)
  const result = createSquareMatrix(count)
  for (let row = 0; row < count; row += 1) {
    const rowScale = 1 / Math.sqrt(Math.max(1e-9, degrees[row] ?? 0))
    for (let column = 0; column < count; column += 1) {
      const columnScale = 1 / Math.sqrt(Math.max(1e-9, degrees[column] ?? 0))
      const normalized = (affinity[row]?.[column] ?? 0) * rowScale * columnScale
      result[row]![column] = (row === column ? 1 : 0) - normalized
    }
  }
  return result
}

const medianSmoothEigenvectors = (values: readonly (readonly number[])[]) => {
  const rows = values.length
  const columns = values[0]?.length ?? 0
  const result = Array.from({ length: rows }, () => new Array(columns).fill(0))
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const window: number[] = []
      for (
        let offset = -EIGENVECTOR_SMOOTH_RADIUS;
        offset <= EIGENVECTOR_SMOOTH_RADIUS;
        offset += 1
      ) {
        const sourceRow = row + offset
        if (sourceRow < 0 || sourceRow >= rows) continue
        window.push(values[sourceRow]?.[column] ?? 0)
      }
      result[row]![column] = percentile(window, 0.5)
    }
  }
  return result
}

const buildSpectralEmbedding = (affinity: readonly (readonly number[])[], clusterCount: number) => {
  const laplacian = buildNormalizedLaplacian(affinity)
  const decomposition = new EigenvalueDecomposition(new Matrix(laplacian), {
    assumeSymmetric: true
  })
  const order = decomposition.realEigenvalues
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index)
    .slice(0, clusterCount)
  const eigenvectors = decomposition.eigenvectorMatrix
  const selected = Array.from({ length: affinity.length }, (_unused, row) =>
    order.map((entry) => eigenvectors.get(row, entry.index))
  )
  const smoothed = medianSmoothEigenvectors(selected)
  return smoothed.map((row) => {
    const norm = Math.sqrt(row.reduce((total, value) => total + value * value, 0))
    return row.map((value) => value / Math.max(1e-5, norm))
  })
}

const createRandom = (seed: number) => {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let output = value
    output = Math.imul(output ^ (output >>> 15), output | 1)
    output ^= output + Math.imul(output ^ (output >>> 7), output | 61)
    return ((output ^ (output >>> 14)) >>> 0) / 4294967296
  }
}

const initializeCentroids = (
  values: readonly (readonly number[])[],
  clusterCount: number,
  seed: number
) => {
  const random = createRandom(seed)
  const firstIndex = Math.min(values.length - 1, Math.floor(random() * values.length))
  const selectedIndexes = [Math.max(0, firstIndex)]
  while (selectedIndexes.length < clusterCount) {
    const distances = values.map((value, index) => {
      if (selectedIndexes.includes(index)) return 0
      return Math.min(
        ...selectedIndexes.map((selectedIndex) =>
          squaredDistance(value, values[selectedIndex] ?? [])
        )
      )
    })
    const total = distances.reduce((sum, distance) => sum + distance, 0)
    if (total <= 1e-12) {
      const nextIndex = values.findIndex((_value, index) => !selectedIndexes.includes(index))
      if (nextIndex < 0) break
      selectedIndexes.push(nextIndex)
      continue
    }
    let cursor = random() * total
    let selectedIndex = distances.length - 1
    for (let index = 0; index < distances.length; index += 1) {
      cursor -= distances[index] ?? 0
      if (cursor <= 0) {
        selectedIndex = index
        break
      }
    }
    if (!selectedIndexes.includes(selectedIndex)) selectedIndexes.push(selectedIndex)
  }
  return selectedIndexes.map((index) => [...(values[index] ?? [])])
}

const runKMeansOnce = (
  values: readonly (readonly number[])[],
  clusterCount: number,
  seed: number
): KMeansResult => {
  const dimensions = values[0]?.length ?? 0
  let centroids = initializeCentroids(values, clusterCount, seed)
  const assignments = new Array(values.length).fill(-1)

  for (let iteration = 0; iteration < KMEANS_MAX_ITERATIONS; iteration += 1) {
    let changed = false
    for (let index = 0; index < values.length; index += 1) {
      let bestCluster = 0
      let bestDistance = Infinity
      for (let cluster = 0; cluster < centroids.length; cluster += 1) {
        const distance = squaredDistance(values[index] ?? [], centroids[cluster] ?? [])
        if (distance < bestDistance) {
          bestDistance = distance
          bestCluster = cluster
        }
      }
      if (assignments[index] !== bestCluster) {
        assignments[index] = bestCluster
        changed = true
      }
    }

    const sums = Array.from({ length: clusterCount }, () => new Array(dimensions).fill(0))
    const counts = new Array(clusterCount).fill(0)
    for (let index = 0; index < values.length; index += 1) {
      const cluster = assignments[index] ?? 0
      counts[cluster] += 1
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        sums[cluster]![dimension] += values[index]?.[dimension] ?? 0
      }
    }
    let repairedEmptyCluster = false
    const reassignedIndexes = new Set<number>()
    for (let cluster = 0; cluster < clusterCount; cluster += 1) {
      if ((counts[cluster] ?? 0) > 0) continue
      let farthestIndex = -1
      let farthestDistance = -Infinity
      for (let index = 0; index < values.length; index += 1) {
        const assigned = assignments[index] ?? 0
        if ((counts[assigned] ?? 0) <= 1 || reassignedIndexes.has(index)) continue
        const distance = squaredDistance(values[index] ?? [], centroids[assigned] ?? [])
        if (distance > farthestDistance) {
          farthestDistance = distance
          farthestIndex = index
        }
      }
      if (farthestIndex < 0) continue
      const sourceCluster = assignments[farthestIndex] ?? 0
      counts[sourceCluster] = Math.max(0, (counts[sourceCluster] ?? 0) - 1)
      counts[cluster] = 1
      assignments[farthestIndex] = cluster
      centroids[cluster] = [...(values[farthestIndex] ?? [])]
      reassignedIndexes.add(farthestIndex)
      repairedEmptyCluster = true
    }
    if (repairedEmptyCluster) {
      changed = true
      continue
    }
    for (let cluster = 0; cluster < clusterCount; cluster += 1) {
      centroids[cluster] = sums[cluster]!.map((value) => value / counts[cluster])
    }
    if (!changed) break
  }

  const inertia = values.reduce((total, value, index) => {
    const cluster = assignments[index] ?? 0
    return total + squaredDistance(value, centroids[cluster] ?? [])
  }, 0)
  return { assignments: [...assignments], inertia }
}

const runKMeans = (values: readonly (readonly number[])[], clusterCount: number) => {
  let best: KMeansResult | null = null
  for (let restart = 0; restart < KMEANS_RESTARTS; restart += 1) {
    const candidate = runKMeansOnce(values, clusterCount, 0x6f2d45a1 + restart * 7919)
    if (!best || candidate.inertia < best.inertia) best = candidate
  }
  return best?.assignments ?? values.map(() => 0)
}

const resolveClusterCount = (barCount: number) =>
  clamp(
    barCount < 24 ? MIN_CLUSTER_COUNT : DEFAULT_CLUSTER_COUNT,
    MIN_CLUSTER_COUNT,
    Math.min(MAX_CLUSTER_COUNT, barCount)
  )

const averageNormalizedValue = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number,
  key: keyof SongStructureSpectralBarFeature['normalized']
) => {
  const start = clamp(Math.floor(startIndex), 0, bars.length)
  const end = clamp(Math.ceil(endIndex), start, bars.length)
  if (end <= start) return 0
  let total = 0
  for (let index = start; index < end; index += 1) {
    total += bars[index]?.normalized[key] ?? 0
  }
  return total / (end - start)
}

export const resolveSongStructureBuildRampScore = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number
) => {
  const start = clamp(Math.floor(startIndex), 0, bars.length)
  const end = clamp(Math.ceil(endIndex), start, bars.length)
  const span = end - start
  if (start < 4 || span < 4) return 0
  const keys = ['high', 'mid', 'attackDensity', 'density', 'energy'] as const
  const weights = [0.28, 0.18, 0.22, 0.22, 0.1] as const
  let rising = 0
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex]
    const windows = Array.from({ length: 4 }, (_, windowIndex) => {
      const windowStart = start + (span * windowIndex) / 4
      const windowEnd = start + (span * (windowIndex + 1)) / 4
      return averageNormalizedValue(bars, windowStart, windowEnd, key)
    })
    let positiveSteps = 0
    let largestBackslide = 0
    for (let windowIndex = 1; windowIndex < windows.length; windowIndex += 1) {
      const delta = (windows[windowIndex] ?? 0) - (windows[windowIndex - 1] ?? 0)
      if (delta >= 0.015) positiveSteps += 1
      largestBackslide = Math.max(largestBackslide, -delta)
    }
    const sustainedRise =
      ramp(positiveSteps, 1.25, 2.75) * (1 - ramp(largestBackslide, 0.04, 0.2) * 0.65)
    const netRise = (windows.at(-1) ?? 0) - (windows[0] ?? 0)
    rising += ramp(netRise, 0.04, 0.42) * sustainedRise * (weights[keyIndex] ?? 0)
  }
  const beforeLow = averageNormalizedValue(bars, start - 4, start, 'low')
  const beforeDensity = averageNormalizedValue(bars, start - 4, start, 'density')
  const beforeAttack = averageNormalizedValue(bars, start - 4, start, 'attackDensity')
  const reducedBefore = clamp01(
    clamp01(0.5 - beforeLow * 0.5) * 0.38 +
      clamp01(0.5 - beforeDensity * 0.5) * 0.36 +
      clamp01(0.5 - beforeAttack * 0.5) * 0.26
  )
  const lateWindowStart = start + (span * 3) / 4
  const lateHigh = averageNormalizedValue(bars, lateWindowStart, end, 'high')
  const lateDensity = averageNormalizedValue(bars, lateWindowStart, end, 'density')
  const reachesActiveState = clamp01(
    clamp01(lateHigh * 0.5 + 0.5) * 0.48 + clamp01(lateDensity * 0.5 + 0.5) * 0.52
  )
  return clamp01(rising * 0.72 + reducedBefore * 0.18 + reachesActiveState * 0.1)
}

const resolveBoundaryBuildRampScore = (
  bars: readonly SongStructureSpectralBarFeature[],
  index: number
) => {
  if (!bars[index]?.isPhraseBoundary || index + 8 > bars.length) return 0
  return resolveSongStructureBuildRampScore(bars, index, index + 8)
}

const buildBoundaryEvidence = (bars: readonly SongStructureSpectralBarFeature[]) => {
  const vectors = bars.map((bar) => bar.localVector)
  const base = bars.map((bar, index) => {
    if (index <= 0 || index >= bars.length) {
      return { score: 0, contrast: 0, buildRamp: 0 }
    }
    const left = averageVectors(vectors, index - 4, index)
    const right = averageVectors(vectors, index, index + 4)
    const contrast = ramp(Math.sqrt(squaredDistance(left, right)), 0.16, 1.35)
    const phrasePrior = bar.isPhraseBoundary ? 1 : 0
    const clipPrior = bar.isClipBoundary ? 1 : 0
    const buildRamp = resolveBoundaryBuildRampScore(bars, index)
    const localScore = clamp01(contrast * 0.78 + phrasePrior * 0.16 + clipPrior * 0.06)
    return {
      score: Math.max(localScore, buildRamp),
      contrast,
      buildRamp
    }
  })
  return base.map((evidence, index): BoundaryEvidence => {
    const nearby = [
      base[index - 2]?.contrast ?? evidence.contrast,
      base[index - 1]?.contrast ?? evidence.contrast,
      base[index + 1]?.contrast ?? evidence.contrast,
      base[index + 2]?.contrast ?? evidence.contrast
    ]
    return {
      ...evidence,
      prominence: Math.max(0, evidence.contrast - percentile(nearby, 0.5))
    }
  })
}

const refineBoundaryIndex = (
  index: number,
  evidence: readonly BoundaryEvidence[],
  barCount: number
) => {
  const minimumIndex = Math.min(MIN_SECTION_BARS, barCount - 1)
  const maximumIndex = Math.max(minimumIndex, barCount - MIN_SECTION_BARS)
  let bestIndex = clamp(index, minimumIndex, maximumIndex)
  let bestScore = evidence[bestIndex]?.score ?? 0
  for (
    let candidate = Math.max(minimumIndex, index - BOUNDARY_REFINE_RADIUS_BARS);
    candidate <= Math.min(maximumIndex, index + BOUNDARY_REFINE_RADIUS_BARS);
    candidate += 1
  ) {
    const score = evidence[candidate]?.score ?? 0
    if (score > bestScore + 1e-8) {
      bestIndex = candidate
      bestScore = score
    }
  }
  return {
    index: bestIndex,
    score: bestScore,
    buildRamp: evidence[bestIndex]?.buildRamp
  }
}

const selectBoundaries = (
  bars: readonly SongStructureSpectralBarFeature[],
  clusterIds: readonly number[]
) => {
  const evidence = buildBoundaryEvidence(bars)
  const interiorContrasts = evidence.slice(1, -1).map((item) => item.contrast)
  const contrastMedian = percentile(interiorContrasts, 0.5)
  const contrastP90 = percentile(interiorContrasts, 0.9)
  const adaptiveContrast = clamp(
    contrastMedian + (contrastP90 - contrastMedian) * 0.42,
    NOVELTY_CONTRAST_FLOOR,
    0.18
  )
  const candidates: SongStructureSpectralBoundary[] = []
  for (let index = MIN_SECTION_BARS; index <= bars.length - MIN_SECTION_BARS; index += 1) {
    const bar = bars[index]
    const current = evidence[index]
    if (!bar || !current) continue
    const localPeak =
      current.contrast >=
      Math.max(evidence[index - 1]?.contrast ?? 0, evidence[index + 1]?.contrast ?? 0)
    const clusterChanged = clusterIds[index] !== clusterIds[index - 1]
    const prominent = current.prominence >= NOVELTY_PROMINENCE_FLOOR
    const phraseCandidate =
      bar.isPhraseBoundary &&
      localPeak &&
      current.contrast >= Math.max(NOVELTY_CONTRAST_FLOOR, adaptiveContrast * PHRASE_CONTRAST_SCALE)
    const clipCandidate =
      bar.isClipBoundary &&
      current.contrast >= Math.max(0.03, adaptiveContrast * CLIP_CONTRAST_SCALE)
    const noveltyCandidate =
      localPeak && prominent && current.contrast >= Math.max(0.075, adaptiveContrast)
    const clusterCandidate =
      clusterChanged &&
      current.contrast >= adaptiveContrast &&
      (prominent || current.contrast >= adaptiveContrast * 1.35)
    const buildRampCandidate = current.buildRamp >= SONG_STRUCTURE_BUILD_RAMP_MIN_SCORE
    if (
      !phraseCandidate &&
      !clipCandidate &&
      !noveltyCandidate &&
      !clusterCandidate &&
      !buildRampCandidate
    ) {
      continue
    }
    if (clipCandidate || buildRampCandidate) {
      candidates.push({ index, score: current.score, buildRamp: current.buildRamp })
    } else {
      candidates.push(refineBoundaryIndex(index, evidence, bars.length))
    }
  }
  candidates.sort((left, right) => left.index - right.index || right.score - left.score)

  const spaced: SongStructureSpectralBoundary[] = []
  for (const candidate of candidates) {
    const previous = spaced[spaced.length - 1]
    if (!previous || candidate.index - previous.index >= MIN_SECTION_BARS) {
      spaced.push(candidate)
      continue
    }
    if (candidate.score > previous.score) spaced[spaced.length - 1] = candidate
  }

  const maxSegments = clamp(Math.round(bars.length / 12), 4, 20)
  const limited =
    spaced.length + 1 <= maxSegments
      ? spaced
      : [...spaced]
          .sort((left, right) => right.score - left.score || left.index - right.index)
          .slice(0, maxSegments - 1)
          .sort((left, right) => left.index - right.index)
  return [
    { index: 0, score: 0, buildRamp: 0 },
    ...limited,
    { index: bars.length, score: 0, buildRamp: 0 }
  ]
}

export const clusterSongStructureSpectralBars = (
  bars: readonly SongStructureSpectralBarFeature[]
): SongStructureSpectralClusteringResult | null => {
  if (bars.length < 12 || bars.length > MAX_SPECTRAL_BARS) return null
  const clusterCount = resolveClusterCount(bars.length)
  const recurrence = enhanceRecurrenceDiagonals(buildRecurrenceAffinity(bars))
  const path = buildPathAffinity(bars)
  const affinity = buildBalancedAffinity(recurrence, path)
  const embedding = buildSpectralEmbedding(affinity, clusterCount)
  const clusterIds = runKMeans(embedding, clusterCount)
  const boundaries = selectBoundaries(bars, clusterIds)
  return {
    boundaries,
    clusterIds,
    clusterCount
  }
}
