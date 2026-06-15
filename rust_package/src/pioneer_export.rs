use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::result::Result as StdResult;

use binrw::BinRead;
use rekordcrate::pdb::{
  Header as RekordcrateHeader, PlaylistTreeNode, PlaylistTreeNodeId, Row as RekordcrateRow,
};

use crate::pioneer_anlz_raw;

/// Pioneer 旧 Device Library 调试输出
#[napi(object)]
pub struct PioneerExportDebugDump {
  /// export.pdb 路径
  pub export_pdb_path: String,
  /// 表摘要
  pub table_summaries: Vec<String>,
  /// 以树形文本打印的播放列表结构
  pub playlist_tree_lines: Vec<String>,
  /// 播放列表树原始行总数
  pub playlist_tree_total: u32,
  /// 播放列表项原始行总数
  pub playlist_entry_total: u32,
  /// 曲目原始行总数
  pub track_total: u32,
  /// 播放列表项调试文本
  pub playlist_entries: Vec<String>,
  /// 曲目调试文本
  pub tracks: Vec<String>,
  /// 错误描述（失败时）
  pub error: Option<String>,
}

/// Pioneer 播放列表树节点
#[napi(object)]
pub struct PioneerPlaylistTreeNodeRecord {
  /// 节点 ID
  pub id: u32,
  /// 父节点 ID（根为 0）
  pub parent_id: u32,
  /// 节点名称
  pub name: String,
  /// 是否为文件夹
  pub is_folder: bool,
  /// 读取顺序，用于前端稳定排序
  pub order: u32,
  /// Rekordbox 排序字段
  pub sort_order: u32,
}

/// Pioneer 播放列表树读取结果
#[napi(object)]
pub struct PioneerPlaylistTreeDump {
  /// export.pdb 路径
  pub export_pdb_path: String,
  /// 节点总数
  pub node_total: u32,
  /// 文件夹节点数
  pub folder_total: u32,
  /// 歌单节点数
  pub playlist_total: u32,
  /// 播放列表树节点
  pub nodes: Vec<PioneerPlaylistTreeNodeRecord>,
  /// 错误描述（失败时）
  pub error: Option<String>,
}

/// Pioneer 歌单曲目记录
#[napi(object)]
pub struct PioneerPlaylistTrackRecord {
  /// 播放列表 ID
  pub playlist_id: u32,
  /// 曲目 ID
  pub track_id: u32,
  /// 原始 entry_index
  pub entry_index: u32,
  /// 曲目标题
  pub title: String,
  /// 文件名
  pub file_name: String,
  /// 文件路径
  pub file_path: String,
  /// 艺术家
  pub artist: String,
  /// 专辑
  pub album: String,
  /// 厂牌
  pub label: String,
  /// 流派
  pub genre: String,
  /// 调性文本
  pub key_text: String,
  /// BPM
  pub bpm: f64,
  /// 时长（秒）
  pub duration_sec: u32,
  /// 比特率
  pub bitrate: u32,
  /// 采样率
  pub sample_rate: u32,
  /// 采样位深
  pub sample_depth: u32,
  /// 音轨号
  pub track_number: u32,
  /// 碟号
  pub disc_number: u32,
  /// 年份
  pub year: u32,
  /// 分析文件路径
  pub analyze_path: String,
  /// 评论
  pub comment: String,
  /// 导入日期
  pub date_added: String,
  /// 封面 Artwork ID
  pub artwork_id: u32,
  /// 封面路径（相对 U 盘根目录的 Pioneer 路径）
  pub artwork_path: String,
}

/// Pioneer 单歌单曲目读取结果
#[napi(object)]
pub struct PioneerPlaylistTrackDump {
  /// export.pdb 路径
  pub export_pdb_path: String,
  /// 播放列表 ID
  pub playlist_id: u32,
  /// 播放列表名称
  pub playlist_name: String,
  /// 曲目总数
  pub track_total: u32,
  /// 曲目列表
  pub tracks: Vec<PioneerPlaylistTrackRecord>,
  /// 错误描述（失败时）
  pub error: Option<String>,
}

