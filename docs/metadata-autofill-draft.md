# Metadata Auto-Fill Multi-Source Draft (Simplified)

Status: Draft

Goal
- Reduce "not found" cases by adding multiple fallback sources.
- Keep current MusicBrainz flow as primary.
- Optionally add DJ-specific fields (BPM, Key, Style).

Sources
Primary
- AcoustID -> MusicBrainz + Cover Art Archive (existing)

Fallback (used only if primary has no result)
- iTunes Search API
- Deezer API
- Spotify Web API (OAuth)
- Discogs API (token)

DJ-only enrichment (only when title + artist are reliable)
- Beatport (scrape)
- Traxsource (scrape)
- JunoDownload (scrape)

Minimal flow
1) Build query from tags + filename + duration.
2) Try AcoustID fingerprint -> MusicBrainz.
3) If no match, try text search in fallback sources.
4) Merge results with simple rules and write.

Matching rules
- Exact title + artist preferred.
- Duration diff <= 2-3 seconds adds confidence.
- ISRC match wins.

Overwrite rules
- Overwrite only if field is empty or looks placeholder.
- Allow overwrite for low-confidence existing fields.
- Keep high-confidence existing fields.

DJ field rules
- Fill BPM/Key/Style if missing.
- Do not overwrite existing BPM/Key by default.

Notes
- Each source can be rate-limited independently.
- Failures in one source should not block others.

Next steps
- Implement adapters for fallback sources.
- Add simple filename-based query parsing.
- Add DJ enrichment pass.
