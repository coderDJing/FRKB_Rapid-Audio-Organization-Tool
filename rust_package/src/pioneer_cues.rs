use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use napi_derive::napi;
use rekordcrate::util::ColorIndex;

use crate::pioneer_anlz_raw;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PioneerHotCueRecord {
  pub slot: u32,
  pub label: String,
  pub time_sec: f64,
  pub is_loop: bool,
  pub loop_time_sec: Option<f64>,
  pub comment: Option<String>,
  pub color_index: Option<u32>,
  pub color_name: Option<String>,
  pub color_hex: Option<String>,
  pub source: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct PioneerMemoryCueRecord {
  pub time_sec: f64,
  pub is_loop: bool,
  pub loop_time_sec: Option<f64>,
  pub order: u32,
  pub comment: Option<String>,
  pub color_index: Option<u32>,
  pub color_name: Option<String>,
  pub color_hex: Option<String>,
  pub source: Option<String>,
}

#[napi(object)]
pub struct PioneerCueDump {
  pub analyze_file_path: String,
  pub cue_file_path: String,
  pub hot_cues: Vec<PioneerHotCueRecord>,
  pub memory_cues: Vec<PioneerMemoryCueRecord>,
  pub error: Option<String>,
}

#[derive(Clone)]
struct ScoredHotCue {
  record: PioneerHotCueRecord,
  score: u32,
}

#[derive(Clone)]
struct ScoredMemoryCue {
  record: PioneerMemoryCueRecord,
  score: u32,
  time_ms: u32,
  loop_time_ms: Option<u32>,
}

const REKORDBOX_DEFAULT_HOT_CUE_HEX: &str = "#30d26e";

const REKORDBOX_HOT_CUE_COLORS: [&str; 63] = [
  REKORDBOX_DEFAULT_HOT_CUE_HEX,
  "#305aff",
  "#5073ff",
  "#508cff",
  "#50a0ff",
  "#50b4ff",
  "#50b0f2",
  "#50aee8",
  "#45acdb",
  "#00e0ff",
  "#19daf0",
  "#32d2e6",
  "#21b4b9",
  "#20aaa0",
  "#1fa392",
  "#19a08c",
  "#14a584",
  "#14aa7d",
  "#10b176",
  "#30d26e",
  "#37de5a",
  "#3ceb50",
  "#28e214",
  "#7dc13d",
  "#8cc832",
  "#9bd723",
  "#a5e116",
  "#a5dc0a",
  "#aad208",
  "#b4c805",
  "#b4be04",
  "#bab404",
  "#c3af04",
  "#e1aa00",
  "#ffa000",
  "#ff9600",
  "#ff8c00",
  "#ff7500",
  "#e0641b",
  "#e0461e",
  "#e0301e",
  "#e02823",
  "#e62828",
  "#ff376f",
  "#ff2d6f",
  "#ff127b",
  "#f51e8c",
  "#eb2da0",
  "#e637b4",
  "#de44cf",
  "#de448d",
  "#e630b4",
  "#e619dc",
  "#e600ff",
  "#dc00ff",
  "#cc00ff",
  "#b432ff",
  "#b93cff",
  "#c542ff",
  "#aa5aff",
  "#aa72ff",
  "#8272ff",
  "#6473ff",
];

fn build_empty_cue_dump(
  analyze_file_path: String,
  cue_file_path: String,
  error: impl Into<String>,
) -> PioneerCueDump {
  PioneerCueDump {
    analyze_file_path,
    cue_file_path,
    hot_cues: Vec::new(),
    memory_cues: Vec::new(),
    error: Some(error.into()),
  }
}

fn normalize_input_path(input_path: &str) -> String {
  input_path.trim().to_string()
}

fn build_pioneer_cue_candidates(input_path: &Path) -> Vec<PathBuf> {
  let mut candidates = Vec::new();
  let mut seen = HashSet::new();

  let push_unique = |path: PathBuf, acc: &mut Vec<PathBuf>, seen_set: &mut HashSet<String>| {
    let key = path.to_string_lossy().to_string();
    if seen_set.insert(key) {
      acc.push(path);
    }
  };

  let parsed = input_path.to_path_buf();
  let stem = parsed
    .file_stem()
    .map(|value| value.to_string_lossy().to_string());
  let parent = parsed.parent().map(|value| value.to_path_buf());

  if let (Some(parent), Some(stem)) = (parent.clone(), stem.clone()) {
    push_unique(
      parent.join(format!("{stem}.EXT")),
      &mut candidates,
      &mut seen,
    );
    push_unique(
      parent.join(format!("{stem}.DAT")),
      &mut candidates,
      &mut seen,
    );
    push_unique(
      parent.join(format!("{stem}.2EX")),
      &mut candidates,
      &mut seen,
    );
  }

  push_unique(parsed, &mut candidates, &mut seen);
  candidates
}

fn candidate_priority(candidate_path: &Path) -> u32 {
  match candidate_path
    .extension()
    .map(|value| value.to_string_lossy().to_ascii_uppercase())
    .unwrap_or_default()
    .as_str()
  {
    "2EX" => 300,
    "EXT" => 200,
    "DAT" => 100,
    _ => 0,
  }
}

fn seconds_from_millis(value: u32) -> f64 {
  f64::from(value) / 1000.0
}

fn normalize_comment(value: &str) -> Option<String> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    None
  } else {
    Some(trimmed.to_string())
  }
}

