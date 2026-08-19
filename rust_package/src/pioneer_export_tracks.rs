use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

use binrw::BinRead;
use parking_lot::Mutex;
use rekordcrate::pdb::{Header as RekordcrateHeader, Row as RekordcrateRow};

use super::pioneer_export_playlist_entries::{
  collect_raw_playlist_entries_by_playlist, recover_complete_raw_playlist_entries,
};
use super::{
  parse_artwork_row, parse_named_row, parse_playlist_entry_row, parse_track_row, ParsedTrackRow,
  PioneerPlaylistTrackDump, PioneerPlaylistTrackRecord,
};

#[derive(Clone, PartialEq, Eq)]
struct PdbIdentity {
  path: String,
  len: u64,
  modified: SystemTime,
}

struct CachedPdbLibrary {
  identity: PdbIdentity,
  playlist_name_by_id: HashMap<u32, String>,
  playlist_entries_by_id: HashMap<u32, Vec<(u32, u32)>>,
  artist_map: HashMap<u32, String>,
  album_map: HashMap<u32, String>,
  label_map: HashMap<u32, String>,
  genre_map: HashMap<u32, String>,
  key_map: HashMap<u32, String>,
  artwork_map: HashMap<u32, String>,
  track_map: HashMap<u32, ParsedTrackRow>,
}

static PDB_LIBRARY_CACHE: Mutex<Option<Arc<CachedPdbLibrary>>> = Mutex::new(None);

fn build_empty(
  path: String,
  playlist_id: u32,
  error: impl Into<String>,
) -> PioneerPlaylistTrackDump {
  PioneerPlaylistTrackDump {
    export_pdb_path: path,
    playlist_id,
    playlist_name: String::new(),
    track_total: 0,
    tracks: Vec::new(),
    error: Some(error.into()),
  }
}

fn read_pdb_identity(path: &Path, normalized_path: &str) -> Result<PdbIdentity, String> {
  let metadata =
    std::fs::metadata(path).map_err(|error| format!("stat export.pdb failed: {error}"))?;
  let modified = metadata
    .modified()
    .map_err(|error| format!("mtime export.pdb failed: {error}"))?;
  Ok(PdbIdentity {
    path: normalized_path.to_string(),
    len: metadata.len(),
    modified,
  })
}

fn parse_pdb_library(pdb_path: &Path, identity: PdbIdentity) -> Result<CachedPdbLibrary, String> {
  let mut reader =
    File::open(pdb_path).map_err(|error| format!("open export.pdb failed: {error}"))?;
  let header = RekordcrateHeader::read(&mut reader)
    .map_err(|error| format!("parse export.pdb header failed: {error}"))?;

  let mut playlist_name_by_id: HashMap<u32, String> = HashMap::new();
  let mut playlist_entries_by_id: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
  let mut artist_map: HashMap<u32, String> = HashMap::new();
  let mut album_map: HashMap<u32, String> = HashMap::new();
  let mut label_map: HashMap<u32, String> = HashMap::new();
  let mut genre_map: HashMap<u32, String> = HashMap::new();
  let mut key_map: HashMap<u32, String> = HashMap::new();
  let mut artwork_map: HashMap<u32, String> = HashMap::new();
  let mut track_map: HashMap<u32, ParsedTrackRow> = HashMap::new();

  for table in &header.tables {
    let pages = header
      .read_pages(
        &mut reader,
        binrw::Endian::NATIVE,
        (&table.first_page, &table.last_page),
      )
      .map_err(|error| format!("read pages for {:?} failed: {error}", table.page_type))?;

    for page in pages {
      for row_group in page.row_groups {
        for row in row_group.present_rows() {
          match row {
            RekordcrateRow::PlaylistTreeNode(node) => {
              let name = node
                .name
                .clone()
                .into_string()
                .unwrap_or_else(|_| format!("{:?}", node.name));
              playlist_name_by_id.insert(node.id.0, name);
            }
            RekordcrateRow::PlaylistEntry(entry) => {
              let debug = format!("{entry:?}");
              if let Some((entry_playlist_id, track_id, entry_index)) =
                parse_playlist_entry_row(&debug)
              {
                if entry_playlist_id > 0 {
                  playlist_entries_by_id
                    .entry(entry_playlist_id)
                    .or_default()
                    .push((entry_index, track_id));
                }
              }
            }
            RekordcrateRow::Artist(artist) => {
              let debug = format!("{artist:?}");
              if let Some((id, name)) = parse_named_row(&debug, "id: ArtistId(") {
                artist_map.insert(id, name);
              }
            }
            RekordcrateRow::Album(album) => {
              let debug = format!("{album:?}");
              if let Some((id, name)) = parse_named_row(&debug, "id: AlbumId(") {
                album_map.insert(id, name);
              }
            }
            RekordcrateRow::Label(label) => {
              let debug = format!("{label:?}");
              if let Some((id, name)) = parse_named_row(&debug, "id: LabelId(") {
                label_map.insert(id, name);
              }
            }
            RekordcrateRow::Genre(genre) => {
              let debug = format!("{genre:?}");
              if let Some((id, name)) = parse_named_row(&debug, "id: GenreId(") {
                genre_map.insert(id, name);
              }
            }
            RekordcrateRow::Key(key) => {
              let debug = format!("{key:?}");
              if let Some((id, name)) = parse_named_row(&debug, "id: KeyId(") {
                key_map.insert(id, name);
              }
            }
            RekordcrateRow::Track(track) => {
              let debug = format!("{track:?}");
              let parsed = parse_track_row(&debug);
              if parsed.track_id > 0 {
                track_map.insert(parsed.track_id, parsed);
              }
            }
            RekordcrateRow::Artwork(artwork) => {
              let debug = format!("{artwork:?}");
              if let Some((id, artwork_path)) = parse_artwork_row(&debug) {
                artwork_map.insert(id, artwork_path);
              }
            }
            _ => {}
          }
        }
      }
    }
  }

  let mut raw_by_playlist = collect_raw_playlist_entries_by_playlist(pdb_path);
  let mut playlist_ids: HashSet<u32> = playlist_entries_by_id.keys().copied().collect();
  playlist_ids.extend(raw_by_playlist.keys().copied());
  for playlist_id in playlist_ids {
    let mut entries = playlist_entries_by_id
      .remove(&playlist_id)
      .unwrap_or_default();
    let raw_entries = raw_by_playlist.remove(&playlist_id).unwrap_or_default();
    recover_complete_raw_playlist_entries(&mut entries, &raw_entries, &track_map);
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    playlist_entries_by_id.insert(playlist_id, entries);
  }

  Ok(CachedPdbLibrary {
    identity,
    playlist_name_by_id,
    playlist_entries_by_id,
    artist_map,
    album_map,
    label_map,
    genre_map,
    key_map,
    artwork_map,
    track_map,
  })
}

