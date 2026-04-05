//! 音频文件处理模块
//! 仅提供基于解码后 PCM 的内容哈希（SHA256）

// 启用所有 clippy lint 检查
#![deny(clippy::all)]

// ===== 导入依赖 =====
// 基础功能
// use std::cmp::{max, min}; // 声纹比对已移除
use std::borrow::Cow;
use std::collections::HashMap;
use std::convert::TryInto;
use std::fs::File;
use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::result::Result as StdResult;
use std::sync::Arc;

// 并行处理
use num_cpus;
use parking_lot::Mutex;
use rayon::prelude::*;

// Node.js 绑定
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

// 音频处理
use binrw::BinRead;
use symphonia::core::audio::{AudioBufferRef, SampleBuffer, Signal, SignalSpec};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, Track};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{Limit, MetadataOptions};
use symphonia::core::probe::Hint;
use symphonia::default::get_probe;

// 哈希
use bytemuck::{cast_slice, try_cast_slice};
use hex;
use ring::digest::{Context, SHA256};

// 常量（已不再需要文件级哈希缓冲区）

// 启用 napi 宏
#[macro_use]
extern crate napi_derive;

mod analysis_utils;
mod horizontal_browse_transport;
mod mixxx_waveform;
mod qm_bpm;
mod qm_key;

use crate::analysis_utils::{calc_frames_to_process, to_stereo, K_ANALYSIS_FRAMES_PER_CHUNK};
pub use crate::horizontal_browse_transport::*;
use crate::mixxx_waveform::MixxxWaveformData;
use rekordcrate::anlz::{Content as RekordcrateAnlzContent, ANLZ};
use rekordcrate::pdb::{
  Header as RekordcrateHeader, PlaylistTreeNode, PlaylistTreeNodeId, Row as RekordcrateRow,
};

// ===== 类型定义 =====

/// 进度信息结构体
#[napi(object)]
pub struct ProcessProgress {
  pub processed: i32,
  pub total: i32,
}

// 声纹比对类型已移除

/// 音频文件处理结果
#[napi(object)]
#[derive(Debug)]
pub struct AudioFileResult {
  /// 整个文件的 SHA256（当前为标准化 PCM 内容哈希），用于去重
  pub sha256_hash: String,
  /// 原始文件路径
  pub file_path: String,
  /// 错误描述（当分析失败时）
  pub error: Option<String>,
}

/// 音频解码结果
#[napi(object)]
pub struct DecodeAudioResult {
  /// PCM 数据（Buffer，内部为 f32 小端序，需在 JS 侧转为 Float32Array）
  pub pcm_data: Buffer,
  /// 采样率
  pub sample_rate: u32,
  /// 声道数
  pub channels: u8,
  /// 总帧数
  pub total_frames: f64,
  /// 解码后端（symphonia / ffmpeg / ffmpeg-fallback）
  pub decoder_backend: Option<String>,
  /// 错误描述（当解码失败时）
  pub error: Option<String>,
}

/// 调性分析结果
#[napi(object)]
pub struct KeyAnalysisResult {
  /// ID3v2 ASCII key 文本
  pub key_text: String,
  /// 错误描述（当分析失败时）
  pub error: Option<String>,
}

/// 调性+BPM分析结果
#[napi(object)]
pub struct KeyBpmAnalysisResult {
  /// ID3v2 ASCII key 文本
  pub key_text: String,
  /// BPM 值
  pub bpm: f64,
  /// 首拍偏移（毫秒）
  pub first_beat_ms: f64,
  /// 调性分析错误描述
  pub key_error: Option<String>,
  /// BPM 分析错误描述
  pub bpm_error: Option<String>,
}

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

impl AudioFileResult {
  fn error(path: &Path, err: &str) -> Self {
    AudioFileResult {
      sha256_hash: "error".to_string(),
      file_path: path.to_string_lossy().to_string(),
      error: Some(err.to_string()),
    }
  }

  fn with_path(path: &Path) -> Self {
    AudioFileResult {
      sha256_hash: String::new(),
      file_path: path.to_string_lossy().to_string(),
      error: None,
    }
  }
}

/// 异步任务结构体
pub struct AudioProcessTask {
  file_paths: Vec<String>,
  callback: Option<ThreadsafeFunction<ProcessProgress>>,
}

// ===== 公共 API =====

/// 计算音频文件的 SHA256 哈希值，并生成声纹与质量标签
///
/// # 参数
/// * `file_paths` - 音频文件路径数组
///
/// # 返回值
/// * 包含每个文件哈希值和路径的结果数组
#[napi]
pub fn calculate_audio_hashes(file_paths: Vec<String>) -> Vec<AudioFileResult> {
  // 并行处理所有文件
  file_paths
    .par_iter()
    .map(|path| calculate_audio_hash_for_file(path))
    .collect::<Vec<AudioFileResult>>()
}

