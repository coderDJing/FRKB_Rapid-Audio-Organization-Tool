import sys
import numpy as np
import librosa
import hashlib
import json
import os
import multiprocessing

folderPath = sys.argv[1]
extensions = sys.argv[2].split(",")


# 查找指定扩展名的文件
def find_files_with_extension(directory, extensions):
    matched_files = []
    for root, dirs, files in os.walk(directory):
        for file in files:
            if any(file.endswith(ext) for ext in extensions):
                matched_files.append(os.path.join(root, file))
    return matched_files


files_found = find_files_with_extension(folderPath, extensions)


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
    print(md5_hash + "|" + file_path)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    # 获取CPU核数
    num_processes = multiprocessing.cpu_count()
    # 创建一个进程池，进程数为CPU核数
    with multiprocessing.Pool(processes=num_processes) as pool:
        pool.map(analyze_song, files_found)
