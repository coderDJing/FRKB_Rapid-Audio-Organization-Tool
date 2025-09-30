//! 音频文件处理模块
//! 提供音频文件哈希、声纹计算与质量标签生成

// 启用所有 clippy lint 检查
#![deny(clippy::all)]

// ===== 导入依赖 =====
// 基础功能
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

// 并行处理
use num_cpus;
use parking_lot::Mutex;
use rayon::prelude::*;

// Node.js 绑定
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

// 音频处理
use symphonia::core::audio::{SampleBuffer, SignalSpec};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, Track};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{Limit, MetadataOptions};
use symphonia::core::probe::Hint;
use symphonia::default::get_probe;

// 声纹与哈希
use chromaprint::Chromaprint;
use hex;
use ring::digest::{Context, SHA256};

// 常量
const READ_BUFFER_BYTES: usize = 1024 * 1024; // 1MB 读取块，用于文件 SHA 计算

// 启用 napi 宏
#[macro_use]
extern crate napi_derive;

// ===== 类型定义 =====

/// 进度信息结构体
#[napi(object)]
pub struct ProcessProgress {
  pub processed: i32,
  pub total: i32,
}

/// 音频文件处理结果
#[napi(object)]
#[derive(Debug)]
pub struct AudioFileResult {
  /// 整个文件的 SHA256，用于二进制级去重
  pub sha256_hash: String,
  /// 原始文件路径
  pub file_path: String,
  /// 基于 Chromaprint 的声纹标识
  pub fingerprint: Option<String>,
  /// 将声纹再做 SHA256 摘要，便于快速比对
  pub fingerprint_hash: Option<String>,
  /// 文件扩展名（统一小写）
  pub format_ext: Option<String>,
  /// 根据编码参数生成的可读质量标签
  pub quality_label: Option<String>,
  /// 平均码率（单位 bps）
  pub bitrate: Option<u32>,
  /// 采样率（Hz）
  pub sample_rate: Option<u32>,
  /// 位深（bit）
  pub bit_depth: Option<u16>,
  /// 声道数量
  pub channels: Option<u16>,
  /// 音频时长（秒）
  pub duration_seconds: Option<f64>,
  /// 文件大小（字节）
  pub file_size: Option<f64>,
  /// 错误描述（当声纹或质量分析失败时）
  pub error: Option<String>,
}

impl AudioFileResult {
  fn error(path: &Path, err: &str) -> Self {
    AudioFileResult {
      sha256_hash: "error".to_string(),
      file_path: path.to_string_lossy().to_string(),
      fingerprint: None,
      fingerprint_hash: None,
      format_ext: None,
      quality_label: None,
      bitrate: None,
      sample_rate: None,
      bit_depth: None,
      channels: None,
      duration_seconds: None,
      file_size: None,
      error: Some(err.to_string()),
    }
  }

