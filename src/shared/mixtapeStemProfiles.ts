export type MixtapeStemProfile = 'fast' | 'quality'

export const MIXTAPE_STEM_PROFILES: MixtapeStemProfile[] = ['fast', 'quality']

export const DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE: MixtapeStemProfile = 'fast'
export const DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE: MixtapeStemProfile = 'quality'
export const DEFAULT_MIXTAPE_STEM_FAST_MODEL = 'htdemucs'
export const DEFAULT_MIXTAPE_STEM_QUALITY_MODEL = 'htdemucs'
export const DEFAULT_MIXTAPE_STEM_BASE_MODEL = DEFAULT_MIXTAPE_STEM_QUALITY_MODEL

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

export const resolveMixtapeStemBaseModelByProfile = (
  profile: unknown,
  fallback: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
): string => {
  const normalizedProfile = normalizeMixtapeStemProfile(profile, fallback)
  return normalizedProfile === 'quality'
    ? DEFAULT_MIXTAPE_STEM_QUALITY_MODEL
    : DEFAULT_MIXTAPE_STEM_FAST_MODEL
}

export const resolveMixtapeStemModelByProfile = (profile: unknown, baseModel = ''): string => {
  const normalizedProfile = normalizeMixtapeStemProfile(profile)
  const normalizedBaseModel =
    typeof baseModel === 'string' && baseModel.trim()
      ? baseModel.trim()
      : resolveMixtapeStemBaseModelByProfile(normalizedProfile, normalizedProfile)
  return `${normalizedBaseModel}${STEM_MODEL_PROFILE_SEPARATOR}${normalizedProfile}`
}

export const parseMixtapeStemModel = (
  value: unknown,
  fallbackProfile: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
): ParsedMixtapeStemModel => {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    const profile = normalizeMixtapeStemProfile(fallbackProfile)
    const demucsModel = resolveMixtapeStemBaseModelByProfile(profile, profile)
    const requestedModel = resolveMixtapeStemModelByProfile(profile, demucsModel)
    return {
      requestedModel,
      demucsModel,
      profile
    }
  }
  const separatorIndex = raw.lastIndexOf(STEM_MODEL_PROFILE_SEPARATOR)
  if (separatorIndex > 0 && separatorIndex < raw.length - 1) {
    const maybeModel = raw.slice(0, separatorIndex).trim()
    const maybeProfile = raw.slice(separatorIndex + 1).trim()
    const profile = normalizeMixtapeStemProfile(maybeProfile, fallbackProfile)
    if (maybeProfile === profile) {
      const demucsModel =
        maybeModel || resolveMixtapeStemBaseModelByProfile(profile, fallbackProfile)
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
