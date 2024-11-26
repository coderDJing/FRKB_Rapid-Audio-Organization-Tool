import librosa
import numpy as np
y, sr = librosa.load('E:\\test.mp3', sr=22050)
mfccs = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
fingerprint = np.mean(mfccs.T, axis=0)
print(fingerprint)