/// Pioneer 预览波形单列
#[napi(object)]
pub struct PioneerPreviewWaveformColumn {
  /// 背景层高度
  pub back_height: u8,
  /// 前景层高度
  pub front_height: u8,
  /// 背景层颜色 R
  pub back_color_r: u8,
  /// 背景层颜色 G
  pub back_color_g: u8,
  /// 背景层颜色 B
  pub back_color_b: u8,
  /// 前景层颜色 R
  pub front_color_r: u8,
  /// 前景层颜色 G
  pub front_color_g: u8,
  /// 前景层颜色 B
  pub front_color_b: u8,
}

/// Pioneer 预览波形读取结果
#[napi(object)]
pub struct PioneerPreviewWaveformDump {
  /// export.pdb 里记录的分析文件路径
  pub analyze_file_path: String,
  /// 实际读取的预览文件路径
  pub preview_file_path: String,
  /// 波形样式（blue / rgb）
  pub style: String,
  /// 波形列数
  pub column_count: u32,
  /// 最大高度
  pub max_height: u32,
  /// 预览波形列
  pub columns: Vec<PioneerPreviewWaveformColumn>,
  /// 错误描述（失败时）
  pub error: Option<String>,
}

#[napi]
pub fn dump_pioneer_export_debug(
  export_pdb_path: String,
  max_rows: Option<u32>,
) -> PioneerExportDebugDump {
  fn build_empty(path: String, error: impl Into<String>) -> PioneerExportDebugDump {
    PioneerExportDebugDump {
      export_pdb_path: path,
      table_summaries: Vec::new(),
      playlist_tree_lines: Vec::new(),
      playlist_tree_total: 0,
      playlist_entry_total: 0,
      track_total: 0,
      playlist_entries: Vec::new(),
      tracks: Vec::new(),
      error: Some(error.into()),
    }
  }

  fn push_limited(target: &mut Vec<String>, limit: usize, value: String) {
    if target.len() < limit {
      target.push(value);
    }
  }

  fn render_playlist_tree(
    map: &HashMap<PlaylistTreeNodeId, Vec<PlaylistTreeNode>>,
    id: PlaylistTreeNodeId,
    level: usize,
    output: &mut Vec<String>,
  ) {
    if let Some(nodes) = map.get(&id) {
      for node in nodes {
        let name = node
          .name
          .clone()
          .into_string()
          .unwrap_or_else(|_| format!("{:?}", node.name));
        let node_type = if node.is_folder() {
          "folder"
        } else {
          "playlist"
        };
        output.push(format!(
          "{}- [{}] id={} parent={} name={}",
          "  ".repeat(level),
          node_type,
          node.id.0,
          node.parent_id.0,
          name
        ));
        render_playlist_tree(map, node.id, level + 1, output);
      }
    }
  }

  let limit = max_rows.unwrap_or(80).max(1) as usize;
  let normalized_path = export_pdb_path.trim().to_string();
  if normalized_path.is_empty() {
    return build_empty(export_pdb_path, "export_pdb_path is empty");
  }

  let pdb_path = Path::new(&normalized_path);
  if !pdb_path.exists() {
    return build_empty(normalized_path, "export.pdb not found");
  }

  let mut reader = match File::open(pdb_path) {
    Ok(file) => file,
    Err(error) => return build_empty(normalized_path, format!("open export.pdb failed: {error}")),
  };

  let header = match RekordcrateHeader::read(&mut reader) {
    Ok(header) => header,
    Err(error) => {
      return build_empty(
        normalized_path,
        format!("parse export.pdb header failed: {error}"),
      )
    }
  };

  let table_summaries = header
    .tables
    .iter()
    .enumerate()
    .map(|(index, table)| format!("{index}: {:?}", table.page_type))
    .collect::<Vec<String>>();

  let mut playlist_tree_total = 0u32;
  let mut playlist_entry_total = 0u32;
  let mut track_total = 0u32;
  let mut playlist_entries = Vec::new();
  let mut tracks = Vec::new();
  let mut playlist_tree_map: HashMap<PlaylistTreeNodeId, Vec<PlaylistTreeNode>> = HashMap::new();

  for table in &header.tables {
    let pages = match header.read_pages(
      &mut reader,
      binrw::Endian::NATIVE,
      (&table.first_page, &table.last_page),
    ) {
      Ok(pages) => pages,
      Err(error) => {
        return build_empty(
          normalized_path,
          format!("read pages for {:?} failed: {error}", table.page_type),
        )
      }
    };

    for page in pages {
      for row_group in page.row_groups {
        for row in row_group.present_rows() {
          match row {
            RekordcrateRow::PlaylistTreeNode(node) => {
              playlist_tree_total += 1;
              playlist_tree_map
                .entry(node.parent_id)
                .or_default()
                .push(node);
            }
            RekordcrateRow::PlaylistEntry(entry) => {
              playlist_entry_total += 1;
              push_limited(&mut playlist_entries, limit, format!("{entry:?}"));
            }
            RekordcrateRow::Track(track) => {
              track_total += 1;
              push_limited(&mut tracks, limit, format!("{track:?}"));
            }
            _ => {}
          }
        }
      }
    }
  }

  for nodes in playlist_tree_map.values_mut() {
    nodes.sort_by(|left, right| {
      left
        .name
        .clone()
        .into_string()
        .unwrap_or_default()
        .cmp(&right.name.clone().into_string().unwrap_or_default())
    });
  }

  let mut playlist_tree_lines = Vec::new();
  render_playlist_tree(
    &playlist_tree_map,
    PlaylistTreeNodeId(0),
    0,
    &mut playlist_tree_lines,
  );
  if playlist_tree_lines.len() > limit {
    playlist_tree_lines.truncate(limit);
  }

  PioneerExportDebugDump {
    export_pdb_path: normalized_path,
    table_summaries,
    playlist_tree_lines,
    playlist_tree_total,
    playlist_entry_total,
    track_total,
    playlist_entries,
    tracks,
    error: None,
  }
}

