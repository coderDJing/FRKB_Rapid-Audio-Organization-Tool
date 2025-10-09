//! 音频文件处理模块
//! 仅提供基于解码后 PCM 的内容哈希（SHA256）

// 启用所有 clippy lint 检查
#![deny(clippy::all)]

// ===== 导入依赖 =====
// 基础功能
// use std::cmp::{max, min}; // 声纹比对已移除
use std::fs::File;
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

// 哈希
use hex;
use ring::digest::{Context, SHA256};
use bytemuck::cast_slice;

// 常量（已不再需要文件级哈希缓冲区）

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

// compare_fingerprints 已移除

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
  // 已精简：直接基于 PCM 内容计算哈希（不做文件级哈希，避免重复 IO）

  let file = match File::open(path) {
    Ok(f) => f,
    Err(_) => return AudioFileResult::error(path, "打开文件失败"),
  };

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

  let probed = match get_probe().format(&hint, media_stream, &format_opts, &metadata_opts) {
    Ok(probed) => probed,
    Err(_) => return AudioFileResult::error(path, "探测音频格式失败"),
  };

  if let Err(err) = extract_audio_features(probed.format, &mut result) {
    result.error = Some(err.to_string());
  }

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

  let channel_map = codec_params
    .channels
    .ok_or_else(|| napi::Error::from_reason("缺少声道信息"))?;
  let sample_rate = codec_params
    .sample_rate
    .ok_or_else(|| napi::Error::from_reason("缺少采样率信息"))?;

  // 已精简：不再导出 duration/quality_label

  let mut decoder = build_decoder(&codec_params)?;
  // 声纹路径已移除

  // 预留初始缓冲，减少第一次扩容开销（按 4096 帧起步）
  let mut sample_buffer = SampleBuffer::<i16>::new(4096, SignalSpec::new(sample_rate, channel_map));

  let mut _total_frames: u64 = 0;
  // 基于解码后的 PCM 样本计算内容哈希
  let mut pcm_hasher = Context::new(&SHA256);

  while let Some(packet) = next_packet(&mut format, track_id) {
    match decoder.decode(&packet) {
      Ok(audio_buf) => {
        let frame_count = audio_buf.frames();
        if sample_buffer.capacity() < frame_count {
          // 使用下一幂次作为新容量，降低频繁扩容
          let new_cap_frames = (frame_count.next_power_of_two() as u64).max(frame_count as u64);
          sample_buffer = SampleBuffer::new(new_cap_frames, *audio_buf.spec());
        }
        sample_buffer.copy_interleaved_ref(audio_buf);
        // 声纹计算已移除

        // 将解码后的 i16 PCM 样本（交错）追加到哈希器
        let samples_i16: &[i16] = sample_buffer.samples();
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
