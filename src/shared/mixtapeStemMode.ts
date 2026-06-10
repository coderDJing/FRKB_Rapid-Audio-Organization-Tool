export const FIXED_MIXTAPE_STEM_MODE = '4stems' as const

type FixedMixtapeStemMode = typeof FIXED_MIXTAPE_STEM_MODE

export const normalizeMixtapeStemMode = (_value: unknown): FixedMixtapeStemMode =>
  FIXED_MIXTAPE_STEM_MODE
