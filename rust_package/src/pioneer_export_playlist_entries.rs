use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use super::ParsedTrackRow;
#[derive(Clone, Copy)]
pub(super) struct RawPlaylistEntry {
  entry_index: u32,
  track_id: u32,
  location: usize,
}

const PDB_HEADER_SIZE: usize = 28;
const PDB_TABLE_SIZE: usize = 16;
const PDB_PAGE_HEADER_SIZE: usize = 40;
const PDB_ROW_GROUP_SIZE: usize = 36;
const PDB_ROW_GROUP_ENTRY_COUNT: usize = 16;
const PDB_PLAYLIST_ENTRY_SIZE: usize = 12;
const PDB_PLAYLIST_ENTRIES_PAGE_TYPE: u32 = 8;

fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
  let value: [u8; 2] = bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?;
  Some(u16::from_le_bytes(value))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
  let value: [u8; 4] = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
  Some(u32::from_le_bytes(value))
}

fn row_is_present(row_presence_flags: u16, row_index: usize) -> bool {
  row_index < PDB_ROW_GROUP_ENTRY_COUNT && row_presence_flags & (1u16 << row_index) != 0
}

pub(super) fn collect_raw_playlist_entries(
  pdb_path: &Path,
  playlist_id: u32,
) -> Vec<RawPlaylistEntry> {
  let bytes = match fs::read(pdb_path) {
    Ok(bytes) => bytes,
    Err(_) => return Vec::new(),
  };
  let page_size = match read_u32_le(&bytes, 4).and_then(|value| usize::try_from(value).ok()) {
    Some(value) if value >= PDB_PAGE_HEADER_SIZE => value,
    _ => return Vec::new(),
  };
  let table_count = match read_u32_le(&bytes, 8).and_then(|value| usize::try_from(value).ok()) {
    Some(value) => value,
    None => return Vec::new(),
  };

  let mut playlist_entries_table = None;
  for table_index in 0..table_count {
    let table_offset = match table_index
      .checked_mul(PDB_TABLE_SIZE)
      .and_then(|offset| PDB_HEADER_SIZE.checked_add(offset))
    {
      Some(offset) => offset,
      None => return Vec::new(),
    };
    if read_u32_le(&bytes, table_offset) != Some(PDB_PLAYLIST_ENTRIES_PAGE_TYPE) {
      continue;
    }
    playlist_entries_table = Some((
      read_u32_le(&bytes, table_offset + 8),
      read_u32_le(&bytes, table_offset + 12),
    ));
    break;
  }

  let Some((Some(mut page_index), Some(last_page_index))) = playlist_entries_table else {
    return Vec::new();
  };
  let mut seen_pages = HashSet::new();
  let mut entries = Vec::new();

  loop {
    if !seen_pages.insert(page_index) {
      return Vec::new();
    }
    let page_offset = match usize::try_from(page_index)
      .ok()
      .and_then(|index| index.checked_mul(page_size))
    {
      Some(offset) => offset,
      None => return Vec::new(),
    };
    let data_start = match page_offset.checked_add(PDB_PAGE_HEADER_SIZE) {
      Some(offset) => offset,
      None => return Vec::new(),
    };
    if read_u32_le(&bytes, page_offset + 8) != Some(PDB_PLAYLIST_ENTRIES_PAGE_TYPE) {
      return Vec::new();
    }
    let next_page_index = match read_u32_le(&bytes, page_offset + 12) {
      Some(value) => value,
      None => return Vec::new(),
    };
    let used_size = match read_u16_le(&bytes, page_offset + 30).map(usize::from) {
      Some(value) => value,
      None => return Vec::new(),
    };
    let data_end = match data_start
      .checked_add(used_size)
      .filter(|end| *end <= page_offset.saturating_add(page_size))
    {
      Some(offset) => offset,
      None => return Vec::new(),
    };

    let page_end = match page_offset.checked_add(page_size) {
      Some(offset) => offset,
      None => return Vec::new(),
    };
    let row_group_count = page_end.saturating_sub(data_end) / PDB_ROW_GROUP_SIZE;
    for row_group_index in 0..row_group_count {
      let row_group_end = match row_group_index
        .checked_mul(PDB_ROW_GROUP_SIZE)
        .and_then(|offset| page_end.checked_sub(offset))
      {
        Some(offset) => offset,
        None => return Vec::new(),
      };
      let row_presence_flags = match row_group_end
        .checked_sub(4)
        .and_then(|offset| read_u16_le(&bytes, offset))
      {
        Some(value) => value,
        None => return Vec::new(),
      };
      for row_index in 0..PDB_ROW_GROUP_ENTRY_COUNT {
        if !row_is_present(row_presence_flags, row_index) {
          continue;
        }
        let row_offset_field = match row_index
          .checked_add(1)
          .and_then(|index| index.checked_mul(2))
          .and_then(|offset| row_group_end.checked_sub(4 + offset))
        {
          Some(offset) => offset,
          None => return Vec::new(),
        };
        let record_offset = match read_u16_le(&bytes, row_offset_field)
          .map(usize::from)
          .and_then(|offset| data_start.checked_add(offset))
        {
          Some(offset) if offset.saturating_add(PDB_PLAYLIST_ENTRY_SIZE) <= data_end => offset,
          _ => continue,
        };
        let entry_index = read_u32_le(&bytes, record_offset).unwrap_or(0);
        let track_id = read_u32_le(&bytes, record_offset + 4).unwrap_or(0);
        let entry_playlist_id = read_u32_le(&bytes, record_offset + 8).unwrap_or(0);
        if entry_playlist_id == playlist_id && entry_index > 0 && track_id > 0 {
          entries.push(RawPlaylistEntry {
            entry_index,
            track_id,
            location: record_offset,
          });
        }
      }
    }
    if page_index == last_page_index {
      break;
    }
    page_index = next_page_index;
  }

  entries
}

