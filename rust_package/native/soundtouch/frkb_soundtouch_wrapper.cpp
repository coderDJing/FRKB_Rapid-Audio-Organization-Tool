#include "frkb_soundtouch_wrapper.h"

using soundtouch::SoundTouch;

extern "C" {

void* frkb_soundtouch_create() {
  return new SoundTouch();
}

void frkb_soundtouch_destroy(void* handle) {
  if (!handle) return;
  delete static_cast<SoundTouch*>(handle);
}

void frkb_soundtouch_set_channels(void* handle, unsigned int channels) {
  if (!handle) return;
  static_cast<SoundTouch*>(handle)->setChannels(channels);
}

void frkb_soundtouch_set_sample_rate(void* handle, unsigned int sample_rate) {
  if (!handle) return;
  static_cast<SoundTouch*>(handle)->setSampleRate(sample_rate);
}

void frkb_soundtouch_set_tempo(void* handle, double tempo) {
  if (!handle) return;
  static_cast<SoundTouch*>(handle)->setTempo(tempo);
}

void frkb_soundtouch_set_pitch(void* handle, double pitch) {
  if (!handle) return;
  static_cast<SoundTouch*>(handle)->setPitch(pitch);
}

void frkb_soundtouch_set_rate(void* handle, double rate) {
  if (!handle) return;
  static_cast<SoundTouch*>(handle)->setRate(rate);
}

void frkb_soundtouch_set_setting(void* handle, int setting_id, int value) {
  if (!handle) return;
  static_cast<SoundTouch*>(handle)->setSetting(setting_id, value);
}

void frkb_soundtouch_put_samples(void* handle, const float* samples, unsigned int num_samples) {
  if (!handle || !samples || num_samples == 0) return;
  static_cast<SoundTouch*>(handle)->putSamples(samples, num_samples);
}

unsigned int frkb_soundtouch_receive_samples(void* handle, float* output, unsigned int max_samples) {
  if (!handle || !output || max_samples == 0) return 0;
  return static_cast<SoundTouch*>(handle)->receiveSamples(output, max_samples);
}

void frkb_soundtouch_flush(void* handle) {
  if (!handle) return;
  static_cast<SoundTouch*>(handle)->flush();
}

void frkb_soundtouch_clear(void* handle) {
  if (!handle) return;
  static_cast<SoundTouch*>(handle)->clear();
}

}