fn decode_utf16be_string(bytes: &[u8]) -> Option<String> {
  if bytes.is_empty() || bytes.len() % 2 != 0 {
    return None;
  }
  let mut units = Vec::with_capacity(bytes.len() / 2);
  for chunk in bytes.chunks_exact(2) {
    let value = u16::from_be_bytes([chunk[0], chunk[1]]);
    if value == 0 {
      break;
    }
    units.push(value);
  }
  if units.is_empty() {
    None
  } else {
    String::from_utf16(&units)
      .ok()
      .and_then(|text| normalize_comment(&text))
  }
}

fn hot_cue_label(slot: u32) -> String {
  if slot < 26 {
    let ascii = b'A' + u8::try_from(slot).unwrap_or(0);
    char::from(ascii).to_string()
  } else {
    (slot + 1).to_string()
  }
}

fn memory_color_triplet(color: &ColorIndex) -> (Option<u32>, Option<String>, Option<String>) {
  match color {
    ColorIndex::None => (None, None, None),
    ColorIndex::Pink => (
      Some(1),
      Some("pink".to_string()),
      Some("#ff7ab6".to_string()),
    ),
    ColorIndex::Red => (
      Some(2),
      Some("red".to_string()),
      Some("#ff4b57".to_string()),
    ),
    ColorIndex::Orange => (
      Some(3),
      Some("orange".to_string()),
      Some("#ff9a3d".to_string()),
    ),
    ColorIndex::Yellow => (
      Some(4),
      Some("yellow".to_string()),
      Some("#ffd34d".to_string()),
    ),
    ColorIndex::Green => (
      Some(5),
      Some("green".to_string()),
      Some("#41d36f".to_string()),
    ),
    ColorIndex::Aqua => (
      Some(6),
      Some("aqua".to_string()),
      Some("#3fd7d3".to_string()),
    ),
    ColorIndex::Blue => (
      Some(7),
      Some("blue".to_string()),
      Some("#4a78ff".to_string()),
    ),
    ColorIndex::Purple => (
      Some(8),
      Some("purple".to_string()),
      Some("#c26bff".to_string()),
    ),
  }
}

fn hot_cue_color_triplet(
  color_index: u8,
  rgb: (u8, u8, u8),
) -> (Option<u32>, Option<String>, Option<String>) {
  let resolved_index = if color_index == 0 {
    None
  } else {
    Some(u32::from(color_index))
  };
  let resolved_hex = if usize::from(color_index) < REKORDBOX_HOT_CUE_COLORS.len() {
    Some(REKORDBOX_HOT_CUE_COLORS[usize::from(color_index)].to_string())
  } else if rgb != (0, 0, 0) {
    Some(format!("#{:02x}{:02x}{:02x}", rgb.0, rgb.1, rgb.2))
  } else {
    Some(REKORDBOX_DEFAULT_HOT_CUE_HEX.to_string())
  };
  (resolved_index, resolved_hex.clone(), resolved_hex)
}

fn score_hot_cue(record: &PioneerHotCueRecord, base_priority: u32, extended: bool) -> u32 {
  let mut score = base_priority;
  if extended {
    score += 1000;
  }
  if record.is_loop {
    score += 80;
  }
  if record.comment.is_some() {
    score += 40;
  }
  if record.color_hex.is_some() {
    score += 20;
  }
  score
}

fn score_memory_cue(record: &PioneerMemoryCueRecord, base_priority: u32, extended: bool) -> u32 {
  let mut score = base_priority;
  if extended {
    score += 1000;
  }
  if record.is_loop {
    score += 80;
  }
  if record.comment.is_some() {
    score += 40;
  }
  if record.color_hex.is_some() {
    score += 20;
  }
  score
}

fn merge_hot_cue(
  target: &mut HashMap<u32, ScoredHotCue>,
  candidate: PioneerHotCueRecord,
  score: u32,
) {
  let slot = candidate.slot;
  match target.get(&slot) {
    Some(existing) if existing.score >= score => {}
    _ => {
      target.insert(
        slot,
        ScoredHotCue {
          record: candidate,
          score,
        },
      );
    }
  }
}

