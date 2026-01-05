type Complex = [number, number]

type MkFilterContext = {
  nPol: number
  pol: number[]
  poltyp: number[]
  nZero: number
  zer: number[]
  zertyp: number[]
}

type FidFilter = {
  typ: 'I' | 'F'
  cbm: number
  len: number
  val: number[]
}

export type MixxxBesselCoefficients = {
  coefficients: Float64Array
  order: 4 | 8
}

const MAXPZ = 64
const TWOPI = 2 * Math.PI
const BESSEL_4 = [-0.99520876435, 1.25710573945, -1.37006783055, 0.410249717494]

const mySqrt = (value: number) => (value <= 0 ? 0 : Math.sqrt(value))

const cAdd = (aa: Complex, bb: Complex): Complex => [aa[0] + bb[0], aa[1] + bb[1]]
const cAddZ = (aa: Complex, rr: number, ii: number): Complex => [aa[0] + rr, aa[1] + ii]
const cNeg = (aa: Complex): Complex => [-aa[0], -aa[1]]
const cMul = (aa: Complex, bb: Complex): Complex => [
  aa[0] * bb[0] - aa[1] * bb[1],
  aa[0] * bb[1] + aa[1] * bb[0]
]
const cMulR = (aa: Complex, factor: number): Complex => [aa[0] * factor, aa[1] * factor]
const cDiv = (aa: Complex, bb: Complex): Complex => {
  const denom = bb[0] * bb[0] + bb[1] * bb[1]
  const rr = aa[0] * bb[0] + aa[1] * bb[1]
  const ii = -aa[0] * bb[1] + aa[1] * bb[0]
  const fact = 1 / denom
  return [rr * fact, ii * fact]
}
const cRecip = (aa: Complex): Complex => {
  const denom = aa[0] * aa[0] + aa[1] * aa[1]
  const fact = 1 / denom
  return [aa[0] * fact, aa[1] * -fact]
}
const cSqrt = (aa: Complex): Complex => {
  const mag = Math.hypot(aa[0], aa[1])
  const rr = mySqrt((mag + aa[0]) * 0.5)
  let ii = mySqrt((mag - aa[0]) * 0.5)
  if (aa[1] < 0) ii = -ii
  return [rr, ii]
}
const cSquare = (aa: Complex): Complex => [aa[0] * aa[0] - aa[1] * aa[1], 2 * aa[0] * aa[1]]

const prewarp = (value: number) => Math.tan(value * Math.PI) / Math.PI

const createContext = (): MkFilterContext => ({
  nPol: 0,
  pol: new Array<number>(MAXPZ).fill(0),
  poltyp: new Array<number>(MAXPZ).fill(0),
  nZero: 0,
  zer: new Array<number>(MAXPZ).fill(0),
  zertyp: new Array<number>(MAXPZ).fill(0)
})

const bessel = (ctx: MkFilterContext, order: number) => {
  if (order !== 4) {
    throw new Error('Mixxx Bessel filter only supports order 4')
  }
  ctx.nPol = order
  for (let i = 0; i < order; i++) {
    ctx.pol[i] = BESSEL_4[i]
  }
  ctx.poltyp[0] = 2
  ctx.poltyp[1] = 0
  ctx.poltyp[2] = 2
  ctx.poltyp[3] = 0
}

const lowpass = (ctx: MkFilterContext, freq: number) => {
  const scale = freq * TWOPI
  for (let i = 0; i < ctx.nPol; i++) {
    ctx.pol[i] *= scale
  }
  ctx.nZero = ctx.nPol
  for (let i = 0; i < ctx.nZero; i++) {
    ctx.zer[i] = Number.NEGATIVE_INFINITY
    ctx.zertyp[i] = 1
  }
}

const highpass = (ctx: MkFilterContext, freq: number) => {
  const scale = freq * TWOPI
  for (let i = 0; i < ctx.nPol; ) {
    if (ctx.poltyp[i] === 1) {
      ctx.pol[i] = scale / ctx.pol[i]
      i += 1
      continue
    }
    const pole: Complex = [ctx.pol[i], ctx.pol[i + 1]]
    const recip = cRecip(pole)
    const scaled = cMulR(recip, scale)
    ctx.pol[i] = scaled[0]
    ctx.pol[i + 1] = scaled[1]
    i += 2
  }
  ctx.nZero = ctx.nPol
  for (let i = 0; i < ctx.nZero; i++) {
    ctx.zer[i] = 0
    ctx.zertyp[i] = 1
  }
}

