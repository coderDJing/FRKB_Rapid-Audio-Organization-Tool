Content Research for FRKB Official Site
======================================

Goals
-----
- Expand the official site copy with real, already-implemented features.
- Keep CN/EN content aligned and consistent with code behavior.
- Avoid promises not present in the current build.

Constraints
-----------
- Windows and macOS only (no Linux build yet).
- Update checks are in-app prompts with manual download/confirm.
- Cloud sync only stores SHA256 fingerprints, not audio or tags.
- Scan formats are configurable in Settings.

Feature Inventory (Based on Code)
---------------------------------
- Fingerprint dedup: content hash and file hash modes; import and playlist dedup; manual add; batch analyze.
- Fingerprint DB: export/import; cloud sync with user key.
- Dual-library flow: Filter and Curated libraries; WYSIWYG mapping to real folders.
- Drag in import and drag move; drag out to Explorer/Finder.
- Export to folder with optional delete-after-export.
- Recycle Bin with restore and permanent delete.
- Waveform preview: SoundCloud/Fine/RGB styles; half/full mode; list preview column.
- BPM and key analysis; Tap Tempo; Classic/Camelot key display.
- Playback range selection; auto play next; output device selection.
- Metadata editor; cover replace/save; MusicBrainz and AcoustID auto fill.
- Format conversion (batch): target format, metadata preserve, new file or replace, optional fingerprint add.
- External tracks playlist for temporary playback (no import needed).
- Windows context menu integration; open in Explorer/Finder.
- Global shortcuts; per-library filters and column controls; filter persistence.
- Auto sync library tree changes via watcher.
- Chinese/English UI.

Evidence Index (Code References)
--------------------------------
- Fingerprint modes and dedup: `src/main/utils.ts`, `src/main/window/mainWindow/importHandlers.ts`,
  `src/main/window/mainWindow/fingerprintHandlers.ts`, `src/types/globals.d.ts`.
- Fingerprint DB import/export and cloud sync: `src/main/fingerprintStore.ts`, `src/main/cloudSync.ts`,
  `src/main/ipc/exportHandlers.ts`.
- Library mapping and watcher: `src/main/utils.ts`, `src/main/libraryTreeWatcher.ts`.
- Export with delete: `src/main/ipc/exportHandlers.ts`.
- Recycle bin restore/delete: `src/main/recycleBinService.ts`, `src/main/recycleBinDb.ts`.
- Waveform, BPM, key analysis: `src/main/services/keyAnalysis/*`, `src/types/globals.d.ts`.
- Playback range and output device: `src/types/globals.d.ts`, `src/renderer/src/components/settingDialog.vue`.
- Metadata editor and auto fill: `src/main/services/metadataEditor.ts`, `src/main/services/metadataAutoFill.ts`,
  `src/main/services/acoustId.ts`, `src/renderer/src/components/musicBrainzDialog/*`.
- Format conversion: `src/main/services/audioConversion.ts`, `src/renderer/src/i18n/locales/*`.
- External tracks: `src/renderer/src/utils/externalPlaylist.ts`, `src/renderer/src/pages/homePage.vue`.
- Drag out: `src/main/window/mainWindow/index.ts`, `src/renderer/src/pages/modules/songsArea/composables/useDragSongs.ts`.
- Update checks (manual download): `src/main/bootstrap/autoUpdate.ts`, `src/main/window/updateWindow.ts`.
- Scan formats config: `src/types/globals.d.ts`, `src/renderer/src/components/settingDialog.vue`.
- Windows context menu: `src/types/globals.d.ts`, `src/main/bootstrap/settings.ts` (context menu settings).
- Global shortcuts: `src/types/globals.d.ts`, `src/main/window/mainWindow/index.ts`.

Site Structure Proposal (Single Page)
-------------------------------------
- Hero: speed-first positioning and platform availability notes.
- Key Features: 6 feature cards for the highest-impact capabilities.
- Workflow: 4 steps from import to export.
- Capability Matrix: grouped, detailed feature list.
- FAQ: cloud sync scope, offline use, fingerprint modes, AcoustID key, Linux status, updates.
- Specs: OS and formats (including AIF/AIFF); scan formats configurable.

Open Checks
-----------
- Keep supported formats list in sync with `settings.ts` when it changes.
- Ensure CN/EN lines remain paired when new features land.
