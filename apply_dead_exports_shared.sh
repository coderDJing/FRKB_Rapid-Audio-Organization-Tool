#!/bin/bash

# 移除shared目录中未使用的export关键字

# src/shared/hotCues.ts
sed -i 's/^export const HOT_CUE_SLOT_LABELS/const HOT_CUE_SLOT_LABELS/' src/shared/hotCues.ts
sed -i 's/^export const HOT_CUE_SLOT_COLORS/const HOT_CUE_SLOT_COLORS/' src/shared/hotCues.ts

# src/shared/mixtapeStemProfiles.ts
sed -i 's/^export const DEFAULT_MIXTAPE_STEM_QUALITY_MODEL/const DEFAULT_MIXTAPE_STEM_QUALITY_MODEL/' src/shared/mixtapeStemProfiles.ts
sed -i 's/^export type ParsedMixtapeStemModel/type ParsedMixtapeStemModel/' src/shared/mixtapeStemProfiles.ts

# src/shared/rekordboxDesktopPlaylist.ts
sed -i 's/^export type RekordboxDesktopPlaylistSelectedTracksSource/type RekordboxDesktopPlaylistSelectedTracksSource/' src/shared/rekordboxDesktopPlaylist.ts
sed -i 's/^export type RekordboxDesktopPlaylistSource/type RekordboxDesktopPlaylistSource/' src/shared/rekordboxDesktopPlaylist.ts
sed -i 's/^export type RekordboxDesktopMovePlaylistSuccessSummary/type RekordboxDesktopMovePlaylistSuccessSummary/' src/shared/rekordboxDesktopPlaylist.ts
sed -i 's/^export type RekordboxDesktopRenamePlaylistSuccessSummary/type RekordboxDesktopRenamePlaylistSuccessSummary/' src/shared/rekordboxDesktopPlaylist.ts
sed -i 's/^export type RekordboxDesktopDeletePlaylistSuccessSummary/type RekordboxDesktopDeletePlaylistSuccessSummary/' src/shared/rekordboxDesktopPlaylist.ts
sed -i 's/^export type RekordboxDesktopRemovePlaylistTracksSuccessSummary/type RekordboxDesktopRemovePlaylistTracksSuccessSummary/' src/shared/rekordboxDesktopPlaylist.ts
sed -i 's/^export type RekordboxDesktopReorderPlaylistTracksSuccessSummary/type RekordboxDesktopReorderPlaylistTracksSuccessSummary/' src/shared/rekordboxDesktopPlaylist.ts

# src/shared/rekordboxXmlExport.ts
sed -i 's/^export type RekordboxXmlExportSelectedTracksSource/type RekordboxXmlExportSelectedTracksSource/' src/shared/rekordboxXmlExport.ts
sed -i 's/^export type RekordboxXmlExportPlaylistSource/type RekordboxXmlExportPlaylistSource/' src/shared/rekordboxXmlExport.ts

echo "Done applying export removals for src/shared/"
