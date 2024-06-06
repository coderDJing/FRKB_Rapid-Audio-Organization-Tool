import hashlib

import util
import core

# 设定要搜索的目录和音频文件扩展名
with open("updatePath.txt", "r") as file:
    search_directory = file.read()  # 目录路径

audio_extensions = [".mp3", ".wav", ".flac"]  # 你可以根据需要添加其他扩展名

# 查找音频文件并打印路径
audio_paths = util.find_audio_files(search_directory, audio_extensions)


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
            "fingerprintMd5": numpy_array_to_md5(
                core.generate_audio_fingerprint(value)
            ),
        }
    )
    util.print_progress_bar(index + 1, len(audio_paths))

seen_fingerprintMd5s = set()  # 用于 []存储  已经#见过的 用于指纹存储不
# 以只读模式打开文件
with open("songLibrary", "r") as file:
    seen_fingerprintMd5s = set(file.read().split(","))  # 读取文件全部内容
    libraryLengthBefore = len(seen_fingerprintMd5s)


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
libraryLengthAfter = 0
with open("songLibrary", "w") as f:
    f.write(",".join(seen_fingerprintMd5s))
    libraryLengthAfter = len(seen_fingerprintMd5s)

with open("./logs/" + util.getDateTime() + ".txt", "w") as f:
    f.write(
        "本次共扫描"
        + str(len(myAudioList))
        + "首歌,新增"
        + str(libraryLengthAfter - libraryLengthBefore)
        + "首歌"
    )
