export type MixtapeStemProfile = 'fast' | 'quality'

export const MIXTAPE_STEM_PROFILES: MixtapeStemProfile[] = ['fast', 'quality']

export const DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE: MixtapeStemProfile = 'fast'
export const DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE: MixtapeStemProfile = 'quality'
export const DEFAULT_MIXTAPE_STEM_BASE_MODEL = 'htdemucs'

const STEM_MODEL_PROFILE_SEPARATOR = '@'

export type ParsedMixtapeStemModel = {
  requestedModel: string
  demucsModel: string
  profile: MixtapeStemProfile
}

export const normalizeMixtapeStemProfile = (
  value: unknown,
  fallback: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
): MixtapeStemProfile => {
  return value === 'quality' ? 'quality' : fallback === 'quality' ? 'quality' : 'fast'
}

export const resolveMixtapeStemModelByProfile = (
  profile: unknown,
  baseModel = DEFAULT_MIXTAPE_STEM_BASE_MODEL
): string => {
  const normalizedProfile = normalizeMixtapeStemProfile(profile)
  const normalizedBaseModel =
    typeof baseModel === 'string' && baseModel.trim()
      ? baseModel.trim()
      : DEFAULT_MIXTAPE_STEM_BASE_MODEL
  return `${normalizedBaseModel}${STEM_MODEL_PROFILE_SEPARATOR}${normalizedProfile}`
}

export const parseMixtapeStemModel = (
  value: unknown,
  fallbackProfile: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
): ParsedMixtapeStemModel => {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    const requestedModel = resolveMixtapeStemModelByProfile(fallbackProfile)
    return {
      requestedModel,
      demucsModel: DEFAULT_MIXTAPE_STEM_BASE_MODEL,
      profile: normalizeMixtapeStemProfile(fallbackProfile)
    }
  }
  const separatorIndex = raw.lastIndexOf(STEM_MODEL_PROFILE_SEPARATOR)
  if (separatorIndex > 0 && separatorIndex < raw.length - 1) {
    const maybeModel = raw.slice(0, separatorIndex).trim()
    const maybeProfile = raw.slice(separatorIndex + 1).trim()
    const profile = normalizeMixtapeStemProfile(maybeProfile, fallbackProfile)
    if (maybeProfile === profile) {
      const demucsModel = maybeModel || DEFAULT_MIXTAPE_STEM_BASE_MODEL
      return {
        requestedModel: `${demucsModel}${STEM_MODEL_PROFILE_SEPARATOR}${profile}`,
        demucsModel,
        profile
      }
    }
  }
  const profile = normalizeMixtapeStemProfile(fallbackProfile)
  const demucsModel = raw
  return {
    requestedModel: `${demucsModel}${STEM_MODEL_PROFILE_SEPARATOR}${profile}`,
    demucsModel,
    profile
  }
}