/// 带进度回调的异步音频处理
#[napi]
pub async fn calculate_audio_hashes_with_progress(
  file_paths: Vec<String>,
  callback: Option<ThreadsafeFunction<ProcessProgress>>,
) -> napi::Result<Vec<AudioFileResult>> {
  let mut task = AudioProcessTask {
    file_paths,
    callback,
  };
  task.compute()
}

/// 计算整文件 SHA256（不解码，速度快；与 PCM 内容哈希互不兼容）
#[napi]
pub fn calculate_file_hashes(file_paths: Vec<String>) -> Vec<AudioFileResult> {
  file_paths
    .par_iter()
    .map(|path| calculate_file_hash_for_file(path))
    .collect::<Vec<AudioFileResult>>()
}

/// 计算整文件 SHA256（带进度）
#[napi]
pub async fn calculate_file_hashes_with_progress(
  file_paths: Vec<String>,
  callback: Option<ThreadsafeFunction<ProcessProgress>>,
) -> napi::Result<Vec<AudioFileResult>> {
  let total = file_paths.len() as i32;
  let results = Arc::new(Mutex::new(Vec::with_capacity(file_paths.len())));
  let processed = Arc::new(std::sync::atomic::AtomicI32::new(0));

  // 计算分块大小（与音频版本保持一致的策略）
  let chunk_size = {
    let cpu_count = num_cpus::get();
    let ideal_chunks = (file_paths.len() / 10).max(1);
    (file_paths.len() / ideal_chunks.min(cpu_count * 2)).max(1)
  };

  if let Some(callback) = callback {
    let callback = callback.clone();
    rayon::scope(|s| {
      for chunk in file_paths.chunks(chunk_size) {
        let results = Arc::clone(&results);
        let callback = callback.clone();
        let processed = Arc::clone(&processed);
        s.spawn(move |_| {
          let mut local_results = Vec::with_capacity(chunk.len());
          for path in chunk {
            let result = calculate_file_hash_for_file(path);
            let current = processed.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let progress = ProcessProgress {
              processed: current,
              total,
            };
            callback.call(Ok(progress), ThreadsafeFunctionCallMode::Blocking);
            local_results.push(result);
          }
          results.lock().extend(local_results);
        });
      }
    });
  } else {
    // 无回调时直接并行处理
    file_paths.par_iter().for_each(|path| {
      let result = calculate_file_hash_for_file(path);
      results.lock().push(result);
    });
  }

  Ok(Arc::try_unwrap(results).unwrap().into_inner())
}

// compare_fingerprints 已移除

/// 解码音频文件为 PCM Float32Array
///
/// # 参数
/// * `file_path` - 音频文件路径
///
/// # 返回值
/// * 包含 PCM 数据和元数据的解码结果
#[napi]
pub fn decode_audio_file(file_path: String) -> DecodeAudioResult {
  let path = Path::new(&file_path);
  let ext = path
    .extension()
    .and_then(|s| s.to_str())
    .map(|s| s.to_ascii_lowercase())
    .unwrap_or_default();

  // 已知仅 FFmpeg 覆盖较好的格式：避免多此一举的探测/失败再回退
  // 仍保留兜底回退用于异常情况（伪装扩展名/损坏文件等）
  let ffmpeg_only_exts = [
    "wma", "ac3", "dts", "mka", "webm", "ape", "tak", "tta",
    "wv",
    // 其他非常见格式如 voc/au/amr/gsm/ra/spx/mp2/mp1/mpc/shn/thd/dtshd 如后续加入设置也会被 FFmpeg 覆盖
  ];

  if ffmpeg_only_exts.contains(&ext.as_str()) {
    return match decode_with_ffmpeg(path) {
      Ok(mut result) => {
        result.decoder_backend = Some("ffmpeg".to_string());
        result
      }
      Err(ffmpeg_err) => DecodeAudioResult {
        pcm_data: Buffer::from(vec![]),
        sample_rate: 0,
        channels: 0,
        total_frames: 0.0,
        decoder_backend: Some("ffmpeg".to_string()),
        error: Some(format!("FFmpeg 解码失败: {}", ffmpeg_err)),
      },
    };
  }

  // 其他情况优先走 Symphonia，失败再兜底 FFmpeg
  match decode_with_symphonia(path) {
    Ok(mut result) => {
      result.decoder_backend = Some("symphonia".to_string());
      result
    }
    Err(symphonia_err) => match decode_with_ffmpeg(path) {
      Ok(mut result) => {
        result.decoder_backend = Some("ffmpeg-fallback".to_string());
        result
      }
      Err(ffmpeg_err) => DecodeAudioResult {
        pcm_data: Buffer::from(vec![]),
        sample_rate: 0,
        channels: 0,
        total_frames: 0.0,
        decoder_backend: None,
        error: Some(format!(
          "Symphonia 解码失败: {}; FFmpeg 解码失败: {}",
          symphonia_err, ffmpeg_err
        )),
      },
    },
  }
}

