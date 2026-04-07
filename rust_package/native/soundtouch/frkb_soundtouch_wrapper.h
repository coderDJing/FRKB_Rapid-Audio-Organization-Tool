#pragma once

#include "include/SoundTouch.h"

extern "C" {
void* frkb_soundtouch_create();
void frkb_soundtouch_destroy(void* handle);
void frkb_soundtouch_set_channels(void* handle, unsigned int channels);
void frkb_soundtouch_set_sample_rate(void* handle, unsigned int sample_rate);
void frkb_soundtouch_set_tempo(void* handle, double tempo);
void frkb_soundtouch_set_pitch(void* handle, double pitch);
void frkb_soundtouch_set_rate(void* handle, double rate);
void frkb_soundtouch_set_setting(void* handle, int setting_id, int value);
void frkb_soundtouch_put_samples(void* handle, const float* samples, unsigned int num_samples);
unsigned int frkb_soundtouch_receive_samples(
  void* handle,
  float* output,
  unsigned int max_samples
);
void frkb_soundtouch_flush(void* handle);
void frkb_soundtouch_clear(void* handle);
}