fn merge_memory_cue(
  target: &mut HashMap<String, ScoredMemoryCue>,
  candidate: PioneerMemoryCueRecord,
  time_ms: u32,
  loop_time_ms: Option<u32>,
  score: u32,
) {
  let key = format!("{time_ms}:{}", loop_time_ms.unwrap_or(0));
  match target.get(&key) {
    Some(existing) if existing.score >= score => {}
    _ => {
      target.insert(
        key,
        ScoredMemoryCue {
          record: candidate,
          score,
          time_ms,
          loop_time_ms,
        },
      );
    }
  }
}

fn parse_cues_from_file(
  candidate_path: &Path,
  hot_cues: &mut HashMap<u32, ScoredHotCue>,
  memory_cues: &mut HashMap<String, ScoredMemoryCue>,
) -> Result<bool, String> {
  let sections = pioneer_anlz_raw::read_pioneer_anlz_sections(candidate_path)
    .map_err(|error| format!("parse cue file failed: {error}"))?;
  let base_priority = candidate_priority(candidate_path);
  let mut did_parse_any_section = false;

  for section in sections {
    if pioneer_anlz_raw::section_kind_eq(&section, b"PCOB") {
      did_parse_any_section = true;
      if section.header_data.len() < 4 {
        continue;
      }
      let list_type = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
      let nested = pioneer_anlz_raw::parse_nested_anlz_sections(&section.content)
        .map_err(|error| format!("parse cue list failed: {error}"))?;
      for (index, cue_section) in nested.iter().enumerate() {
        if !pioneer_anlz_raw::section_kind_eq(cue_section, b"PCPT") {
          continue;
        }
        if cue_section.header_data.len() < 16 || cue_section.content.len() < 12 {
          continue;
        }
        let hot_cue = pioneer_anlz_raw::read_be_u32(&cue_section.header_data[0..4])?;
        let time_ms = pioneer_anlz_raw::read_be_u32(&cue_section.content[4..8])?;
        let raw_loop_time = pioneer_anlz_raw::read_be_u32(&cue_section.content[8..12])?;
        let cue_type = cue_section.content[0];
        let loop_time_ms = if cue_type == 2 && raw_loop_time > time_ms {
          Some(raw_loop_time)
        } else {
          None
        };
        if list_type == 1 {
          if hot_cue == 0 {
            continue;
          }
          let slot = hot_cue.saturating_sub(1);
          let record = PioneerHotCueRecord {
            slot,
            label: hot_cue_label(slot),
            time_sec: seconds_from_millis(time_ms),
            is_loop: loop_time_ms.is_some(),
            loop_time_sec: loop_time_ms.map(seconds_from_millis),
            comment: None,
            color_index: None,
            color_name: None,
            color_hex: Some(REKORDBOX_DEFAULT_HOT_CUE_HEX.to_string()),
            source: Some("rekordbox".to_string()),
          };
          let score = score_hot_cue(&record, base_priority, false);
          merge_hot_cue(hot_cues, record, score);
        } else {
          let record = PioneerMemoryCueRecord {
            time_sec: seconds_from_millis(time_ms),
            is_loop: loop_time_ms.is_some(),
            loop_time_sec: loop_time_ms.map(seconds_from_millis),
            order: u32::try_from(index).unwrap_or(u32::MAX),
            comment: None,
            color_index: None,
            color_name: None,
            color_hex: None,
            source: Some("rekordbox".to_string()),
          };
          let score = score_memory_cue(&record, base_priority, false);
          merge_memory_cue(memory_cues, record, time_ms, loop_time_ms, score);
        }
      }
      continue;
    }
    if pioneer_anlz_raw::section_kind_eq(&section, b"PCO2") {
      did_parse_any_section = true;
      if section.header_data.len() < 4 {
        continue;
      }
      let list_type = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
      let nested = pioneer_anlz_raw::parse_nested_anlz_sections(&section.content)
        .map_err(|error| format!("parse extended cue list failed: {error}"))?;
      for (index, cue_section) in nested.iter().enumerate() {
        if !pioneer_anlz_raw::section_kind_eq(cue_section, b"PCP2") {
          continue;
        }
        if cue_section.header_data.len() < 4 || cue_section.content.len() < 32 {
          continue;
        }
        let hot_cue = pioneer_anlz_raw::read_be_u32(&cue_section.header_data[0..4])?;
        let cue_type = cue_section.content[0];
        let time_ms = pioneer_anlz_raw::read_be_u32(&cue_section.content[4..8])?;
        let raw_loop_time = pioneer_anlz_raw::read_be_u32(&cue_section.content[8..12])?;
        let loop_time_ms = if cue_type == 2 && raw_loop_time > time_ms {
          Some(raw_loop_time)
        } else {
          None
        };
        let len_comment = pioneer_anlz_raw::read_be_u32(&cue_section.content[24..28])? as usize;
        let comment_start = 28usize;
        let comment_end = comment_start.saturating_add(len_comment);
        if cue_section.content.len() < comment_end + 4 {
          continue;
        }
        let comment = decode_utf16be_string(&cue_section.content[comment_start..comment_end]);
        let hot_color_index_offset = comment_end;
        let hot_cue_color_index = cue_section.content[hot_color_index_offset];
        let hot_cue_color_rgb = (
          cue_section.content[hot_color_index_offset + 1],
          cue_section.content[hot_color_index_offset + 2],
          cue_section.content[hot_color_index_offset + 3],
        );
        if list_type == 1 {
          if hot_cue == 0 {
            continue;
          }
          let slot = hot_cue.saturating_sub(1);
          let (color_index, color_name, color_hex) =
            hot_cue_color_triplet(hot_cue_color_index, hot_cue_color_rgb);
          let record = PioneerHotCueRecord {
            slot,
            label: hot_cue_label(slot),
            time_sec: seconds_from_millis(time_ms),
            is_loop: loop_time_ms.is_some(),
            loop_time_sec: loop_time_ms.map(seconds_from_millis),
            comment,
            color_index,
            color_name,
            color_hex,
            source: Some("rekordbox".to_string()),
          };
          let score = score_hot_cue(&record, base_priority, true);
          merge_hot_cue(hot_cues, record, score);
        } else {
          let memory_color = match cue_section.content[12] {
            1 => ColorIndex::Pink,
            2 => ColorIndex::Red,
            3 => ColorIndex::Orange,
            4 => ColorIndex::Yellow,
            5 => ColorIndex::Green,
            6 => ColorIndex::Aqua,
            7 => ColorIndex::Blue,
            8 => ColorIndex::Purple,
            _ => ColorIndex::None,
          };
          let (color_index, color_name, color_hex) = memory_color_triplet(&memory_color);
          let record = PioneerMemoryCueRecord {
            time_sec: seconds_from_millis(time_ms),
            is_loop: loop_time_ms.is_some(),
            loop_time_sec: loop_time_ms.map(seconds_from_millis),
            order: u32::try_from(index).unwrap_or(u32::MAX),
            comment,
            color_index,
            color_name,
            color_hex,
            source: Some("rekordbox".to_string()),
          };
          let score = score_memory_cue(&record, base_priority, true);
          merge_memory_cue(memory_cues, record, time_ms, loop_time_ms, score);
        }
      }
    }
  }

  Ok(did_parse_any_section)
}