/// 基于 PCM 计算 Mixxx RGB 波形
#[napi]
pub fn compute_mixxx_waveform(
  pcm_data: Buffer,
  sample_rate: u32,
  channels: u8,
) -> napi::Result<MixxxWaveformData> {
  mixxx_waveform::compute_mixxx_waveform(pcm_data, sample_rate, channels)
}

/// 基于 PCM 计算 Mixxx RGB 波形（指定可视采样率）
#[napi]
pub fn compute_mixxx_waveform_with_rate(
  pcm_data: Buffer,
  sample_rate: u32,
  channels: u8,
  target_visual_rate: f64,
) -> napi::Result<MixxxWaveformData> {
  mixxx_waveform::compute_mixxx_waveform_with_rate(
    pcm_data,
    sample_rate,
    channels,
    target_visual_rate,
  )
}

/// 基于 PCM 计算调性（Mixxx Queen Mary）
#[napi]
pub fn analyze_key_from_pcm(
  pcm_data: Buffer,
  sample_rate: u32,
  channels: u8,
  fast_analysis: bool,
) -> KeyAnalysisResult {
  let pcm_bytes = pcm_data.as_ref();
  let pcm_f32 = match try_cast_slice::<u8, f32>(pcm_bytes) {
    Ok(slice) => Cow::Borrowed(slice),
    Err(_) => {
      if pcm_bytes.len() % 4 != 0 {
        return KeyAnalysisResult {
          key_text: "o".to_string(),
          error: Some("PCM buffer length is not aligned".to_string()),
        };
      }
      let mut out = Vec::with_capacity(pcm_bytes.len() / 4);
      for chunk in pcm_bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes(chunk.try_into().unwrap()));
      }
      Cow::Owned(out)
    }
  };

  match qm_key::analyze_key_id_from_pcm(pcm_f32.as_ref(), sample_rate, channels, fast_analysis) {
    Ok(key_id) => KeyAnalysisResult {
      key_text: key_id_to_id3_text(key_id),
      error: None,
    },
    Err(error) => KeyAnalysisResult {
      key_text: "o".to_string(),
      error: Some(error),
    },
  }
}

