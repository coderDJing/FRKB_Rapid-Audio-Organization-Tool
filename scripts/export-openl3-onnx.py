import argparse
import hashlib
import json
from pathlib import Path


def sha256_file(file_path: Path) -> str:
  h = hashlib.sha256()
  with file_path.open('rb') as f:
    while True:
      chunk = f.read(1024 * 1024)
      if not chunk:
        break
      h.update(chunk)
  return h.hexdigest()


def read_json(path: Path) -> dict:
  with path.open('r', encoding='utf-8') as f:
    obj = json.load(f)
  if not isinstance(obj, dict):
    raise ValueError('manifest.json 不是对象')
  return obj


def write_json(path: Path, obj: dict) -> None:
  path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main() -> int:
  parser = argparse.ArgumentParser(description='导出 OpenL3 (librosa frontend) 为 ONNX')
  parser.add_argument(
    '--manifest',
    default='resources/ai/openl3/manifest.json',
    help='OpenL3 manifest.json 路径（默认：resources/ai/openl3/manifest.json）',
  )
  parser.add_argument('--output', default='', help='导出的 onnx 路径（默认从 manifest.modelFile 推断）')
  parser.add_argument('--input-repr', default='mel256', choices=['linear', 'mel128', 'mel256'])
  parser.add_argument('--content-type', default='music', choices=['music', 'env'])
  parser.add_argument('--embedding-size', type=int, default=512, choices=[512, 6144])
  parser.add_argument('--frontend', default='librosa', choices=['librosa', 'kapre'])
  parser.add_argument('--opset', type=int, default=13)
  parser.add_argument('--write-sha256', action='store_true', help='写回 manifest.json 的 sha256 字段')
  args = parser.parse_args()

  manifest_path = Path(args.manifest)
  manifest = read_json(manifest_path)

  model_file = str(manifest.get('modelFile') or '').strip()
  if not model_file:
    raise ValueError('manifest.modelFile 缺失/为空')

  out_path = Path(args.output) if args.output.strip() else manifest_path.parent / model_file
  out_path.parent.mkdir(parents=True, exist_ok=True)

  try:
    import openl3
    import tensorflow as tf
    import tf2onnx
  except Exception as e:
    msg = str(e)
    print('依赖导入失败：请先安装 openl3 / tensorflow / tf2onnx')
    print(f'原因：{e.__class__.__name__}: {msg}')
    if 'numpy' in msg and ('has no attribute' in msg) and ('np.object' in msg or 'np.cast' in msg):
      print('提示：你很可能装到了过旧的 tf2onnx（或装了 NumPy 2.x）。建议用 Python 3.11 并固定版本：')
      print('  pip install "openl3==0.4.2" "tensorflow==2.15.1" "tf2onnx==1.16.1"')
    missing_tf_keras = (
      isinstance(e, ModuleNotFoundError) and getattr(e, 'name', '') == 'tensorflow.keras'
    ) or ('tensorflow.keras' in msg and ('No module named' in msg or 'ModuleNotFoundError' in msg))
    if missing_tf_keras:
      dist = None
      ver = None
      try:
        import importlib.metadata as metadata

        for name in ('tensorflow-intel', 'tensorflow'):
          try:
            ver = metadata.version(name)
            dist = name
            break
          except metadata.PackageNotFoundError:
            continue
      except Exception:
        dist = None
        ver = None

      print('提示：检测到 tensorflow.keras 缺失，通常是 TensorFlow 安装不完整（例如 tensorflow/__init__.py 缺失）。')
      if dist and ver:
        print('可尝试在当前 venv 里强制重装（不带依赖，避免把环境再打散）：')
        print(f'  pip install --force-reinstall --no-deps --no-cache-dir "{dist}=={ver}"')
      else:
        print('可尝试在当前 venv 里强制重装（不带依赖，避免把环境再打散）：')
        print('  pip install --force-reinstall --no-deps --no-cache-dir "tensorflow-intel==<你的版本>"')
      print('然后重试本脚本；若仍失败，建议删除 venv 后重建。')
    raise e

  model = openl3.models.load_audio_embedding_model(
    input_repr=args.input_repr,
    content_type=args.content_type,
    embedding_size=args.embedding_size,
    frontend=args.frontend,
  )

  input_shape = getattr(model, 'input_shape', None)
  if not input_shape or isinstance(input_shape, (list, tuple)) and len(input_shape) < 2:
    raise ValueError(f'无法读取模型 input_shape: {input_shape}')

  # OpenL3 librosa frontend: [None, 256, 199, 1] (mel256/music) 是常见形状；此处以模型实际 input_shape 为准。
  spec = tf.TensorSpec([None] + list(input_shape[1:]), tf.float32, name='input')

  @tf.function(input_signature=[spec])
  def forward(x):
    return model(x, training=False)

  tf2onnx.convert.from_function(
    forward,
    input_signature=[spec],
    opset=args.opset,
    output_path=str(out_path),
  )

  digest = sha256_file(out_path)
  print(f'已导出: {out_path.as_posix()}')
  print(f'sha256: {digest}')

  if args.write_sha256:
    manifest['sha256'] = digest
    write_json(manifest_path, manifest)
    print(f'已写回: {manifest_path.as_posix()}')

  return 0


if __name__ == '__main__':
  raise SystemExit(main())