fn extract_sort_order_from_debug(debug: &str) -> u32 {
  extract_plain_u32_field(debug, "sort_order: ").unwrap_or(0)
}

#[napi]
pub fn read_pioneer_playlist_tree(export_pdb_path: String) -> PioneerPlaylistTreeDump {
  fn build_empty(path: String, error: impl Into<String>) -> PioneerPlaylistTreeDump {
    PioneerPlaylistTreeDump {
      export_pdb_path: path,
      node_total: 0,
      folder_total: 0,
      playlist_total: 0,
      nodes: Vec::new(),
      error: Some(error.into()),
    }
  }

  let normalized_path = export_pdb_path.trim().to_string();
  if normalized_path.is_empty() {
    return build_empty(export_pdb_path, "export_pdb_path is empty");
  }

  let pdb_path = Path::new(&normalized_path);
  if !pdb_path.exists() {
    return build_empty(normalized_path, "export.pdb not found");
  }

  let mut reader = match File::open(pdb_path) {
    Ok(file) => file,
    Err(error) => return build_empty(normalized_path, format!("open export.pdb failed: {error}")),
  };

  let header = match RekordcrateHeader::read(&mut reader) {
    Ok(header) => header,
    Err(error) => {
      return build_empty(
        normalized_path,
        format!("parse export.pdb header failed: {error}"),
      )
    }
  };

  let mut nodes = Vec::new();
  let mut order = 0u32;
  let mut folder_total = 0u32;
  let mut playlist_total = 0u32;

  for table in &header.tables {
    if !matches!(table.page_type, rekordcrate::pdb::PageType::PlaylistTree) {
      continue;
    }

    let pages = match header.read_pages(
      &mut reader,
      binrw::Endian::NATIVE,
      (&table.first_page, &table.last_page),
    ) {
      Ok(pages) => pages,
      Err(error) => {
        return build_empty(
          normalized_path,
          format!("read pages for {:?} failed: {error}", table.page_type),
        )
      }
    };

    for page in pages {
      for row_group in page.row_groups {
        for row in row_group.present_rows() {
          if let RekordcrateRow::PlaylistTreeNode(node) = row {
            let name = node
              .name
              .clone()
              .into_string()
              .unwrap_or_else(|_| format!("{:?}", node.name));
            let is_folder = node.is_folder();
            let debug_output = format!("{:?}", node);
            let sort_order = extract_sort_order_from_debug(&debug_output);
            if is_folder {
              folder_total += 1;
            } else {
              playlist_total += 1;
            }
            nodes.push(PioneerPlaylistTreeNodeRecord {
              id: node.id.0,
              parent_id: node.parent_id.0,
              name,
              is_folder,
              order,
              sort_order,
            });
            order += 1;
          }
        }
      }
    }
  }

  PioneerPlaylistTreeDump {
    export_pdb_path: normalized_path,
    node_total: nodes.len() as u32,
    folder_total,
    playlist_total,
    nodes,
    error: None,
  }
}

