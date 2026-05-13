#include "frkb_chromaprint_wrapper.h"
#include "include/chromaprint.h"
#include <cstring>
#include <cstdlib>
#include <algorithm>

static const int CHUNK_FRAMES = 4096;

int frkb_chromaprint_generate(
    const int16_t *samples_i16,
    int num_samples,
    int sample_rate,
    int num_channels,
    int max_seconds,
    char **fingerprint_out,
    double *duration_out)
{
    if (!samples_i16 || !fingerprint_out || !duration_out)
        return 1;
    if (num_samples <= 0 || sample_rate <= 0 || (num_channels != 1 && num_channels != 2))
        return 2;

    *fingerprint_out = nullptr;
    *duration_out = 0.0;

    int total_samples = num_samples;
    if (max_seconds > 0) {
        int max_samples = max_seconds * sample_rate * num_channels;
        if (max_samples > 0 && total_samples > max_samples)
            total_samples = max_samples;
    }

    ChromaprintContext *ctx = chromaprint_new(CHROMAPRINT_ALGORITHM_DEFAULT);
    if (!ctx)
        return 3;

    if (!chromaprint_start(ctx, sample_rate, num_channels)) {
        chromaprint_free(ctx);
        return 4;
    }

    int chunk_size = CHUNK_FRAMES * num_channels;
    int offset = 0;
    while (offset < total_samples) {
        int remaining = total_samples - offset;
        int to_feed = remaining < chunk_size ? remaining : chunk_size;
        if (!chromaprint_feed(ctx, samples_i16 + offset, to_feed)) {
            chromaprint_free(ctx);
            return 5;
        }
        offset += to_feed;
    }

    if (!chromaprint_finish(ctx)) {
        chromaprint_free(ctx);
        return 5;
    }

    char *fp = nullptr;
    if (!chromaprint_get_fingerprint(ctx, &fp) || !fp) {
        chromaprint_free(ctx);
        return 6;
    }

    *fingerprint_out = fp;
    *duration_out = (double)total_samples / (double)(sample_rate * num_channels);

    chromaprint_free(ctx);
    return 0;
}

void frkb_chromaprint_free_string(char *ptr)
{
    if (ptr)
        chromaprint_dealloc(ptr);
}
