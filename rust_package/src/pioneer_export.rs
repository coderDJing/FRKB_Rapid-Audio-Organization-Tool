use std::collections::HashMap;
use std::fs::File;
use std::path::Path;

use binrw::BinRead;
use rekordcrate::pdb::{
  Header as RekordcrateHeader, PlaylistTreeNode, PlaylistTreeNodeId, Row as RekordcrateRow,
};

#[path = "pioneer_export_anlz.rs"]
mod pioneer_export_anlz;
pub use pioneer_export_anlz::{
  read_pioneer_beat_grid, read_pioneer_detail_waveform, read_pioneer_preview_waveform,
};

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

/// Pioneer Rekordbox 网格单拍（PQTZ，时间为 Rekordbox timeline 毫秒）
#[napi(object)]
pub struct PioneerBeatGridEntry {
  pub beat_number: u8,
  pub bpm: f64,
  pub time_ms: f64,
}

/// Pioneer Rekordbox 完整网格读取结果
#[napi(object)]
pub struct PioneerBeatGridDump {
  pub analyze_file_path: String,
  pub grid_file_path: String,
  pub entries: Vec<PioneerBeatGridEntry>,
  pub error: Option<String>,
}

/// Pioneer 细节波形单列（Rekordbox ANLZ 的 PWV3/PWV5/PWV6/PWV7）
#[napi(object)]
pub struct PioneerDetailWaveformColumn {
  pub height: u8,
  pub color_r: u8,
  pub color_g: u8,
  pub color_b: u8,
  pub band_low: Option<u8>,
  pub band_mid: Option<u8>,
  pub band_high: Option<u8>,
}

/// Pioneer 细节波形读取结果
#[napi(object)]
pub struct PioneerDetailWaveformDump {
  pub analyze_file_path: String,
  pub detail_file_path: String,
  pub style: String,
  /// 原始 ANLZ 细节列的时间频率（Hz）。PWV6 概览没有固定时间频率。
  pub detail_rate: Option<f64>,
  pub column_count: u32,
  pub columns: Vec<PioneerDetailWaveformColumn>,
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

#[path = "pioneer_export_playlist_entries.rs"]
mod pioneer_export_playlist_entries;
#[path = "pioneer_export_tracks.rs"]
mod pioneer_export_tracks;
pub use pioneer_export_tracks::read_pioneer_playlist_tracks;
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