fn extract_u32_field(text: &str, prefix: &str) -> Option<u32> {
  let start = text.find(prefix)? + prefix.len();
  let tail = &text[start..];
  let end = tail.find(')')?;
  tail[..end].trim().parse::<u32>().ok()
}

fn extract_plain_u32_field(text: &str, prefix: &str) -> Option<u32> {
  let start = text.find(prefix)? + prefix.len();
  let tail = &text[start..];
  let end = tail.find(',').unwrap_or(tail.len());
  tail[..end].trim().parse::<u32>().ok()
}

fn extract_devicesql_field(text: &str, prefix: &str) -> Option<String> {
  let start = text.find(prefix)? + prefix.len();
  let tail = &text[start..];
  let mut out = String::new();
  let mut escaped = false;
  let chars: Vec<char> = tail.chars().collect();
  let mut index = 0usize;
  while index < chars.len() {
    let ch = chars[index];
    if escaped {
      match ch {
        '\\' => out.push('\\'),
        '"' => out.push('"'),
        'n' => out.push('\n'),
        'r' => out.push('\r'),
        't' => out.push('\t'),
        'u' => {
          if index + 1 < chars.len() && chars[index + 1] == '{' {
            let mut end = index + 2;
            let mut hex = String::new();
            while end < chars.len() && chars[end] != '}' {
              hex.push(chars[end]);
              end += 1;
            }
            if end < chars.len() {
              if let Ok(value) = u32::from_str_radix(&hex, 16) {
                if let Some(decoded) = char::from_u32(value) {
                  out.push(decoded);
                }
              }
              index = end;
            }
          } else {
            out.push(ch);
          }
        }
        _ => out.push(ch),
      }
      escaped = false;
      index += 1;
      continue;
    }
    if ch == '\\' {
      escaped = true;
      index += 1;
      continue;
    }
    if ch == '"' {
      return Some(out);
    }
    out.push(ch);
    index += 1;
  }
  Some(out)
}

#[derive(Debug, Default, Clone)]
struct ParsedTrackRow {
  track_id: u32,
  artwork_id: u32,
  artist_id: u32,
  album_id: u32,
  label_id: u32,
  genre_id: u32,
  key_id: u32,
  title: String,
  file_name: String,
  file_path: String,
  analyze_path: String,
  comment: String,
  date_added: String,
  bpm: f64,
  duration_sec: u32,
  bitrate: u32,
  sample_rate: u32,
  sample_depth: u32,
  track_number: u32,
  disc_number: u32,
  year: u32,
}

fn parse_track_row(debug: &str) -> ParsedTrackRow {
  ParsedTrackRow {
    track_id: extract_u32_field(debug, "id: TrackId(").unwrap_or(0),
    artwork_id: extract_u32_field(debug, "artwork_id: ArtworkId(").unwrap_or(0),
    artist_id: extract_u32_field(debug, "artist_id: ArtistId(").unwrap_or(0),
    album_id: extract_u32_field(debug, "album_id: AlbumId(").unwrap_or(0),
    label_id: extract_u32_field(debug, "label_id: LabelId(").unwrap_or(0),
    genre_id: extract_u32_field(debug, "genre_id: GenreId(").unwrap_or(0),
    key_id: extract_u32_field(debug, "key_id: KeyId(").unwrap_or(0),
    title: extract_devicesql_field(debug, "title: DeviceSQLString(\"").unwrap_or_default(),
    file_name: extract_devicesql_field(debug, "filename: DeviceSQLString(\"").unwrap_or_default(),
    file_path: extract_devicesql_field(debug, "file_path: DeviceSQLString(\"").unwrap_or_default(),
    analyze_path: extract_devicesql_field(debug, "analyze_path: DeviceSQLString(\"")
      .unwrap_or_default(),
    comment: extract_devicesql_field(debug, "comment: DeviceSQLString(\"").unwrap_or_default(),
    date_added: extract_devicesql_field(debug, "date_added: DeviceSQLString(\"")
      .unwrap_or_default(),
    bpm: extract_plain_u32_field(debug, "tempo: ")
      .map(|value| value as f64 / 100.0)
      .unwrap_or(0.0),
    duration_sec: extract_plain_u32_field(debug, "duration: ").unwrap_or(0),
    bitrate: extract_plain_u32_field(debug, "bitrate: ").unwrap_or(0),
    sample_rate: extract_plain_u32_field(debug, "sample_rate: ").unwrap_or(0),
    sample_depth: extract_plain_u32_field(debug, "sample_depth: ").unwrap_or(0),
    track_number: extract_plain_u32_field(debug, "track_number: ").unwrap_or(0),
    disc_number: extract_plain_u32_field(debug, "disc_number: ").unwrap_or(0),
    year: extract_plain_u32_field(debug, "year: ").unwrap_or(0),
  }
}

