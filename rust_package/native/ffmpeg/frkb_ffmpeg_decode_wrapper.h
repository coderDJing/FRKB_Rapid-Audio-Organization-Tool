#ifndef FRKB_FFMPEG_DECODE_WRAPPER_H
#define FRKB_FFMPEG_DECODE_WRAPPER_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Decode an audio file to interleaved 16-bit PCM using FFmpeg libavcodec.
 *
 * @param file_path         Path to the audio file.
 * @param max_duration_sec  Maximum seconds to decode (0 = no limit).
 * @param samples_out       Receives allocated int16_t buffer (caller must call frkb_ffmpeg_free_buffer).
 * @param num_samples_out   Receives total sample count (per channel, so total = num_samples * channels).
 * @param sample_rate_out   Receives the sample rate of the decoded audio.
 * @param num_channels_out  Receives the channel count.
 * @return 0 on success, non-zero error code on failure.
 */
int frkb_ffmpeg_decode_to_i16(
    const char *file_path,
    int max_duration_sec,
    int16_t **samples_out,
    int *num_samples_out,
    int *sample_rate_out,
    int *num_channels_out
);

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

/**
 * Free a buffer allocated by frkb_ffmpeg_decode_to_i16.
 */
void frkb_ffmpeg_free_buffer(void *ptr);

#ifdef __cplusplus
}
#endif

#endif
