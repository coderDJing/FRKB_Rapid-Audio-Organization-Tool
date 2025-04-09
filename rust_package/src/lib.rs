//! 音频文件处理模块
//! 提供音频文件解码和计算 SHA256 哈希值的功能

// 启用所有 clippy lint 检查
#![deny(clippy::all)]

// ===== 导入依赖 =====
// 基础功能
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
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
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{Limit, MetadataOptions};
use symphonia::core::probe::Hint;
use symphonia::default::get_probe;

// 哈希计算
use hex;
use ring::digest::{Context, SHA256};

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
  pub sha256_hash: String,
  pub file_path: String,
}

/// 异步任务结构体
pub struct AudioProcessTask {
  file_paths: Vec<String>,
  callback: Option<ThreadsafeFunction<ProcessProgress>>,
}

// ===== 公共 API =====

/// 计算音频文件的 SHA256 哈希值
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

  // 错误结果生成器
  let error_result = || AudioFileResult {
    sha256_hash: "error".to_string(),
    file_path: path.to_string_lossy().to_string(),
  };

  // 打开文件
  let mut file = match File::open(path) {
    Ok(f) => f,
    Err(_) => return error_result(),
  };

  // 探测音频格式
  let probe_file = match File::open(path) {
    Ok(f) => f,
    Err(_) => return error_result(),
  };

  let hint = Hint::new();
  let probe_result = get_probe().format(
    &hint,
    MediaSourceStream::new(Box::new(probe_file), Default::default()),
    &FormatOptions::default(),
    &MetadataOptions {
      limit_metadata_bytes: Limit::None,
      limit_visual_bytes: Limit::None,
      ..Default::default()
    },
  );

  let format_reader = match probe_result {
    Ok(probed) => probed.format,
    Err(_) => return error_result(),
  };

  // 定位到音频数据起始位置
  let start_pos = format_reader.into_inner().stream_position().unwrap_or(0);
  file.seek(SeekFrom::Start(start_pos)).unwrap_or(0);

  // 计算音频数据的哈希值
  let mut context = Context::new(&SHA256);
  const BUFFER_SIZE: usize = 1024 * 1024; // 1MB 缓冲区
  let mut buffer = vec![0u8; BUFFER_SIZE];

  while let Ok(n) = file.read(&mut buffer) {
    if n == 0 {
      break;
    }
    context.update(&buffer[..n]);
  }

  let hash = hex::encode(context.finish());

  AudioFileResult {
    sha256_hash: hash,
    file_path: path.to_string_lossy().to_string(),
  }
}