#[napi]
pub fn read_pioneer_cues(analyze_file_path: String) -> PioneerCueDump {
  let normalized_input = normalize_input_path(&analyze_file_path);
  if normalized_input.is_empty() {
    return build_empty_cue_dump(
      analyze_file_path,
      String::new(),
      "analyze_file_path is empty",
    );
  }

  let input_path = Path::new(&normalized_input);
  let candidates = build_pioneer_cue_candidates(input_path);
  let mut hot_cues = HashMap::new();
  let mut memory_cues = HashMap::new();
  let mut last_error: Option<String> = None;
  let mut cue_file_path = String::new();
  let mut parsed_any_file = false;

  for candidate in candidates {
    if !candidate.exists() {
      continue;
    }
    match parse_cues_from_file(&candidate, &mut hot_cues, &mut memory_cues) {
      Ok(did_parse_sections) => {
        if !did_parse_sections {
          continue;
        }
        parsed_any_file = true;
        if cue_file_path.is_empty() {
          cue_file_path = candidate.to_string_lossy().to_string();
        }
      }
      Err(error) => {
        last_error = Some(error);
      }
    }
  }

  if !parsed_any_file {
    return build_empty_cue_dump(
      normalized_input,
      cue_file_path,
      last_error.unwrap_or_else(|| "cue file not found".to_string()),
    );
  }

  let mut hot_cue_values = hot_cues
    .into_values()
    .map(|entry| entry.record)
    .collect::<Vec<_>>();
  hot_cue_values.sort_by(|left, right| left.slot.cmp(&right.slot));

  let mut memory_cue_values = memory_cues.into_values().collect::<Vec<_>>();
  memory_cue_values.sort_by(|left, right| {
    left
      .record
      .order
      .cmp(&right.record.order)
      .then(left.time_ms.cmp(&right.time_ms))
      .then(left.loop_time_ms.cmp(&right.loop_time_ms))
  });

  PioneerCueDump {
    analyze_file_path: normalized_input,
    cue_file_path,
    hot_cues: hot_cue_values,
    memory_cues: memory_cue_values
      .into_iter()
      .map(|entry| entry.record)
      .collect(),
    error: None,
  }
}
