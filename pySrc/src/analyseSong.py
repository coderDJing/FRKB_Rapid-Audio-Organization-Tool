import socket
import multiprocessing
import numpy as np
from multiprocessing import Manager
import librosa
import hashlib
import json
import random


def analyze_song(file_path, conn, lock):
    try:
        # 读取音频文件
        y, sr = librosa.load(file_path, sr=None)
        mfccs = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)

        # 确保 tempo 是标量值
        if isinstance(tempo, np.ndarray):
            tempo = tempo.item()  # 提取单个元素

        fingerprint = np.mean(mfccs.T, axis=0)

        # 将NumPy数组转换为字符串
        arr_str = " ".join(map(str, fingerprint.flatten()))

        # 将字符串编码为字节流
        arr_bytes = arr_str.encode("utf-8")

        # 计算MD5哈希值
        md5_hash = hashlib.md5(arr_bytes).hexdigest()
        message = json.dumps(
            {
                "md5_hash": md5_hash,
                "file_path": file_path,
                "bpm": round(float(tempo), 2),
            }
        )

        # 使用锁来确保并发安全
        with lock:
            conn.send(message.encode("utf-8"))
    except Exception as e:
        message = json.dumps(
            {"md5_hash": "error", "file_path": file_path, "bpm": "error"}
        )

        # 使用锁来确保并发安全
        with lock:
            conn.send(message.encode("utf-8"))


def bind_socket(frkbSocket, port):
    try:
        frkbSocket.bind(("localhost", port))
        print(json.dumps({"port": port}), flush=True)
    except socket.error as e:
        return False
    return True


def main():
    frkbSocket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    while True:
        port = random.randint(1, 65535)
        if bind_socket(frkbSocket, port):
            break

    frkbSocket.listen(1)

    manager = Manager()
    lock = manager.Lock()  # 创建一个锁对象

    while True:
        conn, address = frkbSocket.accept()
        total_data = bytes()
        while True:
            data = conn.recv(1024)
            if not data:
                break
            total_data += data
            if len(data) < 1000:
                break
        songArr = total_data.decode("utf-8").split("|")

        # 获取CPU核数
        num_processes = multiprocessing.cpu_count()
        # 创建一个进程池，进程数为CPU核数
        with multiprocessing.Pool(
            processes=num_processes, initializer=lambda: manager
        ) as pool:
            pool.starmap(
                analyze_song, [(file_path, conn, lock) for file_path in songArr]
            )
            pool.close()  # 显式关闭进程池
            pool.join()  # 等待所有子进程结束
        # 关闭连接
        conn.close()


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