const bandpass = (ctx: MkFilterContext, freq1: number, freq2: number) => {
  const w0 = TWOPI * Math.sqrt(freq1 * freq2)
  const bw = 0.5 * TWOPI * (freq2 - freq1)
  if (ctx.nPol * 2 > MAXPZ) {
    throw new Error('Mixxx Bessel bandpass order exceeds MAXPZ')
  }

  for (let a = ctx.nPol, b = ctx.nPol * 2; a > 0; ) {
    if (ctx.poltyp[a - 1] === 1) {
      a -= 1
      b -= 2
      ctx.poltyp[b] = 2
      ctx.poltyp[b + 1] = 0
      const hba = ctx.pol[a] * bw
      let pole: Complex = [1 - (w0 / hba) * (w0 / hba), 0]
      pole = cSqrt(pole)
      pole = cAddZ(pole, 1, 0)
      pole = cMulR(pole, hba)
      ctx.pol[b] = pole[0]
      ctx.pol[b + 1] = pole[1]
      continue
    }

    a -= 2
    b -= 4
    ctx.poltyp[b] = 2
    ctx.poltyp[b + 1] = 0
    ctx.poltyp[b + 2] = 2
    ctx.poltyp[b + 3] = 0
    const hba = cMulR([ctx.pol[a], ctx.pol[a + 1]], bw)
    let pole = cRecip([hba[0], hba[1]])
    pole = cMulR(pole, w0)
    pole = cSquare(pole)
    pole = cNeg(pole)
    pole = cAddZ(pole, 1, 0)
    pole = cSqrt(pole)
    pole = cMul(pole, hba)
    const poleNeg = cNeg(pole)
    const poleA = cAdd(pole, hba)
    const poleB = cAdd(poleNeg, hba)
    ctx.pol[b] = poleA[0]
    ctx.pol[b + 1] = poleA[1]
    ctx.pol[b + 2] = poleB[0]
    ctx.pol[b + 3] = poleB[1]
  }

  ctx.nPol *= 2
  ctx.nZero = ctx.nPol
  for (let i = 0; i < ctx.nZero; i++) {
    ctx.zertyp[i] = 1
    ctx.zer[i] = i < ctx.nZero / 2 ? 0 : Number.NEGATIVE_INFINITY
  }
}

const s2zBilinear = (ctx: MkFilterContext) => {
  for (let i = 0; i < ctx.nPol; ) {
    if (ctx.poltyp[i] === 1) {
      if (ctx.pol[i] === Number.NEGATIVE_INFINITY) {
        ctx.pol[i] = -1
      } else {
        ctx.pol[i] = (2 + ctx.pol[i]) / (2 - ctx.pol[i])
      }
      i += 1
      continue
    }
    const pole = [ctx.pol[i], ctx.pol[i + 1]] as Complex
    const denom = cAddZ(cNeg(pole), 2, 0)
    const numer = cAddZ(pole, 2, 0)
    const result = cDiv(numer, denom)
    ctx.pol[i] = result[0]
    ctx.pol[i + 1] = result[1]
    i += 2
  }

  for (let i = 0; i < ctx.nZero; ) {
    if (ctx.zertyp[i] === 1) {
      if (ctx.zer[i] === Number.NEGATIVE_INFINITY) {
        ctx.zer[i] = -1
      } else {
        ctx.zer[i] = (2 + ctx.zer[i]) / (2 - ctx.zer[i])
      }
      i += 1
      continue
    }
    const zero = [ctx.zer[i], ctx.zer[i + 1]] as Complex
    const denom = cAddZ(cNeg(zero), 2, 0)
    const numer = cAddZ(zero, 2, 0)
    const result = cDiv(numer, denom)
    ctx.zer[i] = result[0]
    ctx.zer[i + 1] = result[1]
    i += 2
  }
}

