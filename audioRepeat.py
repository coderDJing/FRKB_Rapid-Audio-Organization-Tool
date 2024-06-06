import numpy as np
import librosa
import librosa.display
import matplotlib.pyplot as plt
import os
import hashlib


def print_progress_bar(
    iteration,
    total,
    prefix="",
    suffix="",
    decimals=1,
    length=100,
    fill="█",
    print_end="\r",
):
    """
    调用在Python终端中打印自定义进度条的函数
    iteration - 当前迭代（Int）
    total - 总迭代（Int）
    prefix - 前缀字符串（Str）
    suffix - 后缀字符串（Str）
    decimals - 正数的小数位数（Int）
    length - 进度条的长度（Int）
    fill - 进度条填充字符（Str）
    print_end - 行尾字符（Str）
    """
    percent = ("{0:." + str(decimals) + "f}").format(100 * (iteration / float(total)))
    filled_length = int(length * iteration // total)
    bar = fill * filled_length + "-" * (length - filled_length)
    print(f"\r{prefix} |{bar}| {percent}% {suffix}", end=print_end)
    # 打印新行在进度完成后
    if iteration == total:
        print()


def generate_audio_fingerprint(audio_file):
    # 读取音频文件
    y, sr = librosa.load(audio_file)

    # 使用MFCC（Mel Frequency Cepstral Coefficients）作为声音指纹
    mfccs = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)

    # 你可以选择对MFCC进行其他处理，例如取平均值或最大值
    fingerprint = np.mean(mfccs.T, axis=0)

    return fingerprint


def find_audio_files(directory, extensions):
    """
    遍历指定目录及其子目录，查找具有指定扩展名的音频文件，并返回它们的路径列表。

    :param directory: 要搜索的目录路径
    :param extensions: 要匹配的音频文件扩展名列表，例如 ['.mp3', '.wav']
    :return: 音频文件路径列表
    """
    audio_files = []
    for root, dirs, files in os.walk(directory):
        for file in files:
            if any(file.lower().endswith(ext) for ext in extensions):
                audio_files.append(os.path.join(root, file))
    return audio_files


search_directory = ""  # 替换为你的目录路径
# 设定要搜索的目录和音频文件扩展名
with open("scanPath.txt", "r") as file:
    search_directory = file.read()

audio_extensions = [".mp3", ".wav", ".flac"]  # 你可以根据需要添加其他扩展名

# 查找音频文件并打印路径
audio_paths = find_audio_files(search_directory, audio_extensions)


myAudioList = []


def numpy_array_to_md5(arr):
    # 将NumPy数组转换为字符串
    arr_str = " ".join(map(str, arr.flatten()))

    # 将字符串编码为字节流
    arr_bytes = arr_str.encode("utf-8")

    # 计算MD5哈希值
    md5_hash = hashlib.md5(arr_bytes).hexdigest()

    return md5_hash


for index, value in enumerate(audio_paths):
    myAudioList.append(
        {
            "path": value,
            "fingerprintMd5": numpy_array_to_md5(generate_audio_fingerprint(value)),
        }
    )
    print_progress_bar(index + 1, len(audio_paths))

seen_fingerprintMd5s = set()  # 用于 []存储  已经#见过的 用于指纹存储不
# 以只读模式打开文件
with open("songLibrary", "r") as file:
    seen_fingerprintMd5s = set(file.read().split(","))  # 读取文件全部内容


def remove_duplicates_with_paths(data):
    toBeDeleted = []  # 用于存储重复的项的path
    for item in data:
        fingerprintMd5 = item["fingerprintMd5"]
        path = item["path"]
        if fingerprintMd5 not in seen_fingerprintMd5s:
            seen_fingerprintMd5s.add(fingerprintMd5)
        else:
            toBeDeleted.append(path)
    return toBeDeleted


toBeDeletedList = remove_duplicates_with_paths(myAudioList)
with open("songLibrary", "w") as f:
    f.write(",".join(seen_fingerprintMd5s))


def delete_file(file_path):
    try:
        os.remove(file_path)
        print(f"文件 {file_path} 已被删除")
    except OSError as e:
        print(f"删除文件时出错: {file_path} - {e.strerror}")


for item in toBeDeletedList:
    delete_file(item)