fn parse_playlist_entry_row(debug: &str) -> Option<(u32, u32, u32)> {
  let entry_index = extract_plain_u32_field(debug, "entry_index: ")?;
  let track_id = extract_u32_field(debug, "track_id: TrackId(")?;
  let playlist_id = extract_u32_field(debug, "playlist_id: PlaylistTreeNodeId(")?;
  Some((playlist_id, track_id, entry_index))
}

fn parse_named_row(debug: &str, id_prefix: &str) -> Option<(u32, String)> {
  let id = extract_u32_field(debug, id_prefix)?;
  let name = extract_devicesql_field(debug, "name: DeviceSQLString(\"")?;
  Some((id, name))
}

fn parse_artwork_row(debug: &str) -> Option<(u32, String)> {
  let id = extract_u32_field(debug, "id: ArtworkId(")?;
  let path = extract_devicesql_field(debug, "path: DeviceSQLString(\"")?;
  Some((id, path))
}

fn build_pioneer_preview_waveform_candidates(input_path: &Path) -> Vec<PathBuf> {
  let mut candidates = Vec::new();
  let mut seen = HashSet::new();
  let mut push_unique = |path: PathBuf| {
    let key = path.to_string_lossy().to_lowercase();
    if seen.insert(key) {
      candidates.push(path);
    }
  };

  let normalized = input_path.to_path_buf();
  let ext = normalized
    .extension()
    .and_then(|value| value.to_str())
    .map(|value| value.to_ascii_lowercase())
    .unwrap_or_default();

  if ext == "dat" || ext == "ext" || ext == "2ex" {
    push_unique(normalized.with_extension("EXT"));
    push_unique(normalized.with_extension("DAT"));
    push_unique(normalized.with_extension("2EX"));
  }
  push_unique(normalized);

  candidates
}

fn build_pioneer_blue_waveform_column(height: u8, intense: bool) -> PioneerPreviewWaveformColumn {
  let (r, g, b) = if intense {
    (116u8, 246u8, 244u8)
  } else {
    (43u8, 89u8, 255u8)
  };

  PioneerPreviewWaveformColumn {
    back_height: height,
    front_height: height,
    back_color_r: r,
    back_color_g: g,
    back_color_b: b,
    front_color_r: r,
    front_color_g: g,
    front_color_b: b,
  }
}

fn build_pioneer_rgb_waveform_column(
  red_source: u8,
  green_source: u8,
  blue_source: u8,
) -> PioneerPreviewWaveformColumn {
  let front_height = blue_source;
  let back_height = front_height.max(red_source.max(green_source));

  if back_height == 0 {
    return PioneerPreviewWaveformColumn {
      back_height: 0,
      front_height: 0,
      back_color_r: 0,
      back_color_g: 0,
      back_color_b: 0,
      front_color_r: 0,
      front_color_g: 0,
      front_color_b: 0,
    };
  }

  let back_height_u16 = u16::from(back_height);
  let scale_color = |value: u8, max_level: u16| -> u8 {
    ((u16::from(value) * max_level) / back_height_u16).min(255) as u8
  };

  PioneerPreviewWaveformColumn {
    back_height,
    front_height,
    back_color_r: scale_color(red_source, 191),
    back_color_g: scale_color(green_source, 191),
    back_color_b: scale_color(blue_source, 191),
    front_color_r: scale_color(red_source, 255),
    front_color_g: scale_color(green_source, 255),
    front_color_b: scale_color(blue_source, 255),
  }
}

