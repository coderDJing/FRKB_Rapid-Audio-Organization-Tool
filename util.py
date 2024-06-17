from datetime import datetime
import os
import hashlib
import json


def writeLog(logStr):
    with open("./logs/" + getDateTime() + ".txt", "w") as f:
        f.write(logStr)


# 获取config文件中的配置项
def getConfigJson():
    with open("config.json", "r") as file:
        return json.loads(file.read())


# 获取当前时间（用于日志文件命名）
def getDateTime():
    now = datetime.now()
    formatted_time = now.strftime("%Y_%d_%m_%H_%M_%S")
    return formatted_time


# 控制台打印进度条
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


def numpy_array_to_md5(arr):
    # 将NumPy数组转换为字符串
    arr_str = " ".join(map(str, arr.flatten()))

    # 将字符串编码为字节流
    arr_bytes = arr_str.encode("utf-8")

    # 计算MD5哈希值
    md5_hash = hashlib.md5(arr_bytes).hexdigest()

    return md5_hash


# 删除指定路径的文件
def delete_file(file_path):
    try:
        os.remove(file_path)
        print(f"文件 {file_path} 已被删除")
    except OSError as e:
        print(f"删除文件时出错: {file_path} - {e.strerror}")
