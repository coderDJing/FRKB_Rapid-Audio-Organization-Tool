import sys
import numpy as np
import librosa
import hashlib
import json


def analyze_song(file_path):
    # 读取音频文件
    y, sr = librosa.load(file_path, sr=None)
    y_str = np.array2string(
        y, separator=",", formatter={"float_kind": lambda x: f"{x:.6f}"}
    )
    y_str_clean = "".join(
        filter(
            str.isdigit,
            y_str.replace(".", "").replace(",", "").replace("[", "").replace("]", ""),
        )
    )
    md5_hash = hashlib.md5(y_str_clean.encode("utf-8")).hexdigest()
    return md5_hash


md5_hash = analyze_song(sys.argv[1])
print(json.dumps({"md5_hash": md5_hash, "path": sys.argv[1]}))
