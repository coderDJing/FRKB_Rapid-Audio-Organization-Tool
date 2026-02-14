use napi::bindgen_prelude::*;
use std::borrow::Cow;
use std::f64::consts::PI;

const MIXXX_WAVEFORM_POINTS_PER_SECOND: f64 = 441.0;
const MIXXX_SUMMARY_MAX_SAMPLES: f64 = 2.0 * 1920.0;
const MIXXX_LOWPASS_MAX_HZ: f64 = 600.0;
const MIXXX_HIGHPASS_MIN_HZ: f64 = 4000.0;
const MIXXX_HIGH_SCALE_EXP: f64 = 0.632;
const MAXPZ: usize = 64;
const TWOPI: f64 = 2.0 * PI;
const BESSEL_4: [f64; 4] = [-0.99520876435, 1.25710573945, -1.37006783055, 0.410249717494];

type Complex = [f64; 2];

#[derive(Clone, Copy)]
enum BandKey {
  Low,
  Mid,
  High,
  All,
}

#[napi(object)]
pub struct MixxxWaveformBand {
  pub left: Buffer,
  pub right: Buffer,
  pub peak_left: Buffer,
  pub peak_right: Buffer,
}

#[napi(object)]
pub struct MixxxWaveformBands {
  pub low: MixxxWaveformBand,
  pub mid: MixxxWaveformBand,
  pub high: MixxxWaveformBand,
  pub all: MixxxWaveformBand,
}

#[napi(object)]
pub struct MixxxWaveformData {
  pub duration: f64,
  pub sample_rate: u32,
  pub step: f64,
  pub bands: MixxxWaveformBands,
}

#[derive(Clone)]
struct MixxxBesselCoefficients {
  coefficients: Vec<f64>,
  order: usize,
}

struct MkFilterContext {
  n_pol: usize,
  pol: Vec<f64>,
  poltyp: Vec<i32>,
  n_zero: usize,
  zer: Vec<f64>,
  zertyp: Vec<i32>,
}

struct FidFilter {
  typ: char,
  cbm: i32,
  len: usize,
  val: Vec<f64>,
}

fn my_sqrt(value: f64) -> f64 {
  if value <= 0.0 {
    0.0
  } else {
    value.sqrt()
  }
}

fn c_add(a: Complex, b: Complex) -> Complex {
  [a[0] + b[0], a[1] + b[1]]
}

fn c_add_z(a: Complex, r: f64, i: f64) -> Complex {
  [a[0] + r, a[1] + i]
}

fn c_neg(a: Complex) -> Complex {
  [-a[0], -a[1]]
}