/// 基于 PCM 同时计算调性与 BPM（Mixxx Queen Mary）
///
/// # 参数
/// * `pcm_data` - 交错 PCM Buffer (f32 小端序)
/// * `sample_rate` - 采样率
/// * `channels` - 声道数
/// * `fast_analysis` - 是否启用 fast analysis
#[napi]
pub fn analyze_key_and_bpm_from_pcm(
  pcm_data: Buffer,
  sample_rate: u32,
  channels: u8,
  fast_analysis: bool,
) -> KeyBpmAnalysisResult {
  let mut key_text = "o".to_string();
  let mut bpm = 0.0;
  let mut first_beat_ms = 0.0;
  let mut key_error: Option<String> = None;
  let mut bpm_error: Option<String> = None;

  let pcm_bytes = pcm_data.as_ref();
  let pcm_f32 = match try_cast_slice::<u8, f32>(pcm_bytes) {
    Ok(slice) => Cow::Borrowed(slice),
    Err(_) => {
      if pcm_bytes.len() % 4 != 0 {
        let msg = "PCM buffer length is not aligned".to_string();
        return KeyBpmAnalysisResult {
          key_text,
          bpm,
          first_beat_ms,
          key_error: Some(msg.clone()),
          bpm_error: Some(msg),
        };
      }
      let mut out = Vec::with_capacity(pcm_bytes.len() / 4);
      for chunk in pcm_bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes(chunk.try_into().unwrap()));
      }
      Cow::Owned(out)
    }
  };

  if sample_rate == 0 {
    let msg = "sample_rate is 0".to_string();
    return KeyBpmAnalysisResult {
      key_text,
      bpm,
      first_beat_ms,
      key_error: Some(msg.clone()),
      bpm_error: Some(msg),
    };
  }
  if channels == 0 {
    let msg = "channels is 0".to_string();
    return KeyBpmAnalysisResult {
      key_text,
      bpm,
      first_beat_ms,
      key_error: Some(msg.clone()),
      bpm_error: Some(msg),
    };
  }

  let channels_usize = channels as usize;
  if pcm_f32.is_empty() {
    let msg = "pcm_data is empty".to_string();
    return KeyBpmAnalysisResult {
      key_text,
      bpm,
      first_beat_ms,
      key_error: Some(msg.clone()),
      bpm_error: Some(msg),
    };
  }

  let total_frames = pcm_f32.len() / channels_usize;
  if total_frames == 0 {
    let msg = "pcm_data has no frames".to_string();
    return KeyBpmAnalysisResult {
      key_text,
      bpm,
      first_beat_ms,
      key_error: Some(msg.clone()),
      bpm_error: Some(msg),
    };
  }

  let frames_to_process = calc_frames_to_process(total_frames, sample_rate, fast_analysis);
  if frames_to_process == 0 {
    let msg = "frames_to_process is 0".to_string();
    return KeyBpmAnalysisResult {
      key_text,
      bpm,
      first_beat_ms,
      key_error: Some(msg.clone()),
      bpm_error: Some(msg),
    };
  }

  let needed_samples = frames_to_process * channels_usize;
  let pcm_slice = &pcm_f32[..needed_samples];
  let stereo = to_stereo(pcm_slice, channels_usize, frames_to_process);
  let stereo_samples = stereo.as_ref();

  let mut key_detector = match qm_key::KeyDetector::new(sample_rate) {
    Ok(detector) => Some(detector),
    Err(error) => {
      key_error = Some(error);
      None
    }
  };
  let mut bpm_detector = match qm_bpm::BpmDetector::new(sample_rate) {
    Ok(detector) => Some(detector),
    Err(error) => {
      bpm_error = Some(error);
      None
    }
  };

  let mut offset_frames = 0usize;
  while offset_frames < frames_to_process {
    let chunk_frames = std::cmp::min(
      K_ANALYSIS_FRAMES_PER_CHUNK,
      frames_to_process - offset_frames,
    );
    let start = offset_frames * 2;
    let end = start + chunk_frames * 2;
    if let Some(detector) = key_detector.as_mut() {
      if let Err(error) = detector.process(&stereo_samples[start..end], chunk_frames, 2) {
        key_error = Some(error);
        key_detector = None;
      }
    }
    if let Some(detector) = bpm_detector.as_mut() {
      if let Err(error) = detector.process(&stereo_samples[start..end], chunk_frames, 2) {
        bpm_error = Some(error);
        bpm_detector = None;
      }
    }
    offset_frames += chunk_frames;
  }

  if let Some(detector) = key_detector.as_mut() {
    match detector.finalize() {
      Ok(key_id) => {
        key_text = key_id_to_id3_text(key_id);
      }
      Err(error) => {
        key_error = Some(error);
      }
    }
  }

  if let Some(detector) = bpm_detector.as_mut() {
    match detector.finalize() {
      Ok(result) => {
        if result.bpm > 0.0 && result.bpm.is_finite() {
          bpm = result.bpm;
        } else {
          bpm_error = Some("bpm not detected".to_string());
        }
        if let Some(first_beat_frame) = result.first_beat_frame {
          let first_beat_ms_candidate = first_beat_frame * 1000.0 / sample_rate as f64;
          if first_beat_ms_candidate.is_finite() && first_beat_ms_candidate >= 0.0 {
            first_beat_ms = first_beat_ms_candidate;
          }
        }
      }
      Err(error) => {
        bpm_error = Some(error);
      }
    }
  }

  KeyBpmAnalysisResult {
    key_text,
    bpm,
    first_beat_ms,
    key_error,
    bpm_error,
  }
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
  let mut seen = std::collections::HashSet::new();
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
  let mut reader =
    File::open(preview_path).map_err(|error| format!("open preview file failed: {error}"))?;
  let anlz =
    ANLZ::read(&mut reader).map_err(|error| format!("parse preview file failed: {error}"))?;

  let mut blue_columns: Option<Vec<PioneerPreviewWaveformColumn>> = None;

  for section in anlz.sections {
    match section.content {
      RekordcrateAnlzContent::WaveformColorPreview(preview) => {
        let mut columns = Vec::with_capacity(preview.data.len());
        let mut max_height = 0u32;
        for entry in preview.data {
          let column = build_pioneer_rgb_waveform_column(
            entry.energy_bottom_third_freq,
            entry.energy_mid_third_freq,
            entry.energy_top_third_freq,
          );
          max_height = max_height.max(u32::from(column.back_height));
          columns.push(column);
        }
        return Ok(("rgb".to_string(), columns, max_height));
      }
      RekordcrateAnlzContent::WaveformPreview(preview) => {
        if blue_columns.is_none() {
          let mut columns = Vec::with_capacity(preview.data.len());
          for entry in preview.data {
            columns.push(build_pioneer_blue_waveform_column(
              entry.height(),
              entry.whiteness() >= 5,
            ));
          }
          blue_columns = Some(columns);
        }
      }
      RekordcrateAnlzContent::TinyWaveformPreview(preview) => {
        if blue_columns.is_none() {
          let mut columns = Vec::with_capacity(preview.data.len());
          for entry in preview.data {
            columns.push(build_pioneer_blue_waveform_column(
              entry.height().saturating_mul(2),
              false,
            ));
          }
          blue_columns = Some(columns);
        }
      }
      _ => {}
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

fn key_id_to_id3_text(key_id: i32) -> String {
  const ID3_KEYS: [&str; 25] = [
    "o", // INVALID
    "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B", "Cm", "C#m", "Dm", "Ebm",
    "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm",
  ];
  let index = if key_id >= 0 && key_id < ID3_KEYS.len() as i32 {
    key_id as usize
  } else {
    0
  };
  ID3_KEYS[index].to_string()
}

/// 解码音频为 PCM Float32Array
fn decode_audio_to_pcm(mut format: Box<dyn FormatReader>) -> napi::Result<DecodeAudioResult> {
  let (track_id, codec_params) = {
    let track = find_decode_track(&mut format)?;
    (track.id, track.codec_params.clone())
  };

  let channels = codec_params
    .channels
    .ok_or_else(|| napi::Error::from_reason("缺少声道信息"))?
    .count() as u8;
  let sample_rate = codec_params
    .sample_rate
    .ok_or_else(|| napi::Error::from_reason("缺少采样率信息"))?;

  let mut decoder = build_decoder(&codec_params)?;

  // 收集所有 PCM 样本（交错格式）
  let mut all_samples: Vec<f32> = Vec::new();
  let mut total_frames: u64 = 0;

  while let Some(packet) = next_packet(&mut format, track_id) {
    match decoder.decode(&packet) {
      Ok(audio_buf) => {
        let frame_count = audio_buf.frames();
        total_frames += frame_count as u64;

        // 将音频缓冲区转换为 f32 并交错
        match audio_buf {
          AudioBufferRef::F32(buf) => {
            // 已经是 f32，手动交错
            for frame_idx in 0..frame_count {
              for ch in 0..channels as usize {
                all_samples.push(buf.chan(ch)[frame_idx]);
              }
            }
          }
          AudioBufferRef::S16(buf) => {
            // i16 转 f32 并交错
            for frame_idx in 0..frame_count {
              for ch in 0..channels as usize {
                all_samples.push(buf.chan(ch)[frame_idx] as f32 / 32768.0);
              }
            }
          }
          AudioBufferRef::S24(buf) => {
            // i24 转 f32 并交错
            for frame_idx in 0..frame_count {
              for ch in 0..channels as usize {
                let sample = buf.chan(ch)[frame_idx].inner();
                all_samples.push(sample as f32 / 8388608.0);
              }
            }
          }
          AudioBufferRef::S32(buf) => {
            // i32 转 f32 并交错
            for frame_idx in 0..frame_count {
              for ch in 0..channels as usize {
                all_samples.push(buf.chan(ch)[frame_idx] as f32 / 2147483648.0);
              }
            }
          }
          AudioBufferRef::U8(buf) => {
            // u8 转 f32 并交错
            for frame_idx in 0..frame_count {
              for ch in 0..channels as usize {
                all_samples.push((buf.chan(ch)[frame_idx] as f32 - 128.0) / 128.0);
              }
            }
          }
          _ => {
            return Err(napi::Error::from_reason("不支持的音频格式"));
          }
        }
      }
      Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::DecodeError(_)) => continue,
      Err(e) => {
        return Err(napi::Error::from_reason(format!("解码错误: {}", e)));
      }
    }
  }

  Ok(DecodeAudioResult {
    pcm_data: Buffer::from(cast_slice(&all_samples).to_vec()),
    sample_rate,
    channels,
    total_frames: total_frames as f64,
    decoder_backend: None,
    error: None,
  })
}

fn decode_with_symphonia(path: &Path) -> StdResult<DecodeAudioResult, String> {
  let file = File::open(path).map_err(|_| "打开文件失败".to_string())?;
  let media_stream = MediaSourceStream::new(Box::new(file), Default::default());
  let mut hint = Hint::new();
  if let Some(ext) = path.extension().and_then(|os| os.to_str()) {
    hint.with_extension(ext);
  }

  let format_opts = FormatOptions::default();
  let metadata_opts = MetadataOptions {
    limit_metadata_bytes: Limit::None,
    limit_visual_bytes: Limit::None,
    ..Default::default()
  };

  let probed = get_probe()
    .format(&hint, media_stream, &format_opts, &metadata_opts)
    .map_err(|e| format!("探测音频格式失败: {}", e))?;

  match catch_unwind(AssertUnwindSafe(|| decode_audio_to_pcm(probed.format))) {
    Ok(Ok(result)) => Ok(result),
    Ok(Err(err)) => Err(err.to_string()),
    Err(_) => Err("内部音频解码错误（panic）".to_string()),
  }
}

fn decode_with_ffmpeg(path: &Path) -> StdResult<DecodeAudioResult, String> {
  let ffmpeg_pcm = ffmpeg_decode_to_i16(path)?;
  if ffmpeg_pcm.channels == 0 {
    return Err("FFmpeg 返回的声道数无效".to_string());
  }

  let channels_u8 = if ffmpeg_pcm.channels > u8::MAX as u16 {
    return Err("声道数超过支持范围".to_string());
  } else {
    ffmpeg_pcm.channels as u8
  };

  let pcm_f32: Vec<f32> = ffmpeg_pcm
    .samples_i16
    .iter()
    .map(|sample| (*sample as f32) / 32768.0)
    .collect();

  Ok(DecodeAudioResult {
    pcm_data: Buffer::from(cast_slice(&pcm_f32).to_vec()),
    sample_rate: ffmpeg_pcm.sample_rate,
    channels: channels_u8,
    total_frames: ffmpeg_pcm.total_frames as f64,
    decoder_backend: None,
    error: None,
  })
}

struct FfmpegPcmData {
  samples_i16: Vec<i16>,
  sample_rate: u32,
  channels: u16,
  total_frames: u64,
}

fn ffmpeg_decode_to_i16(path: &Path) -> StdResult<FfmpegPcmData, String> {
  let ffmpeg_path = get_ffmpeg_path()?;
  let output = Command::new(ffmpeg_path)
    .arg("-v")
    .arg("error")
    .arg("-i")
    .arg(path)
    .arg("-f")
    .arg("wav")
    .arg("-acodec")
    .arg("pcm_s16le")
    .arg("pipe:1")
    .output()
    .map_err(|e| format!("调用 FFmpeg 失败: {}", e))?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr);
    return Err(format!("FFmpeg 解码失败: {}", stderr.trim()));
  }

  parse_wav_s16le(&output.stdout)
}

