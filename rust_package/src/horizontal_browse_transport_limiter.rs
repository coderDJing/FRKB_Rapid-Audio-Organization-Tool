const LIMITER_THRESHOLD: f32 = 0.891_250_9; // -1 dBFS
const LIMITER_CEILING: f32 = 0.966_050_9; // -0.3 dBFS
const OVERLOAD_HOLD_SEC: f32 = 0.5;
const RELEASE_SEC: f32 = 0.08;
const METER_RELEASE_SEC: f32 = 0.45;

#[derive(Clone, Copy)]
pub(super) struct MasterLimiterState {
  gain: f32,
  overload_hold_samples: u32,
  pre_limiter_peak_left: f32,
  pre_limiter_peak_right: f32,
}

impl Default for MasterLimiterState {
  fn default() -> Self {
    Self {
      gain: 1.0,
      overload_hold_samples: 0,
      pre_limiter_peak_left: 0.0,
      pre_limiter_peak_right: 0.0,
    }
  }
}

impl MasterLimiterState {
  pub(super) fn process(&mut self, left: f32, right: f32, sample_rate: u32) -> (f32, f32) {
    let peak = left.abs().max(right.abs());
    let sample_rate = sample_rate.max(1) as f32;
    let meter_release = (-1.0 / (sample_rate * METER_RELEASE_SEC)).exp();
    self.pre_limiter_peak_left = if left.abs() >= self.pre_limiter_peak_left {
      left.abs()
    } else {
      self.pre_limiter_peak_left * meter_release
    };
    self.pre_limiter_peak_right = if right.abs() >= self.pre_limiter_peak_right {
      right.abs()
    } else {
      self.pre_limiter_peak_right * meter_release
    };
    if peak > LIMITER_THRESHOLD {
      self.overload_hold_samples = (sample_rate * OVERLOAD_HOLD_SEC) as u32;
    } else {
      self.overload_hold_samples = self.overload_hold_samples.saturating_sub(1);
    }

    let target_gain = if peak > LIMITER_CEILING {
      (LIMITER_CEILING / peak).clamp(0.0, 1.0)
    } else {
      1.0
    };
    if target_gain < self.gain {
      self.gain = target_gain;
    } else {
      let release = 1.0 - (-1.0 / (sample_rate * RELEASE_SEC)).exp();
      self.gain += (target_gain - self.gain) * release;
    }
    (left * self.gain, right * self.gain)
  }

  pub(super) fn overload(&self) -> bool {
    self.overload_hold_samples > 0
  }

  pub(super) fn gain_reduction_db(&self) -> f32 {
    if self.gain >= 0.999_999 {
      0.0
    } else {
      -20.0 * self.gain.log10()
    }
  }

  pub(super) fn pre_limiter_peak_left_db(&self) -> f32 {
    20.0 * self.pre_limiter_peak_left.max(0.000_01).log10()
  }

  pub(super) fn pre_limiter_peak_right_db(&self) -> f32 {
    20.0 * self.pre_limiter_peak_right.max(0.000_01).log10()
  }
}

pub(super) fn soft_limit_sample(value: f32) -> f32 {
  if !value.is_finite() {
    return 0.0;
  }
  let sign = value.signum();
  let magnitude = value.abs();
  if magnitude <= LIMITER_CEILING {
    value
  } else {
    let excess = (magnitude - LIMITER_CEILING) / (1.0 - LIMITER_CEILING);
    sign * (LIMITER_CEILING + (1.0 - LIMITER_CEILING) * excess / (1.0 + excess))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn keeps_safe_stereo_frames_unchanged() {
    let mut limiter = MasterLimiterState::default();
    let output = limiter.process(0.5, -0.25, 48_000);
    assert_eq!(output, (0.5, -0.25));
    assert_eq!(limiter.gain_reduction_db(), 0.0);
  }

  #[test]
  fn limits_stereo_with_one_shared_gain() {
    let mut limiter = MasterLimiterState::default();
    let output = limiter.process(1.5, -0.75, 48_000);
    assert!(output.0.abs() <= LIMITER_CEILING + 0.000_001);
    assert!((output.1 / output.0 - -0.5).abs() < 0.000_001);
    assert!(limiter.overload());
    assert!(limiter.gain_reduction_db() > 3.0);
    assert!(limiter.pre_limiter_peak_left_db() > 3.0);
    assert!(limiter.pre_limiter_peak_right_db() < 0.0);
  }

  #[test]
  fn soft_output_protection_never_creates_a_hard_flat_top() {
    assert!(soft_limit_sample(1.5) < 1.0);
    assert!(soft_limit_sample(-1.5) > -1.0);
  }
}