fn c_mul(a: Complex, b: Complex) -> Complex {
  [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
}

fn c_mul_r(a: Complex, factor: f64) -> Complex {
  [a[0] * factor, a[1] * factor]
}

fn c_div(a: Complex, b: Complex) -> Complex {
  let denom = b[0] * b[0] + b[1] * b[1];
  let rr = a[0] * b[0] + a[1] * b[1];
  let ii = -a[0] * b[1] + a[1] * b[0];
  let fact = 1.0 / denom;
  [rr * fact, ii * fact]
}

fn c_recip(a: Complex) -> Complex {
  let denom = a[0] * a[0] + a[1] * a[1];
  let fact = 1.0 / denom;
  [a[0] * fact, a[1] * -fact]
}

fn c_sqrt(a: Complex) -> Complex {
  let mag = a[0].hypot(a[1]);
  let rr = my_sqrt((mag + a[0]) * 0.5);
  let mut ii = my_sqrt((mag - a[0]) * 0.5);
  if a[1] < 0.0 {
    ii = -ii;
  }
  [rr, ii]
}

fn c_square(a: Complex) -> Complex {
  [a[0] * a[0] - a[1] * a[1], 2.0 * a[0] * a[1]]
}

fn prewarp(value: f64) -> f64 {
  (value * PI).tan() / PI
}

fn create_context() -> MkFilterContext {
  MkFilterContext {
    n_pol: 0,
    pol: vec![0.0; MAXPZ],
    poltyp: vec![0; MAXPZ],
    n_zero: 0,
    zer: vec![0.0; MAXPZ],
    zertyp: vec![0; MAXPZ],
  }
}

fn bessel(ctx: &mut MkFilterContext, order: usize) -> Result<()> {
  if order != 4 {
    return Err(Error::from_reason("Mixxx Bessel filter only supports order 4"));
  }
  ctx.n_pol = order;
  for i in 0..order {
    ctx.pol[i] = BESSEL_4[i];
  }
  ctx.poltyp[0] = 2;
  ctx.poltyp[1] = 0;
  ctx.poltyp[2] = 2;
  ctx.poltyp[3] = 0;
  Ok(())
}

fn lowpass(ctx: &mut MkFilterContext, freq: f64) {
  let scale = freq * TWOPI;
  for i in 0..ctx.n_pol {
    ctx.pol[i] *= scale;
  }
  ctx.n_zero = ctx.n_pol;
  for i in 0..ctx.n_zero {
    ctx.zer[i] = f64::NEG_INFINITY;
    ctx.zertyp[i] = 1;
  }
}

fn highpass(ctx: &mut MkFilterContext, freq: f64) {
  let scale = freq * TWOPI;
  let mut i = 0;
  while i < ctx.n_pol {
    if ctx.poltyp[i] == 1 {
      ctx.pol[i] = scale / ctx.pol[i];
      i += 1;
      continue;
    }
    let pole = [ctx.pol[i], ctx.pol[i + 1]];
    let recip = c_recip(pole);
    let scaled = c_mul_r(recip, scale);
    ctx.pol[i] = scaled[0];
    ctx.pol[i + 1] = scaled[1];
    i += 2;
  }
  ctx.n_zero = ctx.n_pol;
  for i in 0..ctx.n_zero {
    ctx.zer[i] = 0.0;
    ctx.zertyp[i] = 1;
  }
}

fn bandpass(ctx: &mut MkFilterContext, freq1: f64, freq2: f64) -> Result<()> {
  let w0 = TWOPI * (freq1 * freq2).sqrt();
  let bw = 0.5 * TWOPI * (freq2 - freq1);
  if ctx.n_pol * 2 > MAXPZ {
    return Err(Error::from_reason("Mixxx Bessel bandpass order exceeds MAXPZ"));
  }

  let mut a = ctx.n_pol;
  let mut b = ctx.n_pol * 2;
  while a > 0 {
    if ctx.poltyp[a - 1] == 1 {
      a -= 1;
      b -= 2;
      ctx.poltyp[b] = 2;
      ctx.poltyp[b + 1] = 0;
      let hba = ctx.pol[a] * bw;
      let mut pole: Complex = [1.0 - (w0 / hba) * (w0 / hba), 0.0];
      pole = c_sqrt(pole);
      pole = c_add_z(pole, 1.0, 0.0);
      pole = c_mul_r(pole, hba);
      ctx.pol[b] = pole[0];
      ctx.pol[b + 1] = pole[1];
      continue;
    }

    a -= 2;
    b -= 4;
    ctx.poltyp[b] = 2;
    ctx.poltyp[b + 1] = 0;
    ctx.poltyp[b + 2] = 2;
    ctx.poltyp[b + 3] = 0;
    let hba = c_mul_r([ctx.pol[a], ctx.pol[a + 1]], bw);
    let mut pole = c_recip([hba[0], hba[1]]);
    pole = c_mul_r(pole, w0);
    pole = c_square(pole);
    pole = c_neg(pole);
    pole = c_add_z(pole, 1.0, 0.0);
    pole = c_sqrt(pole);
    pole = c_mul(pole, hba);
    let pole_neg = c_neg(pole);
    let pole_a = c_add(pole, hba);
    let pole_b = c_add(pole_neg, hba);
    ctx.pol[b] = pole_a[0];
    ctx.pol[b + 1] = pole_a[1];
    ctx.pol[b + 2] = pole_b[0];
    ctx.pol[b + 3] = pole_b[1];
  }

  ctx.n_pol *= 2;
  ctx.n_zero = ctx.n_pol;
  for i in 0..ctx.n_zero {
    ctx.zertyp[i] = 1;
    ctx.zer[i] = if i < ctx.n_zero / 2 { 0.0 } else { f64::NEG_INFINITY };
  }
  Ok(())
}

fn s2z_bilinear(ctx: &mut MkFilterContext) {
  let mut i = 0;
  while i < ctx.n_pol {
    if ctx.poltyp[i] == 1 {
      if ctx.pol[i] == f64::NEG_INFINITY {
        ctx.pol[i] = -1.0;
      } else {
        ctx.pol[i] = (2.0 + ctx.pol[i]) / (2.0 - ctx.pol[i]);
      }
      i += 1;
      continue;
    }
    let pole = [ctx.pol[i], ctx.pol[i + 1]];
    let denom = c_add_z(c_neg(pole), 2.0, 0.0);
    let numer = c_add_z(pole, 2.0, 0.0);
    let result = c_div(numer, denom);
    ctx.pol[i] = result[0];
    ctx.pol[i + 1] = result[1];
    i += 2;
  }

  let mut i = 0;
  while i < ctx.n_zero {
    if ctx.zertyp[i] == 1 {
      if ctx.zer[i] == f64::NEG_INFINITY {
        ctx.zer[i] = -1.0;
      } else {
        ctx.zer[i] = (2.0 + ctx.zer[i]) / (2.0 - ctx.zer[i]);
      }
      i += 1;
      continue;
    }
    let zero = [ctx.zer[i], ctx.zer[i + 1]];
    let denom = c_add_z(c_neg(zero), 2.0, 0.0);
    let numer = c_add_z(zero, 2.0, 0.0);
    let result = c_div(numer, denom);
    ctx.zer[i] = result[0];
    ctx.zer[i + 1] = result[1];
    i += 2;
  }
}

fn z2fidfilter(ctx: &MkFilterContext, gain: f64, cbm: i32) -> Vec<FidFilter> {
  let mut filters: Vec<FidFilter> = Vec::new();
  filters.push(FidFilter {
    typ: 'F',
    cbm: 0,
    len: 1,
    val: vec![gain],
  });

  let mut a = 0usize;
  while a <= ctx.n_pol.saturating_sub(2) && a <= ctx.n_zero.saturating_sub(2) {
    if ctx.poltyp[a] == 1 && ctx.poltyp[a + 1] == 1 {
      filters.push(FidFilter {
        typ: 'I',
        cbm: 0,
        len: 3,
        val: vec![1.0, -(ctx.pol[a] + ctx.pol[a + 1]), ctx.pol[a] * ctx.pol[a + 1]],
      })
    } else if ctx.poltyp[a] == 2 {
      filters.push(FidFilter {
        typ: 'I',
        cbm: 0,
        len: 3,
        val: vec![
          1.0,
          -2.0 * ctx.pol[a],
          ctx.pol[a] * ctx.pol[a] + ctx.pol[a + 1] * ctx.pol[a + 1],
        ],
      })
    } else {
      return vec![];
    }

    if ctx.zertyp[a] == 1 && ctx.zertyp[a + 1] == 1 {
      if cbm == 0 || ctx.zer[a] != 0.0 || ctx.zer[a + 1] != 0.0 {
        filters.push(FidFilter {
          typ: 'F',
          cbm,
          len: 3,
          val: vec![1.0, -(ctx.zer[a] + ctx.zer[a + 1]), ctx.zer[a] * ctx.zer[a + 1]],
        })
      }
    } else if ctx.zertyp[a] == 2 {
      if cbm == 0 || ctx.zer[a] != 0.0 || ctx.zer[a + 1] != 0.0 {
        filters.push(FidFilter {
          typ: 'F',
          cbm,
          len: 3,
          val: vec![1.0, -2.0 * ctx.zer[a], ctx.zer[a] * ctx.zer[a] + ctx.zer[a + 1] * ctx.zer[a + 1]],
        })
      }
    } else {
      return vec![];
    }

    a += 2;
  }

  if ctx.n_pol.saturating_sub(a) == 1 && ctx.n_zero.saturating_sub(a) == 1 {
    if ctx.poltyp[a] != 1 || ctx.zertyp[a] != 1 {
      return vec![];
    }
    filters.push(FidFilter {
      typ: 'I',
      cbm: 0,
      len: 2,
      val: vec![1.0, -ctx.pol[a]],
    });
    if cbm == 0 || ctx.zer[a] != 0.0 {
      filters.push(FidFilter {
        typ: 'F',
        cbm,
        len: 2,
        val: vec![1.0, -ctx.zer[a]],
      });
    }
  } else if ctx.n_pol != a || ctx.n_zero != a {
    return vec![];
  }

  filters
}

fn evaluate(coef: &[f64], input: Complex) -> Complex {
  let mut rv: Complex = [coef[0], 0.0];
  if coef.len() <= 1 {
    return rv;
  }
  let mut pz: Complex = [input[0], input[1]];
  rv = [rv[0] + coef[1] * pz[0], rv[1] + coef[1] * pz[1]];
  for i in 2..coef.len() {
    pz = c_mul(pz, input);
    rv = [rv[0] + coef[i] * pz[0], rv[1] + coef[i] * pz[1]];
  }
  rv
}

fn fid_response(filters: &[FidFilter], freq: f64) -> f64 {
  let theta = freq * TWOPI;
  let z: Complex = [theta.cos(), theta.sin()];
  let mut top: Complex = [1.0, 0.0];
  let mut bot: Complex = [1.0, 0.0];

  for filter in filters {
    let resp = evaluate(&filter.val, z);
    if filter.typ == 'I' {
      bot = c_mul(bot, resp);
    } else if filter.typ == 'F' {
      top = c_mul(top, resp);
    }
  }

  let out = c_div(top, bot);
  (out[0] * out[0] + out[1] * out[1]).sqrt()
}

fn search_peak(filters: &[FidFilter], f0: f64, f3: f64) -> f64 {
  let mut start = f0;
  let mut end = f3;
  for _ in 0..20 {
    let f1 = 0.51 * start + 0.49 * end;
    let f2 = 0.49 * start + 0.51 * end;
    if (f1 - f2).abs() < f64::EPSILON {
      break;
    }
    let r1 = fid_response(filters, f1);
    let r2 = fid_response(filters, f2);
    if r1 > r2 {
      end = f2;
    } else {
      start = f1;
    }
  }
  (start + end) * 0.5
}

fn do_lowpass(ctx: &mut MkFilterContext, freq: f64) -> Vec<FidFilter> {
  lowpass(ctx, prewarp(freq));
  s2z_bilinear(ctx);
  let mut filters = z2fidfilter(ctx, 1.0, !0);
  if !filters.is_empty() {
    filters[0].val[0] = 1.0 / fid_response(&filters, 0.0);
  }
  filters
}

fn do_highpass(ctx: &mut MkFilterContext, freq: f64) -> Vec<FidFilter> {
  highpass(ctx, prewarp(freq));
  s2z_bilinear(ctx);
  let mut filters = z2fidfilter(ctx, 1.0, !0);
  if !filters.is_empty() {
    filters[0].val[0] = 1.0 / fid_response(&filters, 0.5);
  }
  filters
}

fn do_bandpass(ctx: &mut MkFilterContext, freq0: f64, freq1: f64) -> Vec<FidFilter> {
  if bandpass(ctx, prewarp(freq0), prewarp(freq1)).is_err() {
    return vec![];
  }
  s2z_bilinear(ctx);
  let mut filters = z2fidfilter(ctx, 1.0, !0);
  if !filters.is_empty() {
    filters[0].val[0] = 1.0 / fid_response(&filters, search_peak(&filters, freq0, freq1));
  }
  filters
}

fn design_coefficients(filters: &[FidFilter], n_coef: usize) -> Result<(f64, Vec<f64>)> {
  let mut gain = 1.0;
  let mut coefficients: Vec<f64> = Vec::new();
  let mut idx = 0usize;

  while idx < filters.len() {
    let current = &filters[idx];
    if current.typ == 'F' && current.len == 1 {
      gain *= current.val[0];
      idx += 1;
      continue;
    }
    if current.typ != 'I' && current.typ != 'F' {
      return Err(Error::from_reason("Mixxx Bessel invalid filter type"));
    }

    let mut iir = vec![1.0];
    let mut n_iir = 1usize;
    let mut iir_cbm = -1i32;
    let mut iir_adj = 1.0;
    if current.typ == 'I' {
      iir = current.val.clone();
      n_iir = current.len;
      iir_cbm = current.cbm;
      iir_adj = 1.0 / current.val[0];
      idx += 1;
      gain *= iir_adj;
    }

    let mut fir = vec![1.0];
    let mut n_fir = 1usize;
    let mut fir_cbm = -1i32;
    if idx < filters.len() && filters[idx].typ == 'F' {
      fir = filters[idx].val.clone();
      n_fir = filters[idx].len;
      fir_cbm = filters[idx].cbm;
      idx += 1;
    }

    let len = n_iir.max(n_fir);
    for a in (0..len).rev() {
      let idx_mask = if a < 15 { a } else { 15 };
      let mask = 1 << idx_mask;
      if a < n_iir && a > 0 && (iir_cbm & mask) == 0 {
        coefficients.push(iir_adj * iir[a]);
      }
      if a < n_fir && (fir_cbm & mask) == 0 {
        coefficients.push(fir[a]);
      }
    }
  }

  if coefficients.len() != n_coef {
    return Err(Error::from_reason("Mixxx Bessel coefficient length mismatch"));
  }

  Ok((gain, coefficients))
}

fn design_mixxx_bessel_lowpass(sample_rate: f64, cutoff_hz: f64) -> Result<MixxxBesselCoefficients> {
  let mut ctx = create_context();
  bessel(&mut ctx, 4)?;
  let freq = cutoff_hz / sample_rate;
  let filters = do_lowpass(&mut ctx, freq);
  let (gain, coefficients) = design_coefficients(&filters, 4)?;
  let mut out = vec![gain];
  out.extend(coefficients);
  Ok(MixxxBesselCoefficients { coefficients: out, order: 4 })
}

fn design_mixxx_bessel_highpass(sample_rate: f64, cutoff_hz: f64) -> Result<MixxxBesselCoefficients> {
  let mut ctx = create_context();
  bessel(&mut ctx, 4)?;
  let freq = cutoff_hz / sample_rate;
  let filters = do_highpass(&mut ctx, freq);
  let (gain, coefficients) = design_coefficients(&filters, 4)?;
  let mut out = vec![gain];
  out.extend(coefficients);
  Ok(MixxxBesselCoefficients { coefficients: out, order: 4 })
}

fn design_mixxx_bessel_bandpass(sample_rate: f64, low_hz: f64, high_hz: f64) -> Result<MixxxBesselCoefficients> {
  let mut ctx = create_context();
  bessel(&mut ctx, 4)?;
  let low = low_hz / sample_rate;
  let high = high_hz / sample_rate;
  let filters = do_bandpass(&mut ctx, low, high);
  let (gain, coefficients) = design_coefficients(&filters, 8)?;
  let mut out = vec![gain];
  out.extend(coefficients);
  Ok(MixxxBesselCoefficients { coefficients: out, order: 8 })
}

fn process_mixxx_lowpass_sample(coefficients: &[f64], state: &mut [f64], value: f64) -> f64 {
  let mut tmp = state[0];
  state[0] = state[1];
  state[1] = state[2];
  state[2] = state[3];
  let mut iir = value * coefficients[0];
  iir -= coefficients[1] * tmp;
  let mut fir = tmp;
  iir -= coefficients[2] * state[0];
  fir += state[0] + state[0];
  fir += iir;
  tmp = state[1];
  state[1] = iir;
  let value = fir;
  iir = value;
  iir -= coefficients[3] * tmp;
  fir = tmp;
  iir -= coefficients[4] * state[2];
  fir += state[2] + state[2];
  fir += iir;
  state[3] = iir;
  fir
}

fn process_mixxx_highpass_sample(coefficients: &[f64], state: &mut [f64], value: f64) -> f64 {
  let mut tmp = state[0];
  state[0] = state[1];
  state[1] = state[2];
  state[2] = state[3];
  let mut iir = value * coefficients[0];
  iir -= coefficients[1] * tmp;
  let mut fir = tmp;
  iir -= coefficients[2] * state[0];
  fir += -state[0] - state[0];
  fir += iir;
  tmp = state[1];
  state[1] = iir;
  let value = fir;
  iir = value;
  iir -= coefficients[3] * tmp;
  fir = tmp;
  iir -= coefficients[4] * state[2];
  fir += -state[2] - state[2];
  fir += iir;
  state[3] = iir;
  fir
}

fn process_mixxx_bandpass_sample(coefficients: &[f64], state: &mut [f64], value: f64) -> f64 {
  let mut tmp = state[0];
  state[0] = state[1];
  state[1] = state[2];
  state[2] = state[3];
  state[3] = state[4];
  state[4] = state[5];
  state[5] = state[6];
  state[6] = state[7];
  let mut iir = value * coefficients[0];
  iir -= coefficients[1] * tmp;
  let mut fir = tmp;
  iir -= coefficients[2] * state[0];
  fir += -state[0] - state[0];
  fir += iir;
  tmp = state[1];
  state[1] = iir;
  let mut value = fir;
  iir = value;
  iir -= coefficients[3] * tmp;
  fir = tmp;
  iir -= coefficients[4] * state[2];
  fir += -state[2] - state[2];
  fir += iir;
  tmp = state[3];
  state[3] = iir;
  value = fir;
  iir = value;
  iir -= coefficients[5] * tmp;
  fir = tmp;
  iir -= coefficients[6] * state[4];
  fir += state[4] + state[4];
  fir += iir;
  tmp = state[5];
  state[5] = iir;
  value = fir;
  iir = value;
  iir -= coefficients[7] * tmp;
  fir = tmp;
  iir -= coefficients[8] * state[6];
  fir += state[6] + state[6];
  fir += iir;
  state[7] = iir;
  fir
}

fn process_mixxx_band_sample(
  band: BandKey,
  coefficients: &[f64],
  state: &mut [f64],
  value: f64,
) -> f64 {
  match band {
    BandKey::Mid => process_mixxx_bandpass_sample(coefficients, state, value),
    BandKey::High => process_mixxx_highpass_sample(coefficients, state, value),
    BandKey::Low => process_mixxx_lowpass_sample(coefficients, state, value),
    BandKey::All => value,
  }
}

fn scale_mixxx_value(value: f64, band: BandKey) -> u8 {
  if value <= 0.0 || value.is_nan() {
    return 0;
  }
  let scaled = if matches!(band, BandKey::High) {
    value.powf(MIXXX_HIGH_SCALE_EXP)
  } else {
    value
  };
  let rounded = (scaled * 255.0).round();
  if rounded <= 0.0 {
    0
  } else if rounded >= 255.0 {
    255
  } else {
    rounded as u8
  }
}

fn downsample_mixxx_band(
  samples: &[f32],
  channels: usize,
  band: BandKey,
  main_stride: f64,
  summary_stride: f64,
  coeffs: &MixxxBesselCoefficients,
) -> MixxxWaveformBand {
  let total_frames = samples.len() / channels;
  let expected_frames = (total_frames as f64 / summary_stride).floor() as usize + 1;

  let mut left_values: Vec<u8> = Vec::with_capacity(expected_frames);
  let mut right_values: Vec<u8> = Vec::with_capacity(expected_frames);
  let mut left_peak_values: Vec<u8> = Vec::with_capacity(expected_frames);
  let mut right_peak_values: Vec<u8> = Vec::with_capacity(expected_frames);

  let mut position = 0.0;
  let mut next_main_store = main_stride;
  let mut next_summary_store = summary_stride;
  let mut left_peak = 0.0;
  let mut right_peak = 0.0;
  let mut left_average = 0.0;
  let mut right_average = 0.0;
  let mut average_divisor = 0.0;
  let mut left_peak_max = 0.0;
  let mut right_peak_max = 0.0;
  let mut left_state = vec![0.0; coeffs.order];
  let mut right_state = vec![0.0; coeffs.order];

  for frame in 0..total_frames {
    let base = frame * channels;
    let left_sample = samples[base] as f64;
    let right_sample = if channels > 1 {
      samples[base + 1] as f64
    } else {
      left_sample
    };

    let l = process_mixxx_band_sample(band, &coeffs.coefficients, &mut left_state, left_sample).abs();
    let r = process_mixxx_band_sample(band, &coeffs.coefficients, &mut right_state, right_sample).abs();

    if l > left_peak {
      left_peak = l;
    }
    if r > right_peak {
      right_peak = r;
    }

    position += 1.0;

    if position >= next_main_store {
      if left_peak > left_peak_max {
        left_peak_max = left_peak;
      }
      if right_peak > right_peak_max {
        right_peak_max = right_peak;
      }
      left_average += left_peak;
      right_average += right_peak;
      average_divisor += 1.0;
      left_peak = 0.0;
      right_peak = 0.0;
      next_main_store += main_stride;
    }

    if position >= next_summary_store {
      let left_value = if average_divisor > 0.0 {
        left_average / average_divisor
      } else {
        left_peak
      };
      let right_value = if average_divisor > 0.0 {
        right_average / average_divisor
      } else {
        right_peak
      };
      let left_peak_value = if average_divisor > 0.0 {
        left_peak_max
      } else {
        left_peak
      };
      let right_peak_value = if average_divisor > 0.0 {
        right_peak_max
      } else {
        right_peak
      };

      left_values.push(scale_mixxx_value(left_value, band));
      right_values.push(scale_mixxx_value(right_value, band));
      left_peak_values.push(scale_mixxx_value(left_peak_value, band));
      right_peak_values.push(scale_mixxx_value(right_peak_value, band));

      left_average = 0.0;
      right_average = 0.0;
      average_divisor = 0.0;
      left_peak_max = 0.0;
      right_peak_max = 0.0;
      next_summary_store += summary_stride;
    }
  }

  if left_values.len() < expected_frames {
    left_values.resize(expected_frames, 0);
    right_values.resize(expected_frames, 0);
    left_peak_values.resize(expected_frames, 0);
    right_peak_values.resize(expected_frames, 0);
  } else if left_values.len() > expected_frames {
    left_values.truncate(expected_frames);
    right_values.truncate(expected_frames);
    left_peak_values.truncate(expected_frames);
    right_peak_values.truncate(expected_frames);
  }

  MixxxWaveformBand {
    left: Buffer::from(left_values),
    right: Buffer::from(right_values),
    peak_left: Buffer::from(left_peak_values),
    peak_right: Buffer::from(right_peak_values),
  }
}

fn pcm_buffer_to_f32(buffer: &Buffer) -> Cow<'_, [f32]> {
  let bytes = buffer.as_ref();
  let (prefix, aligned, suffix) = unsafe { bytes.align_to::<f32>() };
  if prefix.is_empty() && suffix.is_empty() {
    Cow::Borrowed(aligned)
  } else {
    let mut samples: Vec<f32> = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
      samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Cow::Owned(samples)
  }
}

