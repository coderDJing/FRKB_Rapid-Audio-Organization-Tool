extern crate napi_build;

fn main() {
  #[cfg(target_os = "windows")]
  {
    println!("cargo:rustc-link-search=native=./libs/win32-x64-msvc");
    use std::env;
    use std::fs;
    use std::path::PathBuf;

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let libs_dir = manifest_dir.join("libs/win32-x64-msvc");

    let required_dlls = ["chromaprint.dll"];

    for dll_name in required_dlls {
      let dll_src = libs_dir.join(dll_name);
      if dll_src.exists() {
        let dll_dst = manifest_dir.join(dll_name);
        if let Err(err) = fs::copy(&dll_src, &dll_dst) {
          println!("cargo:warning=复制 {} 失败: {}", dll_name, err);
        }
      } else {
        println!(
          "cargo:warning=未找到必要的 DLL {}，请检查 libs/win32-x64-msvc 下的依赖文件",
          dll_name
        );
      }
    }

    if let Ok(entries) = fs::read_dir(&libs_dir) {
      for entry in entries.flatten() {
        if let Ok(file_type) = entry.file_type() {
          if file_type.is_file() {
            let path = entry.path();
            if path
              .extension()
              .map(|ext| ext.eq_ignore_ascii_case("dll"))
              .unwrap_or(false)
            {
              let file_name = match path.file_name() {
                Some(name) => name,
                None => continue,
              };
              let dest_path = manifest_dir.join(file_name);
              if let Err(err) = fs::copy(&path, &dest_path) {
                println!(
                  "cargo:warning=复制 {} 失败: {}",
                  file_name.to_string_lossy(),
                  err
                );
              }
            }
          }
        }
      }
    }
  }

  #[cfg(target_os = "macos")]
  println!("cargo:rustc-link-search=native=./libs/darwin-universal");

  napi_build::setup();
}
