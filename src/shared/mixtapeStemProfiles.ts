export type MixtapeStemProfile = 'quality'

export const MIXTAPE_STEM_PROFILES: MixtapeStemProfile[] = ['quality']

export const DEFAULT_MIXTAPE_STEM_PROFILE: MixtapeStemProfile = 'quality'
export const DEFAULT_MIXTAPE_STEM_QUALITY_MODEL = 'htdemucs'
export const DEFAULT_MIXTAPE_STEM_BASE_MODEL = DEFAULT_MIXTAPE_STEM_QUALITY_MODEL

const STEM_MODEL_PROFILE_SEPARATOR = '@'

export type ParsedMixtapeStemModel = {
  requestedModel: string
  demucsModel: string
  profile: MixtapeStemProfile
}

export const normalizeMixtapeStemProfile = (
  _value: unknown,
  _fallback: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): MixtapeStemProfile => {
  return 'quality'
}

export const resolveMixtapeStemBaseModelByProfile = (
  _profile: unknown,
  _fallback: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): string => {
  return DEFAULT_MIXTAPE_STEM_QUALITY_MODEL
}

export const resolveMixtapeStemModelByProfile = (_profile: unknown, baseModel = ''): string => {
  const normalizedBaseModel =
    typeof baseModel === 'string' && baseModel.trim()
      ? baseModel.trim()
      : DEFAULT_MIXTAPE_STEM_QUALITY_MODEL
  return `${normalizedBaseModel}${STEM_MODEL_PROFILE_SEPARATOR}${DEFAULT_MIXTAPE_STEM_PROFILE}`
}

export const parseMixtapeStemModel = (
  value: unknown,
  _fallbackProfile: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): ParsedMixtapeStemModel => {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    const demucsModel = DEFAULT_MIXTAPE_STEM_QUALITY_MODEL
    const requestedModel = resolveMixtapeStemModelByProfile('quality', demucsModel)
    return {
      requestedModel,
      demucsModel,
      profile: 'quality'
    }
  }

  const separatorIndex = raw.lastIndexOf(STEM_MODEL_PROFILE_SEPARATOR)
  if (separatorIndex > 0 && separatorIndex < raw.length - 1) {
    const maybeModel = raw.slice(0, separatorIndex).trim()
    const demucsModel = maybeModel || DEFAULT_MIXTAPE_STEM_QUALITY_MODEL
    return {
      requestedModel: `${demucsModel}${STEM_MODEL_PROFILE_SEPARATOR}${DEFAULT_MIXTAPE_STEM_PROFILE}`,
      demucsModel,
      profile: 'quality'
    }
  }

  const demucsModel = raw
  return {
    requestedModel: `${demucsModel}${STEM_MODEL_PROFILE_SEPARATOR}${DEFAULT_MIXTAPE_STEM_PROFILE}`,
    demucsModel,
    profile: 'quality'
  }
}
