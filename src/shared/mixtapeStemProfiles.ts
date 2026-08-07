export type MixtapeStemProfile = 'quality' | 'ultra'

export const DEFAULT_MIXTAPE_STEM_PROFILE: MixtapeStemProfile = 'quality'
const DEFAULT_MIXTAPE_STEM_QUALITY_MODEL = 'htdemucs'
const DEFAULT_MIXTAPE_STEM_ULTRA_MODEL = 'htdemucs_ft'
export const DEFAULT_MIXTAPE_STEM_BASE_MODEL = DEFAULT_MIXTAPE_STEM_QUALITY_MODEL

const STEM_MODEL_PROFILE_SEPARATOR = '@'

type ParsedMixtapeStemModel = {
  requestedModel: string
  demucsModel: string
  profile: MixtapeStemProfile
}

export const normalizeMixtapeStemProfile = (
  value: unknown,
  fallback: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): MixtapeStemProfile => {
  return value === 'ultra' || value === 'quality' ? value : fallback
}

export const resolveMixtapeStemBaseModelByProfile = (
  profile: unknown,
  fallback: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): string => {
  return normalizeMixtapeStemProfile(profile, fallback) === 'ultra'
    ? DEFAULT_MIXTAPE_STEM_ULTRA_MODEL
    : DEFAULT_MIXTAPE_STEM_QUALITY_MODEL
}

export const resolveMixtapeStemModelByProfile = (profile: unknown, baseModel = ''): string => {
  const normalizedProfile = normalizeMixtapeStemProfile(profile)
  const normalizedBaseModel =
    typeof baseModel === 'string' && baseModel.trim()
      ? baseModel.trim()
      : resolveMixtapeStemBaseModelByProfile(normalizedProfile)
  return `${normalizedBaseModel}${STEM_MODEL_PROFILE_SEPARATOR}${normalizedProfile}`
}

export const parseMixtapeStemModel = (
  value: unknown,
  fallbackProfile: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): ParsedMixtapeStemModel => {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    const profile = normalizeMixtapeStemProfile(fallbackProfile)
    const demucsModel = resolveMixtapeStemBaseModelByProfile(profile)
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
    const requestedProfile = raw.slice(separatorIndex + 1).trim()
    const inferredProfile =
      maybeModel === DEFAULT_MIXTAPE_STEM_ULTRA_MODEL
        ? 'ultra'
        : normalizeMixtapeStemProfile(fallbackProfile)
    const profile = normalizeMixtapeStemProfile(requestedProfile, inferredProfile)
    const demucsModel = maybeModel || resolveMixtapeStemBaseModelByProfile(profile)
    return {
      requestedModel: resolveMixtapeStemModelByProfile(profile, demucsModel),
      demucsModel,
      profile
    }
  }

  const demucsModel = raw
  const profile =
    demucsModel === DEFAULT_MIXTAPE_STEM_ULTRA_MODEL
      ? 'ultra'
      : normalizeMixtapeStemProfile(fallbackProfile)
  return {
    requestedModel: resolveMixtapeStemModelByProfile(profile, demucsModel),
    demucsModel,
    profile
  }
}