fn load_cached_pdb_library(normalized_path: &str) -> Result<Arc<CachedPdbLibrary>, String> {
  let pdb_path = Path::new(normalized_path);
  if !pdb_path.exists() {
    return Err("export.pdb not found".to_string());
  }
  let identity = read_pdb_identity(pdb_path, normalized_path)?;
  {
    let cache = PDB_LIBRARY_CACHE.lock();
    if let Some(cached) = cache.as_ref() {
      if cached.identity == identity {
        return Ok(Arc::clone(cached));
      }
    }
  }

  let parsed = Arc::new(parse_pdb_library(pdb_path, identity)?);
  let mut cache = PDB_LIBRARY_CACHE.lock();
  if let Some(cached) = cache.as_ref() {
    if cached.identity == parsed.identity {
      return Ok(Arc::clone(cached));
    }
  }
  *cache = Some(Arc::clone(&parsed));
  Ok(parsed)
}

fn assemble_playlist_tracks(
  library: &CachedPdbLibrary,
  export_pdb_path: String,
  playlist_id: u32,
  max_rows: Option<u32>,
) -> PioneerPlaylistTrackDump {
  let playlist_entries = library
    .playlist_entries_by_id
    .get(&playlist_id)
    .cloned()
    .unwrap_or_default();
  let limit = max_rows.unwrap_or(u32::MAX) as usize;
  let mut tracks = Vec::new();
  for (entry_index, track_id) in playlist_entries.iter().take(limit) {
    let Some(track) = library.track_map.get(track_id) else {
      continue;
    };
    tracks.push(PioneerPlaylistTrackRecord {
      playlist_id,
      track_id: track.track_id,
      entry_index: *entry_index,
      title: track.title.clone(),
      file_name: track.file_name.clone(),
      file_path: track.file_path.clone(),
      artist: library
        .artist_map
        .get(&track.artist_id)
        .cloned()
        .unwrap_or_default(),
      album: library
        .album_map
        .get(&track.album_id)
        .cloned()
        .unwrap_or_default(),
      label: library
        .label_map
        .get(&track.label_id)
        .cloned()
        .unwrap_or_default(),
      genre: library
        .genre_map
        .get(&track.genre_id)
        .cloned()
        .unwrap_or_default(),
      key_text: library
        .key_map
        .get(&track.key_id)
        .cloned()
        .unwrap_or_default(),
      bpm: track.bpm,
      duration_sec: track.duration_sec,
      bitrate: track.bitrate,
      sample_rate: track.sample_rate,
      sample_depth: track.sample_depth,
      track_number: track.track_number,
      disc_number: track.disc_number,
      year: track.year,
      analyze_path: track.analyze_path.clone(),
      comment: track.comment.clone(),
      date_added: track.date_added.clone(),
      artwork_id: track.artwork_id,
      artwork_path: library
        .artwork_map
        .get(&track.artwork_id)
        .cloned()
        .unwrap_or_default(),
    });
  }

  PioneerPlaylistTrackDump {
    export_pdb_path,
    playlist_id,
    playlist_name: library
      .playlist_name_by_id
      .get(&playlist_id)
      .cloned()
      .unwrap_or_default(),
    track_total: playlist_entries.len() as u32,
    tracks,
    error: None,
  }
}

#[napi]
pub fn read_pioneer_playlist_tracks(
  export_pdb_path: String,
  playlist_id: u32,
  max_rows: Option<u32>,
) -> PioneerPlaylistTrackDump {
  let normalized_path = export_pdb_path.trim().to_string();
  if normalized_path.is_empty() {
    return build_empty(export_pdb_path, playlist_id, "export_pdb_path is empty");
  }
  if playlist_id == 0 {
    return build_empty(normalized_path, playlist_id, "playlist_id is 0");
  }

  match load_cached_pdb_library(&normalized_path) {
    Ok(library) => assemble_playlist_tracks(&library, normalized_path, playlist_id, max_rows),
    Err(error) => build_empty(normalized_path, playlist_id, error),
  }
}
