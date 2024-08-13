import sys
import numpy as np
import librosa
import hashlib
import os
import multiprocessing
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="gb18030")
folderPaths = sys.argv[1]
extensions = sys.argv[2].split(",")


# 查找指定扩展名的文件
def find_files_with_extension(directory, extensions):
    matched_files = []
    for root, dirs, files in os.walk(directory):
        for file in files:
            if any(file.endswith(ext) for ext in extensions):
                matched_files.append(os.path.join(root, file))
    return matched_files


def find_files_in_multiple_directories(folderPaths, extensions):
    all_matched_files = []
    # 分割 folderPaths 字符串，得到目录列表
    directories = folderPaths.split("|")
    # 遍历每个目录
    for directory in directories:
        # 调用 find_files_with_extension 函数并收集结果
        matched_files = find_files_with_extension(directory, extensions)
        all_matched_files.extend(matched_files)
    return all_matched_files


files_found = find_files_in_multiple_directories(folderPaths, extensions)


def analyze_song(file_path):
    try:
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
        print(md5_hash + "|" + file_path + "||", flush=True)
    except Exception as e:
        # 打印出错的文件路径和异常信息
        print("error" + "|" + file_path + "||", flush=True)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    # 获取CPU核数
    num_processes = multiprocessing.cpu_count()
    # 创建一个进程池，进程数为CPU核数
    with multiprocessing.Pool(processes=num_processes) as pool:
        pool.map(analyze_song, files_found)
