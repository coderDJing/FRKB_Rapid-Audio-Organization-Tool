import util
import core

# 设定要搜索的目录和音频文件扩展名
search_directory = util.getConfigJson()["updatePath"]  # 目录路径

audio_extensions = util.getConfigJson()["audio_extensions"]

# 查找音频文件并打印路径
audio_paths = util.find_audio_files(search_directory, audio_extensions)


myAudioList = []


for index, value in enumerate(audio_paths):
    myAudioList.append(
        {
            "path": value,
            "fingerprintMd5": util.numpy_array_to_md5(
                core.generate_audio_fingerprint(value)
            ),
        }
    )
    util.print_progress_bar(index + 1, len(audio_paths))

seen_fingerprintMd5s = set(
    core.readLibrary("./library/songLibrary")
)  # 用于 []存储  已经#见过的 用于指纹存储不
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


toBeDeletedList = remove_duplicates_with_paths(
    myAudioList
)  # 重复项List暂时没用到，后续可能有功能会用到

with open("./library/songLibrary", "w") as f:
    f.write(",".join(seen_fingerprintMd5s))
    libraryLengthAfter = len(seen_fingerprintMd5s)


util.writeLog(
    "本次共扫描"
    + str(len(myAudioList))
    + "首歌,新增"
    + str(libraryLengthAfter - libraryLengthBefore)
    + "首歌"
)
