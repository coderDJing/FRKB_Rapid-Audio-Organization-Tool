import { computed, type Ref } from 'vue'
import { resolveMixtapeStemModelByProfile } from '@shared/mixtapeStemProfiles'
import {
  buildMixtapeBpmTargets,
  resolveMissingBpmTrackCount
} from '@renderer/composables/mixtape/mixtapeBpmAnalysis'
import type { MixtapeMixMode, MixtapeStemProfile, MixtapeTrack } from './types'

type UseMixtapeOutputAvailabilityParams = {
  tracks: Ref<MixtapeTrack[]>
  mixtapeItemsLoading: Ref<boolean>
  mixtapeMixMode: Ref<MixtapeMixMode>
  mixtapeStemProfile: Ref<MixtapeStemProfile>
  bpmAnalysisActive: Ref<boolean>
  transportDecoding: Ref<boolean>
  transportPreloading: Ref<boolean>
  outputRunning: Ref<boolean>
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
}

const resolveStemStatus = (track: MixtapeTrack) => {
  const value = String(track.stemStatus || '').trim()
  if (value === 'pending' || value === 'running' || value === 'ready' || value === 'failed') {
    return value
  }
  return 'ready'
}

const hasTrackStemAssetsReady = (track: MixtapeTrack) =>
  Boolean(
    String(track.stemVocalPath || '').trim() &&
      String(track.stemInstPath || '').trim() &&
      String(track.stemBassPath || '').trim() &&
      String(track.stemDrumsPath || '').trim()
  )

export const useMixtapeOutputAvailability = (params: UseMixtapeOutputAvailabilityParams) => {
  const missingBpmTrackCount = computed(() => {
    const bpmTargets = new Set(buildMixtapeBpmTargets(params.tracks.value))
    return resolveMissingBpmTrackCount(params.tracks.value, bpmTargets)
  })

  const missingDurationTrackCount = computed(
    () =>
      params.tracks.value.filter((track) => {
        const filePath = String(track.filePath || '').trim()
        if (!filePath) return false
        const sourceDuration = Number(params.resolveTrackSourceDurationSeconds(track))
        return !Number.isFinite(sourceDuration) || sourceDuration <= 0
      }).length
  )

  const stemExportModel = computed(() =>
    resolveMixtapeStemModelByProfile(params.mixtapeStemProfile.value)
  )

  const stemBlockedTrackCount = computed(() => {
    if (params.mixtapeMixMode.value !== 'stem') return 0
    return params.tracks.value.filter((track) => {
      if (resolveStemStatus(track) !== 'ready') return true
      if (!hasTrackStemAssetsReady(track)) return true
      return String(track.stemModel || '').trim() !== stemExportModel.value
    }).length
  })

  const canOutput = computed(() => {
    if (params.outputRunning.value || params.mixtapeItemsLoading.value) return false
    if (params.transportDecoding.value || params.transportPreloading.value) return false
    if (params.tracks.value.length <= 0) return false
    if (params.bpmAnalysisActive.value || missingBpmTrackCount.value > 0) return false
    if (missingDurationTrackCount.value > 0) return false
    if (params.mixtapeMixMode.value === 'stem' && stemBlockedTrackCount.value > 0) return false
    return true
  })

  return {
    canOutput,
    missingBpmTrackCount,
    missingDurationTrackCount,
    stemBlockedTrackCount
  }
}