pub(super) fn recover_complete_raw_playlist_entries(
  playlist_entries: &mut Vec<(u32, u32)>,
  raw_entries: &[RawPlaylistEntry],
  track_map: &HashMap<u32, ParsedTrackRow>,
) {
  let mut indexed_entries = BTreeMap::new();
  for &(entry_index, track_id) in playlist_entries.iter() {
    if entry_index == 0 || !track_map.contains_key(&track_id) {
      return;
    }
    if let Some(existing_track_id) = indexed_entries.insert(entry_index, track_id) {
      if existing_track_id != track_id {
        return;
      }
    }
  }
  let Some((&indexed_last_entry_index, &indexed_last_track_id)) = indexed_entries.last_key_value()
  else {
    return;
  };

  let mut raw_entries_by_index: BTreeMap<u32, Vec<RawPlaylistEntry>> = BTreeMap::new();
  for raw_entry in raw_entries {
    if !track_map.contains_key(&raw_entry.track_id) {
      continue;
    }
    raw_entries_by_index
      .entry(raw_entry.entry_index)
      .or_default()
      .push(*raw_entry);
  }
  for entries in raw_entries_by_index.values_mut() {
    entries.sort_by_key(|entry| entry.location);
  }

  let mut recovered_entries = indexed_entries;
  for entry_index in 1..=indexed_last_entry_index {
    if recovered_entries.contains_key(&entry_index) {
      continue;
    }
    let Some(raw_entry) = raw_entries_by_index
      .get(&entry_index)
      .and_then(|entries| entries.last())
    else {
      return;
    };
    recovered_entries.insert(entry_index, raw_entry.track_id);
  }

  let Some(anchor_location) = raw_entries_by_index
    .get(&indexed_last_entry_index)
    .and_then(|entries| {
      entries
        .iter()
        .find(|entry| entry.track_id == indexed_last_track_id)
    })
    .map(|entry| entry.location)
  else {
    return;
  };

  let mut previous_location = anchor_location;
  let mut entry_index = indexed_last_entry_index;
  while let Some(next_entry_index) = entry_index.checked_add(1) {
    let Some(raw_entry) = raw_entries_by_index
      .get(&next_entry_index)
      .and_then(|entries| {
        entries
          .iter()
          .find(|entry| entry.location > previous_location)
      })
    else {
      break;
    };
    recovered_entries.insert(next_entry_index, raw_entry.track_id);
    entry_index = next_entry_index;
    previous_location = raw_entry.location;
  }

  if recovered_entries.len() <= playlist_entries.len()
    || !recovered_entries
      .keys()
      .enumerate()
      .all(|(position, entry_index)| *entry_index == position as u32 + 1)
  {
    return;
  }

  *playlist_entries = recovered_entries.into_iter().collect();
}
#[cfg(test)]
mod playlist_entry_recovery_tests {
  use super::*;