fn get_ffmpeg_path() -> StdResult<String, String> {
  match std::env::var("FRKB_FFMPEG_PATH") {
    Ok(path) if !path.is_empty() => Ok(path),
    _ => Err("未找到 FFmpeg 可执行文件路径（环境变量 FRKB_FFMPEG_PATH）".to_string()),
  }
}

fn parse_wav_s16le(bytes: &[u8]) -> StdResult<FfmpegPcmData, String> {
  if bytes.len() < 44 {
    return Err("FFmpeg 输出无效：数据长度不足".to_string());
  }

  if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
    return Err("FFmpeg 输出无效：不是 WAV 数据".to_string());
  }

  let mut offset = 12usize;
  let mut channels: Option<u16> = None;
  let mut sample_rate: Option<u32> = None;
  let mut bits_per_sample: Option<u16> = None;
  let mut data_offset: Option<usize> = None;
  let mut data_size: Option<usize> = None;

  while offset + 8 <= bytes.len() {
    let chunk_id = &bytes[offset..offset + 4];
    let chunk_size = u32::from_le_bytes(
      bytes[offset + 4..offset + 8]
        .try_into()
        .map_err(|_| "FFmpeg 输出无效：读取 chunk 大小失败")?,
    ) as usize;
    offset += 8;

    match chunk_id {
      b"fmt " => {
        if offset + chunk_size > bytes.len() || chunk_size < 16 {
          return Err("FFmpeg 输出无效：fmt chunk 长度错误".to_string());
        }
        channels = Some(u16::from_le_bytes([bytes[offset + 2], bytes[offset + 3]]));
        sample_rate = Some(u32::from_le_bytes([
          bytes[offset + 4],
          bytes[offset + 5],
          bytes[offset + 6],
          bytes[offset + 7],
        ]));
        bits_per_sample = Some(u16::from_le_bytes([bytes[offset + 14], bytes[offset + 15]]));
      }
      b"data" => {
        let available = bytes.len().saturating_sub(offset);
        let size = chunk_size.min(available);
        data_offset = Some(offset);
        data_size = Some(size);
        break;
      }
      _ => {}
    }

    offset = offset.saturating_add(chunk_size);
    if chunk_size % 2 == 1 {
      offset = offset.saturating_add(1);
    }
  }

  let channels = channels.ok_or_else(|| "FFmpeg 输出无效：缺少声道信息".to_string())?;
  let sample_rate = sample_rate.ok_or_else(|| "FFmpeg 输出无效：缺少采样率信息".to_string())?;
  let bits_per_sample =
    bits_per_sample.ok_or_else(|| "FFmpeg 输出无效：缺少位深信息".to_string())?;
  if bits_per_sample != 16 {
    return Err("FFmpeg 输出的位深不是 16bit PCM".to_string());
  }

  let data_offset = data_offset.ok_or_else(|| "FFmpeg 输出无效：缺少数据块".to_string())?;
  let data_size = data_size.ok_or_else(|| "FFmpeg 输出无效：数据块长度不足".to_string())?;
  if data_offset + data_size > bytes.len() {
    return Err("FFmpeg 输出无效：数据块越界".to_string());
  }

  let data = &bytes[data_offset..data_offset + data_size];
  let mut samples_i16 = Vec::with_capacity(data.len() / 2);
  for chunk in data.chunks_exact(2) {
    samples_i16.push(i16::from_le_bytes([chunk[0], chunk[1]]));
  }

  let total_samples = samples_i16.len() as u64;
  let total_frames = if channels == 0 {
    0
  } else {
    total_samples / channels as u64
  };

  Ok(FfmpegPcmData {
    samples_i16,
    sample_rate,
    channels,
    total_frames,
  })
}