fn read_pioneer_preview_waveform_from_file(
  preview_path: &Path,
) -> StdResult<(String, Vec<PioneerPreviewWaveformColumn>, u32), String> {
  let sections = pioneer_anlz_raw::read_pioneer_anlz_sections(preview_path)
    .map_err(|error| format!("parse preview file failed: {error}"))?;
  let mut blue_columns: Option<Vec<PioneerPreviewWaveformColumn>> = None;

  for section in sections {
    if pioneer_anlz_raw::section_kind_eq(&section, b"PWV4") {
      if section.header_data.len() < 12 {
        continue;
      }
      let entry_size = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
      let len_entries = pioneer_anlz_raw::read_be_u32(&section.header_data[4..8])?;
      if entry_size != 6 {
        continue;
      }
      let required_size = usize::try_from(entry_size.saturating_mul(len_entries))
        .map_err(|_| "preview waveform size overflow".to_string())?;
      if section.content.len() < required_size {
        continue;
      }
      let mut columns = Vec::with_capacity(len_entries as usize);
      let mut max_height = 0u32;
      for chunk in section.content[..required_size].chunks_exact(6) {
        let column = build_pioneer_rgb_waveform_column(chunk[3], chunk[4], chunk[5]);
        max_height = max_height.max(u32::from(column.back_height));
        columns.push(column);
      }
      return Ok(("rgb".to_string(), columns, max_height));
    }
    if pioneer_anlz_raw::section_kind_eq(&section, b"PWAV") {
      if section.header_data.len() < 4 {
        continue;
      }
      let len_preview = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
      let preview_len =
        usize::try_from(len_preview).map_err(|_| "preview waveform length overflow".to_string())?;
      if section.content.len() < preview_len {
        continue;
      }
      if blue_columns.is_none() {
        let mut columns = Vec::with_capacity(preview_len);
        for entry in &section.content[..preview_len] {
          columns.push(build_pioneer_blue_waveform_column(
            entry >> 3,
            (entry & 0x07) >= 5,
          ));
        }
        blue_columns = Some(columns);
      }
      continue;
    }
    if pioneer_anlz_raw::section_kind_eq(&section, b"PWV2") {
      if section.header_data.len() < 4 {
        continue;
      }
      let len_preview = pioneer_anlz_raw::read_be_u32(&section.header_data[0..4])?;
      let preview_len =
        usize::try_from(len_preview).map_err(|_| "tiny preview length overflow".to_string())?;
      if section.content.len() < preview_len {
        continue;
      }
      if blue_columns.is_none() {
        let mut columns = Vec::with_capacity(preview_len);
        for entry in &section.content[..preview_len] {
          columns.push(build_pioneer_blue_waveform_column(
            (entry & 0x0F).saturating_mul(2),
            false,
          ));
        }
        blue_columns = Some(columns);
      }
      continue;
    }
  }

  if let Some(columns) = blue_columns {
    let max_height = columns
      .iter()
      .map(|column| u32::from(column.back_height))
      .max()
      .unwrap_or(0);
    return Ok(("blue".to_string(), columns, max_height));
  }

  Err("missing preview waveform section".to_string())
}

#[napi]
pub fn read_pioneer_preview_waveform(analyze_file_path: String) -> PioneerPreviewWaveformDump {
  fn build_empty(
    analyze_file_path: String,
    error: impl Into<String>,
  ) -> PioneerPreviewWaveformDump {
    PioneerPreviewWaveformDump {
      analyze_file_path,
      preview_file_path: String::new(),
      style: String::new(),
      column_count: 0,
      max_height: 0,
      columns: Vec::new(),
      error: Some(error.into()),
    }
  }

  let normalized_path = analyze_file_path.trim().to_string();
  if normalized_path.is_empty() {
    return build_empty(analyze_file_path, "analyze_file_path is empty");
  }

  let input_path = Path::new(&normalized_path);
  let candidates = build_pioneer_preview_waveform_candidates(input_path);
  let mut last_error: Option<String> = None;

  for candidate in candidates {
    if !candidate.exists() {
      continue;
    }

    match read_pioneer_preview_waveform_from_file(&candidate) {
      Ok((style, columns, max_height)) => {
        return PioneerPreviewWaveformDump {
          analyze_file_path: normalized_path,
          preview_file_path: candidate.to_string_lossy().to_string(),
          style,
          column_count: columns.len() as u32,
          max_height,
          columns,
          error: None,
        }
      }
      Err(error) => {
        last_error = Some(format!("{}: {error}", candidate.to_string_lossy()));
      }
    }
  }

  build_empty(
    normalized_path,
    last_error.unwrap_or_else(|| "preview waveform file not found".to_string()),
  )
}

