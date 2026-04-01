import { computed, ref, watch, type Ref } from 'vue'
import type { MixtapeEnvelopeParamId, MixtapeMixMode } from '@renderer/composables/mixtape/types'

type TranslateFn = (key: string, payload?: Record<string, unknown>) => string

export type MixParamId =
  | 'position'
  | 'gain'
  | 'high'
  | 'mid'
  | 'low'
  | 'vocal'
  | 'inst'
  | 'bass'
  | 'drums'
  | 'volume'

export type MixParamOption = {
  id: MixParamId
  labelKey: string
}

type UseMixtapeMixParamUiOptions = {
  mixtapeMixMode: Ref<MixtapeMixMode>
  t: TranslateFn
}

const STEM_PARAM_SET = new Set<MixParamId>(['vocal', 'inst', 'bass', 'drums'])

export const useMixtapeMixParamUi = ({ mixtapeMixMode, t }: UseMixtapeMixParamUiOptions) => {
  const isStemMixMode = computed(() => mixtapeMixMode.value === 'stem')
  const mixParamOptions = computed<MixParamOption[]>(() => {
    if (!isStemMixMode.value) {
      return [
        {
          id: 'position',
          labelKey: 'mixtape.mixParamPosition'
        },
        {
          id: 'gain',
          labelKey: 'mixtape.mixParamGain'
        },
        {
          id: 'high',
          labelKey: 'mixtape.mixParamHigh'
        },
        {
          id: 'mid',
          labelKey: 'mixtape.mixParamMid'
        },
        {
          id: 'low',
          labelKey: 'mixtape.mixParamLow'
        },
        {
          id: 'volume',
          labelKey: 'mixtape.mixParamVolume'
        }
      ]
    }

    const options: MixParamOption[] = [
      {
        id: 'position',
        labelKey: 'mixtape.mixParamPosition'
      },
      {
        id: 'gain',
        labelKey: 'mixtape.mixParamGain'
      },
      {
        id: 'vocal',
        labelKey: 'mixtape.mixParamVocal'
      },
      {
        id: 'inst',
        labelKey: 'mixtape.mixParamInst'
      }
    ]
    options.push(
      {
        id: 'bass',
        labelKey: 'mixtape.mixParamBass'
      },
      {
        id: 'drums',
        labelKey: 'mixtape.mixParamDrums'
      },
      {
        id: 'volume',
        labelKey: 'mixtape.mixParamVolume'
      }
    )
    return options
  })

  const selectedMixParam = ref<MixParamId>('position')
  const isTrackPositionMode = computed(() => selectedMixParam.value === 'position')
  const isGainParamMode = computed(() => selectedMixParam.value === 'gain')
  const isVolumeParamMode = computed(() => selectedMixParam.value === 'volume')
  const isStemParamMode = computed(() => STEM_PARAM_SET.has(selectedMixParam.value))
  const isEnvelopeParamMode = computed(() => !isTrackPositionMode.value)
  const showTrackEnvelopeEditor = computed(() => isEnvelopeParamMode.value)
  const isSegmentSelectionSupported = computed(
    () => isVolumeParamMode.value || isStemParamMode.value
  )
  const segmentSelectionMode = ref(false)
  const isSegmentSelectionActive = computed(
    () => isStemParamMode.value || (isSegmentSelectionSupported.value && segmentSelectionMode.value)
  )
  const showEnvelopeCurve = computed(() => isEnvelopeParamMode.value && !isStemParamMode.value)
  const envelopePreviewLineKeys = computed<MixtapeEnvelopeParamId[]>(() =>
    isStemMixMode.value ? ['gain', 'volume'] : ['gain', 'high', 'mid', 'low', 'volume']
  )
  const envelopeHintKey = computed(() => {
    if (isSegmentSelectionActive.value) {
      return 'mixtape.segmentMuteHint'
    }
    if (isStemParamMode.value) {
      return 'mixtape.stemSegmentHint'
    }
    return 'mixtape.envelopeEditHint'
  })

  watch(selectedMixParam, (nextParam) => {
    if (STEM_PARAM_SET.has(nextParam)) {
      segmentSelectionMode.value = true
      return
    }
    segmentSelectionMode.value = false
  })

  watch(mixParamOptions, (nextOptions) => {
    const availableIds = new Set(nextOptions.map((option) => option.id))
    if (!availableIds.has(selectedMixParam.value)) {
      selectedMixParam.value = 'position'
    }
  })

  const handleToggleSegmentSelectionMode = () => {
    if (!isSegmentSelectionSupported.value) return
    if (isStemParamMode.value) {
      segmentSelectionMode.value = true
      return
    }
    segmentSelectionMode.value = !segmentSelectionMode.value
  }

  return {
    envelopeHintKey,
    envelopePreviewLineKeys,
    isEnvelopeParamMode,
    isGainParamMode,
    isSegmentSelectionActive,
    isSegmentSelectionSupported,
    isStemMixMode,
    isStemParamMode,
    isTrackPositionMode,
    isVolumeParamMode,
    handleToggleSegmentSelectionMode,
    mixParamOptions,
    selectedMixParam,
    showEnvelopeCurve,
    showTrackEnvelopeEditor
  }
}
