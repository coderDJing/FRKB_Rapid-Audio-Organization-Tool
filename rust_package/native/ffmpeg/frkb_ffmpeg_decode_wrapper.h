#ifndef FRKB_FFMPEG_DECODE_WRAPPER_H
#define FRKB_FFMPEG_DECODE_WRAPPER_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Decode an audio file and generate a Chromaprint fingerprint in one pass.
 * Streams decoded audio directly to Chromaprint without buffering the full PCM.
 *
 * @param file_path         Path to the audio file.
 * @param max_duration_sec  Maximum seconds to process (0 = no limit, default 120).
 * @param fingerprint_out   Receives allocated base64 fingerprint string (caller must call frkb_chromaprint_free_string).
 * @param duration_out      Receives the actual duration processed in seconds.
 * @return 0 on success, non-zero error code on failure.
 */
int frkb_ffmpeg_chromaprint_generate(
    const char *file_path,
    int max_duration_sec,
    char **fingerprint_out,
    double *duration_out
);

#ifdef __cplusplus
}
#endif

#endif