#[napi]
pub fn read_pioneer_playlist_tracks(
  export_pdb_path: String,
  playlist_id: u32,
  max_rows: Option<u32>,
) -> PioneerPlaylistTrackDump {
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

  let normalized_path = export_pdb_path.trim().to_string();
  if normalized_path.is_empty() {
    return build_empty(export_pdb_path, playlist_id, "export_pdb_path is empty");
  }
  if playlist_id == 0 {
    return build_empty(normalized_path, playlist_id, "playlist_id is 0");
  }

  let pdb_path = Path::new(&normalized_path);
  if !pdb_path.exists() {
    return build_empty(normalized_path, playlist_id, "export.pdb not found");
  }

  let mut reader = match File::open(pdb_path) {
    Ok(file) => file,
    Err(error) => {
      return build_empty(
        normalized_path,
        playlist_id,
        format!("open export.pdb failed: {error}"),
      )
    }
  };

  let header = match RekordcrateHeader::read(&mut reader) {
    Ok(header) => header,
    Err(error) => {
      return build_empty(
        normalized_path,
        playlist_id,
        format!("parse export.pdb header failed: {error}"),
      )
    }
  };

  let mut playlist_name = String::new();
  let mut playlist_entries: Vec<(u32, u32)> = Vec::new();
  let mut artist_map: HashMap<u32, String> = HashMap::new();
  let mut album_map: HashMap<u32, String> = HashMap::new();
  let mut label_map: HashMap<u32, String> = HashMap::new();
  let mut genre_map: HashMap<u32, String> = HashMap::new();
  let mut key_map: HashMap<u32, String> = HashMap::new();
  let mut artwork_map: HashMap<u32, String> = HashMap::new();
  let mut track_map: HashMap<u32, ParsedTrackRow> = HashMap::new();

  for table in &header.tables {
    let pages = match header.read_pages(
      &mut reader,
      binrw::Endian::NATIVE,
      (&table.first_page, &table.last_page),
    ) {
      Ok(pages) => pages,
      Err(error) => {
        return build_empty(
          normalized_path,
          playlist_id,
          format!("read pages for {:?} failed: {error}", table.page_type),
        )
      }
    };

    for page in pages {
      for row_group in page.row_groups {
        for row in row_group.present_rows() {
          match row {
            RekordcrateRow::PlaylistTreeNode(node) => {
              if node.id.0 == playlist_id {
                playlist_name = node
                  .name
                  .clone()
                  .into_string()
                  .unwrap_or_else(|_| format!("{:?}", node.name));
              }
            }
            RekordcrateRow::PlaylistEntry(entry) => {
              let debug = format!("{entry:?}");
              if let Some((entry_playlist_id, track_id, entry_index)) =
                parse_playlist_entry_row(&debug)
              {
                if entry_playlist_id == playlist_id {
                  playlist_entries.push((entry_index, track_id));
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

  playlist_entries.sort_by(|left, right| left.0.cmp(&right.0));
  let limit = max_rows.unwrap_or(u32::MAX) as usize;
  let mut tracks = Vec::new();
  for (_entry_index, track_id) in playlist_entries.iter().take(limit) {
    if let Some(track) = track_map.get(track_id) {
      tracks.push(PioneerPlaylistTrackRecord {
        playlist_id,
        track_id: track.track_id,
        entry_index: *_entry_index,
        title: track.title.clone(),
        file_name: track.file_name.clone(),
        file_path: track.file_path.clone(),
        artist: artist_map
          .get(&track.artist_id)
          .cloned()
          .unwrap_or_default(),
        album: album_map.get(&track.album_id).cloned().unwrap_or_default(),
        label: label_map.get(&track.label_id).cloned().unwrap_or_default(),
        genre: genre_map.get(&track.genre_id).cloned().unwrap_or_default(),
        key_text: key_map.get(&track.key_id).cloned().unwrap_or_default(),
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
        artwork_path: artwork_map
          .get(&track.artwork_id)
          .cloned()
          .unwrap_or_default(),
      });
    }
  }

  PioneerPlaylistTrackDump {
    export_pdb_path: normalized_path,
    playlist_id,
    playlist_name,
    track_total: playlist_entries.len() as u32,
    tracks,
    error: None,
  }
}
