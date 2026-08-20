import { computed, nextTick, onMounted, watch, type Ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { useUserGuide } from '@renderer/composables/useUserGuide'
import { userGuideSpotlightBeat } from '@renderer/composables/userGuideBridge'

export const useMixtapeWindowUserGuide = (itemsLoading: Ref<boolean>) => {
  const runtime = useRuntimeStore()
  const guide = useUserGuide({ surface: 'mixtape' })
  let started = false

  const expandBpmLane = computed(() => userGuideSpotlightBeat.value === 'mixtapeBpm')

  const tryStart = () => {
    if (itemsLoading.value || started) return
    started = true
    void nextTick(() => {
      guide.beginUserGuide()
    })
  }

  onMounted(() => {
    watch(itemsLoading, tryStart, { immediate: true })
  })

  return {
    expandBpmLane,
    activeStep: guide.activeStep,
    activeBeat: guide.activeBeat,
    beatNumber: guide.beatNumber,
    beatCount: guide.beatCount,
    hasNextBeat: guide.hasNextBeat,
    isRekordboxUser: guide.isRekordboxUser,
    confirmShow: computed(() => runtime.confirmShow),
    goNextBeat: guide.goNextBeat,
    dismissActiveStep: guide.dismissActiveStep
  }
}
