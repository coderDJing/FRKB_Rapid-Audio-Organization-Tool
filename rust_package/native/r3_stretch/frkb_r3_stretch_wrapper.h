#pragma once

#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

void* frkb_r3_stretch_create(uint32_t channels, uint32_t sample_rate, double tempo);
void* frkb_r3_stretch_create_with_mode(
    uint32_t channels,
    uint32_t sample_rate,
    double tempo,
    uint32_t mode);
void frkb_r3_stretch_destroy(void* handle);
void frkb_r3_stretch_reset(void* handle, double tempo);
int32_t frkb_r3_stretch_engine_version(void* handle);
uint32_t frkb_r3_stretch_preferred_start_pad(void* handle);
uint32_t frkb_r3_stretch_start_delay(void* handle);
void frkb_r3_stretch_set_tempo(void* handle, double tempo);
uint32_t frkb_r3_stretch_get_samples_required(void* handle);
int32_t frkb_r3_stretch_process_interleaved(
    void* handle,
    const float* input,
    uint32_t frames);
uint32_t frkb_r3_stretch_retrieve_interleaved(
    void* handle,
    float* output,
    uint32_t max_frames);
void frkb_r3_stretch_finish(void* handle);

#ifdef __cplusplus
}
#endif
