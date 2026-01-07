extern crate napi_build;

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
  let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
  let qm_root = manifest_dir.join("native/qm");

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

  napi_build::setup();

  let dts_path = manifest_dir.join("index.d.ts");
  let dts_template_path = manifest_dir.join("index.d.ts.template");
  println!("cargo:rerun-if-changed={}", dts_template_path.display());

  let needs_restore = fs::metadata(&dts_path)
    .map(|meta| meta.len() == 0)
    .unwrap_or(true);
  if needs_restore {
    if let Ok(template) = fs::read(&dts_template_path) {
      let _ = fs::write(&dts_path, template);
    }
  }
}