// ===== 任务实现 =====

impl Task for AudioProcessTask {
  type Output = Vec<AudioFileResult>;
  type JsValue = Vec<AudioFileResult>;

  fn compute(&mut self) -> napi::Result<Self::Output> {
    let total = self.file_paths.len() as i32;
    let results = Arc::new(Mutex::new(Vec::with_capacity(self.file_paths.len())));
    let processed = Arc::new(std::sync::atomic::AtomicI32::new(0));

    // 计算最优分块大小
    let chunk_size = {
      let cpu_count = num_cpus::get();
      let ideal_chunks = (self.file_paths.len() / 10).max(1);
      (self.file_paths.len() / ideal_chunks.min(cpu_count * 2)).max(1)
    };

    if let Some(ref callback) = self.callback {
      let callback = callback.clone();
      // 使用自适应的工作窃取调度
      rayon::scope(|s| {
        for chunk in self.file_paths.chunks(chunk_size) {
          let results = Arc::clone(&results);
          let callback = callback.clone();
          let processed = Arc::clone(&processed);
          s.spawn(move |_| {
            let mut local_results = Vec::with_capacity(chunk.len());
            for path in chunk {
              let result = calculate_audio_hash_for_file(path);
              let current = processed.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;

              // 回调进度信息
              let progress = ProcessProgress {
                processed: current,
                total,
              };
              callback.call(Ok(progress), ThreadsafeFunctionCallMode::Blocking);

              local_results.push(result);
            }
            results.lock().extend(local_results);
          });
        }
      });
    } else {
      // 无回调时直接并行处理
      self.file_paths.par_iter().for_each(|path| {
        let result = calculate_audio_hash_for_file(path);
        results.lock().push(result);
      });
    }

    Ok(Arc::try_unwrap(results).unwrap().into_inner())
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
    Ok(output)
  }
}

