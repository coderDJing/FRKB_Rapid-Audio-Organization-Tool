#ifndef FRKB_CHROMAPRINT_WRAPPER_H
#define FRKB_CHROMAPRINT_WRAPPER_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Generate a Chromaprint fingerprint from i16 PCM data.
 *
 * @param samples_i16   Interleaved i16 PCM samples
 * @param num_samples   Total number of samples (array length, not frames)
 * @param sample_rate   Sample rate in Hz
 * @param num_channels  Number of channels (1 or 2)
 * @param max_seconds   Max analysis duration in seconds (0 = no limit)
 * @param fingerprint_out  Output: base64-encoded fingerprint (free with frkb_chromaprint_free_string)
 * @param duration_out     Output: actual analyzed duration in seconds
 * @return 0=success, 1=null input, 2=invalid params, 3=context creation failed,
 *         4=start failed, 5=feed failed, 6=fingerprint extraction failed
 */
int frkb_chromaprint_generate(
    const int16_t *samples_i16,
    int num_samples,
    int sample_rate,
    int num_channels,
    int max_seconds,
    char **fingerprint_out,
    double *duration_out
);

void frkb_chromaprint_free_string(char *ptr);

#ifdef __cplusplus
}
#endif

#endif
