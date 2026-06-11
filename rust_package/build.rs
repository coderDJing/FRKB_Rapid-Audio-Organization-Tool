extern crate napi_build;

use std::env;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

fn emit_rerun_if_changed_recursive(path: &Path) {
  if path.is_file() {
    println!("cargo:rerun-if-changed={}", path.display());
    return;
  }

  let Ok(entries) = fs::read_dir(path) else {
    return;
  };

  for entry in entries.flatten() {
    let path = entry.path();
    if path.is_dir() {
      emit_rerun_if_changed_recursive(&path);
    } else {
      println!("cargo:rerun-if-changed={}", path.display());
    }
  }
}

fn main() {
  let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
  let qm_root = manifest_dir.join("native/qm");
  println!(
    "cargo:rerun-if-changed={}",
    manifest_dir.join("build.rs").display()
  );
  emit_rerun_if_changed_recursive(&qm_root);

  let mut cpp_build = cc::Build::new();
  cpp_build
    .cpp(true)
    .include(&qm_root)
    .define("_USE_MATH_DEFINES", None)
    .define("kiss_fft_scalar", Some("double"))
    .file(qm_root.join("qm_key_wrapper.cpp"))
    .file(qm_root.join("dsp/keydetection/GetKeyMode.cpp"))
    .file(qm_root.join("dsp/chromagram/Chromagram.cpp"))
    .file(qm_root.join("dsp/chromagram/ConstantQ.cpp"))
    .file(qm_root.join("dsp/rateconversion/Decimator.cpp"))
    .file(qm_root.join("dsp/transforms/FFT.cpp"))
    .file(qm_root.join("maths/MathUtilities.cpp"))
    .file(qm_root.join("base/Pitch.cpp"))
    .flag_if_supported("-std=c++14")
    .flag_if_supported("/std:c++14")
    .flag_if_supported("/EHsc")
    .warnings(false)
    .compile("qm_keydetector");

  let mut c_build = cc::Build::new();
  c_build
    .include(&qm_root)
    .define("kiss_fft_scalar", Some("double"))
    .file(qm_root.join("ext/kissfft/kiss_fft.c"))
    .file(qm_root.join("ext/kissfft/tools/kiss_fftr.c"))
    .warnings(false)
    .compile("kissfft");

  let soundtouch_root = manifest_dir.join("native/soundtouch");
  let soundtouch_source_root = soundtouch_root.join("source");
  emit_rerun_if_changed_recursive(&soundtouch_root);
  let mut soundtouch_build = cc::Build::new();
  soundtouch_build
    .cpp(true)
    .include(soundtouch_root.join("include"))
    .include(&soundtouch_source_root)
    .define("SOUNDTOUCH_FLOAT_SAMPLES", Some("1"))
    .file(soundtouch_source_root.join("AAFilter.cpp"))
    .file(soundtouch_source_root.join("BPMDetect.cpp"))
    .file(soundtouch_source_root.join("FIFOSampleBuffer.cpp"))
    .file(soundtouch_source_root.join("FIRFilter.cpp"))
    .file(soundtouch_source_root.join("InterpolateCubic.cpp"))
    .file(soundtouch_source_root.join("InterpolateLinear.cpp"))
    .file(soundtouch_source_root.join("InterpolateShannon.cpp"))
    .file(soundtouch_source_root.join("PeakFinder.cpp"))
    .file(soundtouch_source_root.join("RateTransposer.cpp"))
    .file(soundtouch_source_root.join("SoundTouch.cpp"))
    .file(soundtouch_source_root.join("TDStretch.cpp"))
    .file(soundtouch_source_root.join("cpu_detect_x86.cpp"))
    .file(soundtouch_source_root.join("mmx_optimized.cpp"))
    .file(soundtouch_source_root.join("sse_optimized.cpp"))
    .file(soundtouch_root.join("frkb_soundtouch_wrapper.cpp"))
    .flag_if_supported("-std=c++14")
    .flag_if_supported("/std:c++14")
    .flag_if_supported("/EHsc")
    .warnings(false)
    .compile("frkb_soundtouch");

  // ===== Chromaprint =====
  let chromaprint_root = manifest_dir.join("native/chromaprint");
  let kissfft_cp_root = chromaprint_root.join("kissfft");
  emit_rerun_if_changed_recursive(&chromaprint_root);

  // Chromaprint core C++ sources
  let mut cp_build = cc::Build::new();
  cp_build
    .cpp(true)
    .include(&chromaprint_root)
    .include(chromaprint_root.join("include"))
    .include(&kissfft_cp_root)
    .define("CHROMAPRINT_NODLL", None)
    .define("USE_KISSFFT", Some("1"))
    .define("HAVE_ROUND", Some("1"))
    .define("HAVE_LRINTF", Some("1"))
    .define("_USE_MATH_DEFINES", None)
    .file(chromaprint_root.join("audio_processor.cpp"))
    .file(chromaprint_root.join("chroma.cpp"))
    .file(chromaprint_root.join("chroma_filter.cpp"))
    .file(chromaprint_root.join("chroma_resampler.cpp"))
    .file(chromaprint_root.join("chromaprint.cpp"))
    .file(chromaprint_root.join("fft.cpp"))
    .file(chromaprint_root.join("fft_lib_kissfft.cpp"))
    .file(chromaprint_root.join("fingerprint_calculator.cpp"))
    .file(chromaprint_root.join("fingerprint_compressor.cpp"))
    .file(chromaprint_root.join("fingerprint_decompressor.cpp"))
    .file(chromaprint_root.join("fingerprinter.cpp"))
    .file(chromaprint_root.join("fingerprinter_configuration.cpp"))
    .file(chromaprint_root.join("fingerprint_matcher.cpp"))
    .file(chromaprint_root.join("image_builder.cpp"))
    .file(chromaprint_root.join("silence_remover.cpp"))
    .file(chromaprint_root.join("simhash.cpp"))
    .file(chromaprint_root.join("spectrum.cpp"))
    .file(chromaprint_root.join("utils/base64.cpp"))
    .file(chromaprint_root.join("frkb_chromaprint_wrapper.cpp"))
    .flag_if_supported("-std=c++14")
    .flag_if_supported("/std:c++14")
    .flag_if_supported("/EHsc")
    .warnings(false)
    .compile("frkb_chromaprint");

  // Chromaprint's KissFFT (C, symbols renamed via kissfft_symbol_rename.h)
  let mut cp_kissfft_build = cc::Build::new();
  cp_kissfft_build
    .include(&chromaprint_root)
    .include(&kissfft_cp_root)
    .define("_USE_MATH_DEFINES", None)
    .file(kissfft_cp_root.join("kiss_fft.c"))
    .file(kissfft_cp_root.join("tools/kiss_fftr.c"))
    .warnings(false)
    .compile("chromaprint_kissfft");

  // ===== FFmpeg =====
  let ffmpeg_root = manifest_dir.join("native/ffmpeg");
  #[cfg(target_os = "windows")]
  let ffmpeg_platform = ffmpeg_root.join("win32-x64");
  #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
  let ffmpeg_platform = ffmpeg_root.join("darwin-arm64");
  #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
  let ffmpeg_platform = ffmpeg_root.join("darwin-x64");
  println!(
    "cargo:rerun-if-changed={}",
    ffmpeg_root.join("frkb_ffmpeg_decode_wrapper.c").display()
  );
  println!(
    "cargo:rerun-if-changed={}",
    ffmpeg_root.join("frkb_ffmpeg_decode_wrapper.h").display()
  );
  emit_rerun_if_changed_recursive(&ffmpeg_platform);

  let ffmpeg_lib_dir = ffmpeg_platform.join("lib");
  let ffmpeg_include_dir = ffmpeg_platform.join("include");
  println!(
    "cargo:rustc-link-search=native={}",
    ffmpeg_lib_dir.display()
  );

  // macOS: 静态链接 FFmpeg + 系统框架
  // Windows: 动态链接 FFmpeg DLL
  #[cfg(target_os = "macos")]
  {
    println!("cargo:rustc-link-lib=static=avcodec");
    println!("cargo:rustc-link-lib=static=avformat");
    println!("cargo:rustc-link-lib=static=avutil");
    println!("cargo:rustc-link-lib=static=swresample");
    // FFmpeg 依赖的 macOS 系统框架
    println!("cargo:rustc-link-lib=framework=CoreFoundation");
    println!("cargo:rustc-link-lib=framework=Security");
    println!("cargo:rustc-link-lib=framework=AudioToolbox");
    println!("cargo:rustc-link-lib=framework=VideoToolbox");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    println!("cargo:rustc-link-lib=framework=CoreVideo");
    println!("cargo:rustc-link-lib=iconv");
  }
  #[cfg(target_os = "windows")]
  {
    println!("cargo:rustc-link-lib=avcodec");
    println!("cargo:rustc-link-lib=avformat");
    println!("cargo:rustc-link-lib=avutil");
    println!("cargo:rustc-link-lib=swresample");
  }

  let chromaprint_include = chromaprint_root.join("include");
  let mut ffmpeg_wrapper_build = cc::Build::new();
  ffmpeg_wrapper_build
    .include(&ffmpeg_include_dir)
    .include(&chromaprint_include)
    .file("native/ffmpeg/frkb_ffmpeg_decode_wrapper.c")
    .define("_USE_MATH_DEFINES", None)
    .warnings(false)
    .compile("frkb_ffmpeg_decode");

  napi_build::setup();

  let dts_dir = manifest_dir.join("types");
  let dts_path = dts_dir.join("index.d.ts");
  let dts_template_path = manifest_dir.join("index.d.ts.template");
  println!("cargo:rerun-if-changed={}", dts_template_path.display());

  if let Ok(template) = fs::read(&dts_template_path) {
    let _ = fs::create_dir_all(&dts_dir);
    let _ = fs::write(&dts_path, template);
  }
}