// ===== 内部辅助函数 =====

/// 处理单个音频文件并计算 SHA256 哈希
fn calculate_audio_hash_for_file(path: &str) -> AudioFileResult {
  let path = Path::new(path);
  match calculate_hash_with_symphonia(path) {
    Ok(hash) => {
      let mut result = AudioFileResult::with_path(path);
      result.sha256_hash = hash;
      result
    }
    Err(symphonia_err) => match calculate_hash_with_ffmpeg(path) {
      Ok(hash) => {
        let mut result = AudioFileResult::with_path(path);
        result.sha256_hash = hash;
        result
      }
      Err(ffmpeg_err) => AudioFileResult::error(
        path,
        &format!(
          "Symphonia 解码失败: {}; FFmpeg 解码失败: {}",
          symphonia_err, ffmpeg_err
        ),
      ),
    },
  }
}

fn calculate_hash_with_symphonia(path: &Path) -> StdResult<String, String> {
  let file = File::open(path).map_err(|_| "打开文件失败".to_string())?;
  let media_stream = MediaSourceStream::new(Box::new(file), Default::default());
  let mut hint = Hint::new();
  if let Some(ext) = path.extension().and_then(|os| os.to_str()) {
    hint.with_extension(ext);
  }

  let format_opts = FormatOptions::default();
  let metadata_opts = MetadataOptions {
    limit_metadata_bytes: Limit::None,
    limit_visual_bytes: Limit::None,
    ..Default::default()
  };

  let probed = get_probe()
    .format(&hint, media_stream, &format_opts, &metadata_opts)
    .map_err(|e| format!("探测音频格式失败: {}", e))?;

  let mut temp_result = AudioFileResult::with_path(path);
  match catch_unwind(AssertUnwindSafe(|| {
    extract_audio_features(probed.format, &mut temp_result)
  })) {
    Ok(Ok(())) => {
      if temp_result.sha256_hash.is_empty() {
        Err("Symphonia 解码未生成哈希".to_string())
      } else {
        Ok(temp_result.sha256_hash)
      }
    }
    Ok(Err(err)) => Err(err.to_string()),
    Err(_) => Err("内部音频解码错误（panic）".to_string()),
  }
}

fn calculate_hash_with_ffmpeg(path: &Path) -> StdResult<String, String> {
  let ffmpeg_pcm = ffmpeg_decode_to_i16(path)?;
  let mut ctx = Context::new(&SHA256);
  ctx.update(cast_slice(&ffmpeg_pcm.samples_i16));
  Ok(hex::encode(ctx.finish()))
}

