import sys
import numpy as np
import librosa
import hashlib
import json


def analyze_song(file_path):
    # 读取音频文件
    y, sr = librosa.load(file_path, sr=None)
    mfccs = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    fingerprint = np.mean(mfccs.T, axis=0)

    # 将NumPy数组转换为字符串
    arr_str = " ".join(map(str, fingerprint.flatten()))

    # 将字符串编码为字节流
    arr_bytes = arr_str.encode("utf-8")

    # 计算MD5哈希值
    md5_hash = hashlib.md5(arr_bytes).hexdigest()
    return md5_hash


md5_hash = analyze_song(sys.argv[1])
print(json.dumps({"md5_hash": md5_hash, "path": sys.argv[1]}))