const z2fidfilter = (ctx: MkFilterContext, gain: number, cbm: number): FidFilter[] => {
  const filters: FidFilter[] = []
  filters.push({ typ: 'F', cbm: 0, len: 1, val: [gain] })

  let a = 0
  for (; a <= ctx.nPol - 2 && a <= ctx.nZero - 2; a += 2) {
    if (ctx.poltyp[a] === 1 && ctx.poltyp[a + 1] === 1) {
      filters.push({
        typ: 'I',
        cbm: 0,
        len: 3,
        val: [1, -(ctx.pol[a] + ctx.pol[a + 1]), ctx.pol[a] * ctx.pol[a + 1]]
      })
    } else if (ctx.poltyp[a] === 2) {
      filters.push({
        typ: 'I',
        cbm: 0,
        len: 3,
        val: [1, -2 * ctx.pol[a], ctx.pol[a] * ctx.pol[a] + ctx.pol[a + 1] * ctx.pol[a + 1]]
      })
    } else {
      throw new Error('Mixxx Bessel poltyp mismatch')
    }

    if (ctx.zertyp[a] === 1 && ctx.zertyp[a + 1] === 1) {
      if (!cbm || ctx.zer[a] !== 0 || ctx.zer[a + 1] !== 0) {
        filters.push({
          typ: 'F',
          cbm,
          len: 3,
          val: [1, -(ctx.zer[a] + ctx.zer[a + 1]), ctx.zer[a] * ctx.zer[a + 1]]
        })
      }
    } else if (ctx.zertyp[a] === 2) {
      if (!cbm || ctx.zer[a] !== 0 || ctx.zer[a + 1] !== 0) {
        filters.push({
          typ: 'F',
          cbm,
          len: 3,
          val: [1, -2 * ctx.zer[a], ctx.zer[a] * ctx.zer[a] + ctx.zer[a + 1] * ctx.zer[a + 1]]
        })
      }
    } else {
      throw new Error('Mixxx Bessel zertyp mismatch')
    }
  }

  if (ctx.nPol - a === 1 && ctx.nZero - a === 1) {
    if (ctx.poltyp[a] !== 1 || ctx.zertyp[a] !== 1) {
      throw new Error('Mixxx Bessel final pole/zero mismatch')
    }
    filters.push({
      typ: 'I',
      cbm: 0,
      len: 2,
      val: [1, -ctx.pol[a]]
    })
    if (!cbm || ctx.zer[a] !== 0) {
      filters.push({
        typ: 'F',
        cbm,
        len: 2,
        val: [1, -ctx.zer[a]]
      })
    }
  } else if (ctx.nPol - a !== 0 || ctx.nZero - a !== 0) {
    throw new Error('Mixxx Bessel unexpected poles/zeros')
  }

  return filters
}

const evaluate = (coef: number[], input: Complex): Complex => {
  let rv: Complex = [coef[0], 0]
  if (coef.length <= 1) {
    return rv
  }
  let pz: Complex = [input[0], input[1]]
  rv = [rv[0] + coef[1] * pz[0], rv[1] + coef[1] * pz[1]]
  for (let i = 2; i < coef.length; i++) {
    pz = cMul(pz, input)
    rv = [rv[0] + coef[i] * pz[0], rv[1] + coef[i] * pz[1]]
  }
  return rv
}

const fidResponse = (filters: FidFilter[], freq: number): number => {
  const theta = freq * TWOPI
  const z: Complex = [Math.cos(theta), Math.sin(theta)]
  let top: Complex = [1, 0]
  let bot: Complex = [1, 0]

  for (const filter of filters) {
    const resp = evaluate(filter.val, z)
    if (filter.typ === 'I') {
      bot = cMul(bot, resp)
    } else if (filter.typ === 'F') {
      top = cMul(top, resp)
    }
  }

  const out = cDiv(top, bot)
  return Math.hypot(out[0], out[1])
}

const searchPeak = (filters: FidFilter[], f0: number, f3: number) => {
  let start = f0
  let end = f3
  for (let i = 0; i < 20; i++) {
    const f1 = 0.51 * start + 0.49 * end
    const f2 = 0.49 * start + 0.51 * end
    if (f1 === f2) break
    const r1 = fidResponse(filters, f1)
    const r2 = fidResponse(filters, f2)
    if (r1 > r2) {
      end = f2
    } else {
      start = f1
    }
  }
  return (start + end) * 0.5
}