  fn with_path(path: &Path) -> Self {
    AudioFileResult {
      sha256_hash: String::new(),
      file_path: path.to_string_lossy().to_string(),
      fingerprint: None,
      fingerprint_hash: None,
      format_ext: None,
      quality_label: None,
      bitrate: None,
      sample_rate: None,
      bit_depth: None,
      channels: None,
      duration_seconds: None,
      file_size: None,
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

  let mut result = AudioFileResult::with_path(path);
  if let Ok(metadata) = path.metadata() {
    result.file_size = Some(metadata.len() as f64);
  }

  result.sha256_hash = compute_file_sha256(path);

  let file = match File::open(path) {
    Ok(f) => f,
    Err(_) => return AudioFileResult::error(path, "打开文件失败"),
  };

  let media_stream = MediaSourceStream::new(Box::new(file), Default::default());
  let mut hint = Hint::new();
  if let Some(ext) = path.extension().and_then(|os| os.to_str()) {
    hint.with_extension(ext);
    result.format_ext = Some(ext.to_lowercase());
  }

  let format_opts = FormatOptions::default();
  let metadata_opts = MetadataOptions {
    limit_metadata_bytes: Limit::None,
    limit_visual_bytes: Limit::None,
    ..Default::default()
  };

  let probed = match get_probe().format(&hint, media_stream, &format_opts, &metadata_opts) {
    Ok(probed) => probed,
    Err(_) => return AudioFileResult::error(path, "探测音频格式失败"),
  };

  if let Err(err) = extract_audio_features(probed.format, &mut result) {
    result.error = Some(err.to_string());
  }

  result
}

fn compute_file_sha256(path: &Path) -> String {
  let mut context = Context::new(&SHA256);
  let mut buffer = vec![0u8; READ_BUFFER_BYTES];

  if let Ok(mut file) = File::open(path) {
    while let Ok(n) = file.read(&mut buffer) {
      if n == 0 {
        break;
      }
      context.update(&buffer[..n]);
    }
  }

  hex::encode(context.finish())
}

fn extract_audio_features(
  mut format: Box<dyn FormatReader>,
  result: &mut AudioFileResult,
) -> napi::Result<()> {
  let (track_id, codec_params) = {
    let track = find_decode_track(&mut format)?;
    (track.id, track.codec_params.clone())
  };

  if let Some(channels) = codec_params.channels {
    result.channels = Some(channels.count() as u16);
  }
  result.sample_rate = codec_params.sample_rate;
  result.bit_depth = codec_params.bits_per_sample.map(|v| v as u16);

  result.bitrate = codec_params.bits_per_coded_sample;

  let channel_map = codec_params
    .channels
    .ok_or_else(|| napi::Error::from_reason("缺少声道信息"))?;
  let sample_rate = codec_params
    .sample_rate
    .ok_or_else(|| napi::Error::from_reason("缺少采样率信息"))?;

  if let Some(duration) = codec_params.n_frames {
    result.duration_seconds = Some(duration as f64 / sample_rate as f64);
  }

  if result.quality_label.is_none() {
    result.quality_label = Some(build_quality_label(result));
  }

  let mut decoder = build_decoder(&codec_params)?;
  let mut chroma = Chromaprint::new();
  if !chroma.start(sample_rate as i32, channel_map.count() as i32) {
    return Err(napi::Error::from_reason("声纹生成初始化失败"));
  }

  let mut sample_buffer = SampleBuffer::<i16>::new(0, SignalSpec::new(sample_rate, channel_map));

  let mut total_frames: u64 = 0;

  while let Some(packet) = next_packet(&mut format, track_id) {
    match decoder.decode(&packet) {
      Ok(audio_buf) => {
        let frame_count = audio_buf.frames();
        if sample_buffer.capacity() < frame_count {
          sample_buffer = SampleBuffer::new(frame_count as u64, *audio_buf.spec());
        }
        sample_buffer.copy_interleaved_ref(audio_buf);
        if !chroma.feed(sample_buffer.samples()) {
          return Err(napi::Error::from_reason("声纹生成失败"));
        }

        total_frames += frame_count as u64;
      }
      Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::DecodeError(_)) => continue,
      Err(_) => break,
    }
  }

  if result.duration_seconds.is_none() && total_frames > 0 {
    result.duration_seconds = Some(total_frames as f64 / sample_rate as f64);
  }

  if result.bit_depth.is_none() {
    result.bit_depth = Some(16);
  }

  if chroma.finish() {
    result.fingerprint = chroma.fingerprint();
    if let Some(fp) = &result.fingerprint {
      result.fingerprint_hash = Some(hash_fingerprint(fp));
    }
  }

  Ok(())
}

fn hash_fingerprint(fp: &str) -> String {
  let mut context = Context::new(&SHA256);
  context.update(fp.as_bytes());
  hex::encode(context.finish())
}

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
  symphonia::default::get_codecs()
    .make(codec_params, &DecoderOptions::default())
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

fn build_quality_label(result: &AudioFileResult) -> String {
  let mut parts: Vec<String> = Vec::new();
  if let Some(ext) = &result.format_ext {
    parts.push(ext.to_uppercase());
  }

  if let Some(bitrate) = result.bitrate.or_else(|| estimate_bitrate(result)) {
    parts.push(format!("{}kbps", bitrate / 1000));
  }
  if let Some(sample_rate) = result.sample_rate {
    parts.push(format!("{}Hz", sample_rate));
  }
  if let Some(bit_depth) = result.bit_depth {
    parts.push(format!("{}bit", bit_depth));
  }
  if let Some(channels) = result.channels {
    parts.push(match channels {
      1 => "单声道".to_string(),
      2 => "立体声".to_string(),
      _ => format!("{}声道", channels),
    });
  }
  if parts.is_empty() {
    "未知质量".to_string()
  } else {
    parts.join(" · ")
  }
}

fn estimate_bitrate(result: &AudioFileResult) -> Option<u32> {
  match (result.file_size, result.duration_seconds) {
    (Some(size), Some(duration)) if duration > 0.0 => {
      let bits = size as f64 * 8.0;
      Some((bits / duration) as u32)
    }
    _ => None,
  }
}