fn compute_mixxx_waveform_with_summary_rate(
  pcm_data: Buffer,
  sample_rate: u32,
  channels: u8,
  summary_visual_sample_rate: f64,
) -> Result<MixxxWaveformData> {
  if channels == 0 {
    return Err(Error::from_reason("Missing channels for Mixxx waveform"));
  }
  if sample_rate == 0 {
    return Err(Error::from_reason("Missing sample rate for Mixxx waveform"));
  }

  let samples = pcm_buffer_to_f32(&pcm_data);
  let channels_usize = channels as usize;
  if samples.len() < channels_usize {
    return Err(Error::from_reason("Empty PCM buffer"));
  }

  let total_frames = samples.len() / channels_usize;
  if total_frames == 0 {
    return Err(Error::from_reason("Empty PCM buffer"));
  }

  let sample_rate_f = sample_rate as f64;
  let mut visual_rate = if summary_visual_sample_rate.is_finite() && summary_visual_sample_rate > 0.0 {
    summary_visual_sample_rate
  } else {
    MIXXX_WAVEFORM_POINTS_PER_SECOND
  };
  if visual_rate > sample_rate_f {
    visual_rate = sample_rate_f;
  }
  // For high-detail waveform requests (e.g. beat-grid adjustment preview),
  // keep the analysis stride at least as dense as the requested visual rate.
  // This avoids a fixed 441Hz internal ceiling that makes zoomed waveform look blocky.
  let analysis_rate = if visual_rate > MIXXX_WAVEFORM_POINTS_PER_SECOND {
    visual_rate
  } else {
    MIXXX_WAVEFORM_POINTS_PER_SECOND
  };
  let main_stride = sample_rate_f / analysis_rate;
  let summary_stride = sample_rate_f / visual_rate;

  let low_coeffs = design_mixxx_bessel_lowpass(sample_rate_f, MIXXX_LOWPASS_MAX_HZ)?;
  let mid_coeffs =
    design_mixxx_bessel_bandpass(sample_rate_f, MIXXX_LOWPASS_MAX_HZ, MIXXX_HIGHPASS_MIN_HZ)?;
  let high_coeffs = design_mixxx_bessel_highpass(sample_rate_f, MIXXX_HIGHPASS_MIN_HZ)?;

  let low_band = downsample_mixxx_band(
    &samples,
    channels_usize,
    BandKey::Low,
    main_stride,
    summary_stride,
    &low_coeffs,
  );
  let mid_band = downsample_mixxx_band(
    &samples,
    channels_usize,
    BandKey::Mid,
    main_stride,
    summary_stride,
    &mid_coeffs,
  );
  let high_band = downsample_mixxx_band(
    &samples,
    channels_usize,
    BandKey::High,
    main_stride,
    summary_stride,
    &high_coeffs,
  );
  let all_coeffs = MixxxBesselCoefficients {
    coefficients: Vec::new(),
    order: 0,
  };
  let all_band = downsample_mixxx_band(
    &samples,
    channels_usize,
    BandKey::All,
    main_stride,
    summary_stride,
    &all_coeffs,
  );

  let duration = total_frames as f64 / sample_rate_f;

  Ok(MixxxWaveformData {
    duration,
    sample_rate,
    step: summary_stride,
    bands: MixxxWaveformBands {
      low: low_band,
      mid: mid_band,
      high: high_band,
      all: all_band,
    },
  })
}

pub fn compute_mixxx_waveform(
  pcm_data: Buffer,
  sample_rate: u32,
  channels: u8,
) -> Result<MixxxWaveformData> {
  let sample_rate_f = sample_rate as f64;
  let mut summary_visual_sample_rate = sample_rate_f;
  let analysis_channels = 2.0;
  if sample_rate_f > 0.0 && channels > 0 {
    let total_samples = pcm_data.len() / 4;
    let total_frames = total_samples / channels as usize;
    if (total_frames as f64) > (MIXXX_SUMMARY_MAX_SAMPLES / analysis_channels) {
      summary_visual_sample_rate =
        (sample_rate_f * MIXXX_SUMMARY_MAX_SAMPLES) / analysis_channels / total_frames as f64;
    }
  }
  compute_mixxx_waveform_with_summary_rate(
    pcm_data,
    sample_rate,
    channels,
    summary_visual_sample_rate,
  )
}

pub fn compute_mixxx_waveform_with_rate(
  pcm_data: Buffer,
  sample_rate: u32,
  channels: u8,
  target_visual_rate: f64,
) -> Result<MixxxWaveformData> {
  compute_mixxx_waveform_with_summary_rate(pcm_data, sample_rate, channels, target_visual_rate)
}