/// 单文件整文件 SHA256 计算
fn calculate_file_hash_for_file(path: &str) -> AudioFileResult {
  let p = Path::new(path);
  let mut result = AudioFileResult::with_path(p);
  let mut file = match std::fs::File::open(p) {
    Ok(f) => f,
    Err(_) => return AudioFileResult::error(p, "打开文件失败"),
  };
  let mut ctx = Context::new(&SHA256);
  let mut buf = vec![0u8; 1024 * 1024 * 2]; // 2MB buffer
  loop {
    match file.read(&mut buf) {
      Ok(0) => break,
      Ok(n) => ctx.update(&buf[..n]),
      Err(_) => return AudioFileResult::error(p, "读取文件失败"),
    }
  }
  result.sha256_hash = hex::encode(ctx.finish());
  result
}

// 文件级 SHA256 计算已移除（仅保留基于 PCM 的哈希）

fn extract_audio_features(
  mut format: Box<dyn FormatReader>,
  result: &mut AudioFileResult,
) -> napi::Result<()> {
  let (track_id, codec_params) = {
    let track = find_decode_track(&mut format)?;
    (track.id, track.codec_params.clone())
  };

  // 已精简：移除非必要的编码参数输出

  codec_params
    .channels
    .ok_or_else(|| napi::Error::from_reason("缺少声道信息"))?;
  codec_params
    .sample_rate
    .ok_or_else(|| napi::Error::from_reason("缺少采样率信息"))?;

  // 已精简：不再导出 duration/quality_label

  let mut decoder = build_decoder(&codec_params)?;
  // 声纹路径已移除

  // 延迟创建 SampleBuffer，确保与首个解码帧的 spec 严格一致
  let mut sample_buffer: Option<SampleBuffer<i16>> = None;
  let mut current_spec: Option<SignalSpec> = None;

  let mut _total_frames: u64 = 0;
  // 基于解码后的 PCM 样本计算内容哈希
  let mut pcm_hasher = Context::new(&SHA256);

  while let Some(packet) = next_packet(&mut format, track_id) {
    match decoder.decode(&packet) {
      Ok(audio_buf) => {
        let frame_count = audio_buf.frames();

        // 若尚未创建或 spec 变化/容量不足，则重建缓冲
        let want_spec = *audio_buf.spec();
        let cap_insufficient = sample_buffer
          .as_ref()
          .map(|b| b.capacity() < frame_count)
          .unwrap_or(true);
        let spec_changed = current_spec
          .map(|s| s.channels != want_spec.channels || s.rate != want_spec.rate)
          .unwrap_or(true);
        let need_recreate = cap_insufficient || spec_changed;

        if need_recreate {
          // 使用下一幂次容量，避免频繁扩容
          let required = frame_count.next_power_of_two().max(frame_count);
          sample_buffer = Some(SampleBuffer::new(required as u64, want_spec));
          current_spec = Some(want_spec);
        }

        let sbuf = sample_buffer.as_mut().unwrap();
        sbuf.copy_interleaved_ref(audio_buf);

        // 将解码后的 i16 PCM 样本（交错）追加到哈希器
        let samples_i16: &[i16] = sbuf.samples();
        pcm_hasher.update(cast_slice(samples_i16));

        _total_frames += frame_count as u64;
      }
      Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::DecodeError(_)) => continue,
      Err(_) => break,
    }
  }

  // 已精简：不再导出时长/位深

  // 声纹计算已移除

  // 基于 PCM 内容的哈希，实现“跳过元数据”的唯一值
  result.sha256_hash = hex::encode(pcm_hasher.finish());

  Ok(())
}

// 指纹相关帮助函数已移除

fn find_decode_track(format: &mut Box<dyn FormatReader>) -> napi::Result<&Track> {
  format
    .tracks()
    .iter()
    .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
    .ok_or_else(|| napi::Error::from_reason("未找到可解码音轨"))
}

fn build_decoder(
  codec_params: &symphonia::core::codecs::CodecParameters,
) -> napi::Result<Box<dyn symphonia::core::codecs::Decoder>> {
  let mut opts = DecoderOptions::default();
  // 性能优化：关闭额外校验（若编解码器支持）
  opts.verify = false;
  symphonia::default::get_codecs()
    .make(codec_params, &opts)
    .map_err(|_| napi::Error::from_reason("创建解码器失败"))
}

fn next_packet(
  format: &mut Box<dyn FormatReader>,
  track_id: u32,
) -> Option<symphonia::core::formats::Packet> {
  loop {
    let packet = match format.next_packet() {
      Ok(packet) => packet,
      Err(SymphoniaError::ResetRequired) => return None,
      Err(_) => return None,
    };

    if packet.track_id() != track_id {
      continue;
    }

    return Some(packet);
  }
}

// 已移除质量标签/码率估算逻辑
