export const MIXTAPE_DRAG_SESSION_MIME = 'application/x-frkb-mixtape-add'
export const MIXTAPE_DRAG_SESSION_TEXT_PREFIX = 'frkb-mixtape-drag:'

export type MixtapeDragSessionItem = {
  filePath: string
  originPlaylistUuid?: string | null
  originPathSnapshot?: string | null
  info?: Record<string, unknown> | null
  sourcePlaylistId?: string | null
  sourceItemId?: string | null
}

export type MixtapeDragSessionPayload = {
  token: string
  sourceSongListUUID?: string
  items: MixtapeDragSessionItem[]
}

export type MixtapeDragSessionPreview = {
  token: string
  sourceSongListUUID?: string
  itemCount: number
}

export const buildMixtapeDragSessionText = (token: string) =>
  `${MIXTAPE_DRAG_SESSION_TEXT_PREFIX}${token}`
