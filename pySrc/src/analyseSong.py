import socket
import multiprocessing
import numpy as np
import librosa
import hashlib
import json

frkbSocket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

port = 14736


def socketBind():
    global port
    while True:
        try:
            frkbSocket.bind(("localhost", port))
            break
        except OSError:
            port += 1


def analyze_song(file_path, conn):
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
        message = json.dumps({"md5_hash": md5_hash, "file_path": file_path})
        conn.send(message.encode("utf-8"))

    except Exception as e:
        message = json.dumps({"md5_hash": "error", "file_path": file_path})
        conn.send(message.encode("utf-8"))


def main():
    socketBind()
    print(port, flush=True)
    frkbSocket.listen(1)

    while True:
        conn, address = frkbSocket.accept()
        print(f"Connected by {address}")
        total_data = bytes()
        while True:
            data = conn.recv(1024)
            total_data += data
            print(len(data))
            if len(data) < 1000:
                break
        songArr = total_data.decode("utf-8").split("|")

        # 获取CPU核数
        num_processes = multiprocessing.cpu_count()

        # 创建一个进程池，进程数为CPU核数
        with multiprocessing.Pool(processes=num_processes) as pool:
            pool.starmap(analyze_song, [(file_path, conn) for file_path in songArr])

        # 关闭连接
        conn.close()


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
