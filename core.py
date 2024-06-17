import numpy as np
import librosa
import librosa.display
import matplotlib.pyplot as plt


def generate_audio_fingerprint(audio_file):
    # 读取音频文件
    y, sr = librosa.load(audio_file)

    # 使用MFCC（Mel Frequency Cepstral Coefficients）作为声音指纹
    mfccs = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)

    # 你可以选择对MFCC进行其他处理，例如取平均值或最大值
    fingerprint = np.mean(mfccs.T, axis=0)

    return fingerprint


# 读取指定路径的library字符串返回列表形式
def readLibrary(path):
    with open(path, "r") as file:
        content = file.read()
    if content:  # 如果content不为空
        split_content = content.split(",")
    else:
        split_content = []  # 如果content为空，则直接返回空列表
    return split_content
