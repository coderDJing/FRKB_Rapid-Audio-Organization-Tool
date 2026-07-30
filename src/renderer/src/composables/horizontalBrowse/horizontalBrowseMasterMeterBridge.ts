import { reactive } from 'vue'

export const horizontalBrowseMasterMeter = reactive({
  active: false,
  preLimiterPeakLeftDb: -100,
  preLimiterPeakRightDb: -100,
  limiterGainReductionDb: 0,
  limiterOverload: false
})

export const publishHorizontalBrowseMasterMeter = (input: {
  preLimiterPeakLeftDb?: unknown
  preLimiterPeakRightDb?: unknown
  limiterGainReductionDb?: unknown
  limiterOverload?: unknown
}) => {
  const leftPeak = Number(input.preLimiterPeakLeftDb)
  const rightPeak = Number(input.preLimiterPeakRightDb)
  const reduction = Number(input.limiterGainReductionDb)
  horizontalBrowseMasterMeter.active = true
  horizontalBrowseMasterMeter.preLimiterPeakLeftDb = Number.isFinite(leftPeak) ? leftPeak : -100
  horizontalBrowseMasterMeter.preLimiterPeakRightDb = Number.isFinite(rightPeak) ? rightPeak : -100
  horizontalBrowseMasterMeter.limiterGainReductionDb = Number.isFinite(reduction)
    ? Math.max(0, reduction)
    : 0
  horizontalBrowseMasterMeter.limiterOverload = input.limiterOverload === true
}

export const clearHorizontalBrowseMasterMeter = () => {
  horizontalBrowseMasterMeter.active = false
  horizontalBrowseMasterMeter.preLimiterPeakLeftDb = -100
  horizontalBrowseMasterMeter.preLimiterPeakRightDb = -100
  horizontalBrowseMasterMeter.limiterGainReductionDb = 0
  horizontalBrowseMasterMeter.limiterOverload = false
}

if (import.meta.hot) {
  import.meta.hot.dispose(clearHorizontalBrowseMasterMeter)
}