const doLowpass = (ctx: MkFilterContext, freq: number) => {
  lowpass(ctx, prewarp(freq))
  s2zBilinear(ctx)
  const filters = z2fidfilter(ctx, 1, ~0)
  filters[0].val[0] = 1 / fidResponse(filters, 0)
  return filters
}

const doHighpass = (ctx: MkFilterContext, freq: number) => {
  highpass(ctx, prewarp(freq))
  s2zBilinear(ctx)
  const filters = z2fidfilter(ctx, 1, ~0)
  filters[0].val[0] = 1 / fidResponse(filters, 0.5)
  return filters
}

const doBandpass = (ctx: MkFilterContext, freq0: number, freq1: number) => {
  bandpass(ctx, prewarp(freq0), prewarp(freq1))
  s2zBilinear(ctx)
  const filters = z2fidfilter(ctx, 1, ~0)
  filters[0].val[0] = 1 / fidResponse(filters, searchPeak(filters, freq0, freq1))
  return filters
}

const designCoefficients = (filters: FidFilter[], nCoef: number) => {
  let gain = 1
  const coefficients: number[] = []
  let idx = 0

  while (idx < filters.length) {
    const current = filters[idx]
    if (current.typ === 'F' && current.len === 1) {
      gain *= current.val[0]
      idx += 1
      continue
    }
    if (current.typ !== 'I' && current.typ !== 'F') {
      throw new Error('Mixxx Bessel invalid filter type')
    }

    let iir = [1]
    let nIir = 1
    let iirCbm = -1
    let iirAdj = 1
    if (current.typ === 'I') {
      iir = current.val
      nIir = current.len
      iirCbm = current.cbm ?? 0
      iirAdj = 1 / current.val[0]
      idx += 1
      gain *= iirAdj
    }

    let fir = [1]
    let nFir = 1
    let firCbm = -1
    if (idx < filters.length && filters[idx].typ === 'F') {
      fir = filters[idx].val
      nFir = filters[idx].len
      firCbm = filters[idx].cbm ?? 0
      idx += 1
    }

    const len = Math.max(nIir, nFir)
    for (let a = len - 1; a >= 0; a--) {
      const idxMask = a < 15 ? a : 15
      const mask = 1 << idxMask
      if (a < nIir && a > 0 && (iirCbm & mask) === 0) {
        coefficients.push(iirAdj * iir[a])
      }
      if (a < nFir && (firCbm & mask) === 0) {
        coefficients.push(fir[a])
      }
    }
  }

  if (coefficients.length !== nCoef) {
    throw new Error('Mixxx Bessel coefficient length mismatch')
  }
  return { gain, coefficients }
}

export const designMixxxBesselLowpass = (
  sampleRate: number,
  cutoffHz: number
): MixxxBesselCoefficients => {
  const ctx = createContext()
  bessel(ctx, 4)
  const freq = cutoffHz / sampleRate
  const filters = doLowpass(ctx, freq)
  const { gain, coefficients } = designCoefficients(filters, 4)
  return {
    coefficients: Float64Array.from([gain, ...coefficients]),
    order: 4
  }
}

export const designMixxxBesselHighpass = (
  sampleRate: number,
  cutoffHz: number
): MixxxBesselCoefficients => {
  const ctx = createContext()
  bessel(ctx, 4)
  const freq = cutoffHz / sampleRate
  const filters = doHighpass(ctx, freq)
  const { gain, coefficients } = designCoefficients(filters, 4)
  return {
    coefficients: Float64Array.from([gain, ...coefficients]),
    order: 4
  }
}

export const designMixxxBesselBandpass = (
  sampleRate: number,
  lowHz: number,
  highHz: number
): MixxxBesselCoefficients => {
  const ctx = createContext()
  bessel(ctx, 4)
  const low = lowHz / sampleRate
  const high = highHz / sampleRate
  const filters = doBandpass(ctx, low, high)
  const { gain, coefficients } = designCoefficients(filters, 8)
  return {
    coefficients: Float64Array.from([gain, ...coefficients]),
    order: 8
  }
}