  fn track_map(track_ids: impl IntoIterator<Item = u32>) -> HashMap<u32, ParsedTrackRow> {
    track_ids
      .into_iter()
      .map(|track_id| {
        (
          track_id,
          ParsedTrackRow {
            track_id,
            ..Default::default()
          },
        )
      })
      .collect()
  }

  #[test]
  fn reads_only_rows_marked_present_by_the_footer_bitmap() {
    assert!(row_is_present(0x10bf, 0));
    assert!(row_is_present(0x10bf, 12));
    assert!(!row_is_present(0x10bf, 6));
    assert!(!row_is_present(0x10bf, PDB_ROW_GROUP_ENTRY_COUNT));
  }

  #[test]
  fn restores_a_complete_unindexed_prefix() {
    let mut indexed_entries = (12..=18).map(|index| (index, index + 100)).collect();
    let raw_entries = (1..=18)
      .map(|index| RawPlaylistEntry {
        entry_index: index,
        track_id: index + 100,
        location: index as usize,
      })
      .collect::<Vec<_>>();
    let track_map = track_map(101..=118);

    recover_complete_raw_playlist_entries(&mut indexed_entries, &raw_entries, &track_map);

    assert_eq!(
      indexed_entries,
      (1..=18)
        .map(|index| (index, index + 100))
        .collect::<Vec<_>>()
    );
  }

  #[test]
  fn rejects_a_partial_unindexed_prefix() {
    let mut indexed_entries = (12..=18).map(|index| (index, index + 100)).collect();
    let raw_entries = (1..=10)
      .map(|index| RawPlaylistEntry {
        entry_index: index,
        track_id: index + 100,
        location: index as usize,
      })
      .collect::<Vec<_>>();
    let track_map = track_map(101..=118);

    recover_complete_raw_playlist_entries(&mut indexed_entries, &raw_entries, &track_map);

    assert_eq!(
      indexed_entries,
      (12..=18)
        .map(|index| (index, index + 100))
        .collect::<Vec<_>>()
    );
  }
  #[test]
  fn preserves_present_entries_when_filling_a_gap_and_appending_a_suffix() {
    let mut indexed_entries = vec![(1, 101), (2, 102), (3, 103), (5, 105), (6, 106)];
    let raw_entries = vec![
      RawPlaylistEntry {
        entry_index: 4,
        track_id: 104,
        location: 40,
      },
      RawPlaylistEntry {
        entry_index: 5,
        track_id: 105,
        location: 50,
      },
      RawPlaylistEntry {
        entry_index: 6,
        track_id: 106,
        location: 60,
      },
      RawPlaylistEntry {
        entry_index: 7,
        track_id: 107,
        location: 70,
      },
      RawPlaylistEntry {
        entry_index: 8,
        track_id: 108,
        location: 80,
      },
      RawPlaylistEntry {
        entry_index: 5,
        track_id: 205,
        location: 200,
      },
    ];
    let track_map = track_map((101..=108).chain([205]));

    recover_complete_raw_playlist_entries(&mut indexed_entries, &raw_entries, &track_map);

    assert_eq!(
      indexed_entries,
      (1..=5)
        .map(|index| (index, index + 100))
        .chain((6..=8).map(|index| (index, index + 100)))
        .collect::<Vec<_>>()
    );
  }
}
