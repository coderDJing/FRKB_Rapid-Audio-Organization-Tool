#include "frkb_r3_stretch_wrapper.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace {

constexpr int kProcessRealTime = 0x00000001;
constexpr int kChannelsTogether = 0x10000000;
constexpr int kEngineFiner = 0x20000000;
constexpr uint32_t kMaxProcessFrames = 65536;

using StretchState = void*;
using NewFn = StretchState (*)(uint32_t, uint32_t, int, double, double);
using DeleteFn = void (*)(StretchState);
using ResetFn = void (*)(StretchState);
using GetEngineVersionFn = int (*)(StretchState);
using SetTimeRatioFn = void (*)(StretchState, double);
using GetPreferredStartPadFn = uint32_t (*)(StretchState);
using GetStartDelayFn = uint32_t (*)(StretchState);
using GetSamplesRequiredFn = uint32_t (*)(StretchState);
using SetMaxProcessSizeFn = void (*)(StretchState, uint32_t);
using ProcessFn = void (*)(StretchState, const float* const*, uint32_t, int);
using AvailableFn = int (*)(StretchState);
using RetrieveFn = uint32_t (*)(StretchState, float* const*, uint32_t);

#if defined(_WIN32)
using LibraryHandle = HMODULE;

LibraryHandle open_library(const char* path) {
  if (path == nullptr || *path == '\0') {
    return nullptr;
  }
  return LoadLibraryExA(path, nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
}

void* load_symbol(LibraryHandle library, const char* name) {
  return reinterpret_cast<void*>(GetProcAddress(library, name));
}
#else
using LibraryHandle = void*;

LibraryHandle open_library(const char* path) {
  if (path == nullptr || *path == '\0') {
    return nullptr;
  }
  return dlopen(path, RTLD_NOW | RTLD_LOCAL);
}

void* load_symbol(LibraryHandle library, const char* name) {
  return dlsym(library, name);
}
#endif

template <typename Function>
Function resolve(LibraryHandle library, const char* name) {
  return reinterpret_cast<Function>(load_symbol(library, name));
}

struct StretchApi {
  LibraryHandle library = nullptr;
  NewFn create = nullptr;
  DeleteFn destroy = nullptr;
  ResetFn reset = nullptr;
  GetEngineVersionFn get_engine_version = nullptr;
  SetTimeRatioFn set_time_ratio = nullptr;
  GetPreferredStartPadFn get_preferred_start_pad = nullptr;
  GetStartDelayFn get_start_delay = nullptr;
  GetSamplesRequiredFn get_samples_required = nullptr;
  SetMaxProcessSizeFn set_max_process_size = nullptr;
  ProcessFn process = nullptr;
  AvailableFn available = nullptr;
  RetrieveFn retrieve = nullptr;

  StretchApi() {
    const char* configured_path = std::getenv("FRKB_R3_STRETCH_LIBRARY");
    library = open_library(configured_path);
    if (library == nullptr) {
#if defined(_WIN32)
      library = open_library("rubberband-2.dll");
      if (library == nullptr) {
        library = open_library("rubberband.dll");
      }
#elif defined(__APPLE__)
      library = open_library("librubberband.2.dylib");
      if (library == nullptr) {
        library = open_library("librubberband.dylib");
      }
#endif
    }
    if (library == nullptr) {
      return;
    }

    create = resolve<NewFn>(library, "rubberband_new");
    destroy = resolve<DeleteFn>(library, "rubberband_delete");
    reset = resolve<ResetFn>(library, "rubberband_reset");
    get_engine_version =
        resolve<GetEngineVersionFn>(library, "rubberband_get_engine_version");
    set_time_ratio = resolve<SetTimeRatioFn>(library, "rubberband_set_time_ratio");
    get_preferred_start_pad = resolve<GetPreferredStartPadFn>(
        library, "rubberband_get_preferred_start_pad");
    get_start_delay = resolve<GetStartDelayFn>(library, "rubberband_get_start_delay");
    get_samples_required = resolve<GetSamplesRequiredFn>(
        library, "rubberband_get_samples_required");
    set_max_process_size = resolve<SetMaxProcessSizeFn>(
        library, "rubberband_set_max_process_size");
    process = resolve<ProcessFn>(library, "rubberband_process");
    available = resolve<AvailableFn>(library, "rubberband_available");
    retrieve = resolve<RetrieveFn>(library, "rubberband_retrieve");
  }

  bool valid() const {
    return library != nullptr && create != nullptr && destroy != nullptr && reset != nullptr &&
        get_engine_version != nullptr && set_time_ratio != nullptr &&
        get_preferred_start_pad != nullptr && get_start_delay != nullptr &&
        get_samples_required != nullptr && set_max_process_size != nullptr &&
        process != nullptr && available != nullptr && retrieve != nullptr;
  }
};

StretchApi& stretch_api() {
  static StretchApi api;
  return api;
}

double time_ratio_from_tempo(double tempo) {
  if (!std::isfinite(tempo) || tempo <= 0.0) {
    return 1.0;
  }
  return 1.0 / std::clamp(tempo, 0.25, 4.0);
}

struct StretchHandle {
  StretchApi* api = nullptr;
  StretchState state = nullptr;
  uint32_t channels = 0;
  uint32_t remaining_start_delay = 0;
  bool finished = false;
  std::vector<std::vector<float>> input;
  std::vector<std::vector<float>> output;
  std::vector<const float*> input_ptrs;
  std::vector<float*> output_ptrs;

  StretchHandle(StretchApi* resolved_api, uint32_t channel_count)
      : api(resolved_api),
        channels(channel_count),
        input(channel_count),
        output(channel_count),
        input_ptrs(channel_count),
        output_ptrs(channel_count) {
    for (uint32_t channel = 0; channel < channels; ++channel) {
      input[channel].resize(kMaxProcessFrames, 0.0f);
      output[channel].resize(kMaxProcessFrames, 0.0f);
      input_ptrs[channel] = input[channel].data();
      output_ptrs[channel] = output[channel].data();
    }
  }

  void process_start_pad() {
    uint32_t remaining = api->get_preferred_start_pad(state);
    remaining_start_delay = api->get_start_delay(state);
    while (remaining > 0) {
      const uint32_t block = std::min(remaining, kMaxProcessFrames);
      api->process(state, input_ptrs.data(), block, 0);
      remaining -= block;
    }
  }

  uint32_t retrieve_and_discard(uint32_t frames) {
    const uint32_t block = std::min(frames, kMaxProcessFrames);
    return api->retrieve(state, output_ptrs.data(), block);
  }
};

StretchHandle* as_handle(void* handle) {
  return static_cast<StretchHandle*>(handle);
}

}  // namespace

extern "C" void* frkb_r3_stretch_create(
    uint32_t channels,
    uint32_t sample_rate,
    double tempo) {
  if (channels == 0 || channels > 2 || sample_rate == 0) {
    return nullptr;
  }
  StretchApi& api = stretch_api();
  if (!api.valid()) {
    return nullptr;
  }

  auto handle = std::make_unique<StretchHandle>(&api, channels);
  const int options = kProcessRealTime | kChannelsTogether | kEngineFiner;
  handle->state = api.create(
      sample_rate, channels, options, time_ratio_from_tempo(tempo), 1.0);
  if (handle->state == nullptr) {
    return nullptr;
  }
  if (api.get_engine_version(handle->state) != 3) {
    api.destroy(handle->state);
    handle->state = nullptr;
    return nullptr;
  }
  api.set_max_process_size(handle->state, kMaxProcessFrames);
  handle->process_start_pad();
  return handle.release();
}

extern "C" void frkb_r3_stretch_destroy(void* opaque) {
  std::unique_ptr<StretchHandle> handle(as_handle(opaque));
  if (handle && handle->api != nullptr && handle->state != nullptr) {
    handle->api->destroy(handle->state);
    handle->state = nullptr;
  }
}

extern "C" int32_t frkb_r3_stretch_engine_version(void* opaque) {
  StretchHandle* handle = as_handle(opaque);
  if (handle == nullptr || handle->state == nullptr) {
    return 0;
  }
  return handle->api->get_engine_version(handle->state);
}

extern "C" void frkb_r3_stretch_reset(void* opaque, double tempo) {
  StretchHandle* handle = as_handle(opaque);
  if (handle == nullptr || handle->state == nullptr) {
    return;
  }
  handle->api->set_time_ratio(handle->state, time_ratio_from_tempo(tempo));
  handle->api->reset(handle->state);
  handle->finished = false;
  handle->process_start_pad();
}

extern "C" void frkb_r3_stretch_set_tempo(void* opaque, double tempo) {
  StretchHandle* handle = as_handle(opaque);
  if (handle == nullptr || handle->state == nullptr || handle->finished) {
    return;
  }
  handle->api->set_time_ratio(handle->state, time_ratio_from_tempo(tempo));
}

extern "C" uint32_t frkb_r3_stretch_get_samples_required(void* opaque) {
  StretchHandle* handle = as_handle(opaque);
  if (handle == nullptr || handle->state == nullptr || handle->finished) {
    return 0;
  }
  return std::min(
      handle->api->get_samples_required(handle->state), kMaxProcessFrames);
}

extern "C" int32_t frkb_r3_stretch_process_interleaved(
    void* opaque,
    const float* interleaved,
    uint32_t frames) {
  StretchHandle* handle = as_handle(opaque);
  if (handle == nullptr || handle->state == nullptr || handle->finished ||
      interleaved == nullptr || frames == 0 || frames > kMaxProcessFrames) {
    return 0;
  }
  for (uint32_t frame = 0; frame < frames; ++frame) {
    for (uint32_t channel = 0; channel < handle->channels; ++channel) {
      handle->input[channel][frame] =
          interleaved[frame * handle->channels + channel];
    }
  }
  handle->api->process(handle->state, handle->input_ptrs.data(), frames, 0);
  return 1;
}

extern "C" uint32_t frkb_r3_stretch_retrieve_interleaved(
    void* opaque,
    float* interleaved,
    uint32_t max_frames) {
  StretchHandle* handle = as_handle(opaque);
  if (handle == nullptr || handle->state == nullptr || interleaved == nullptr ||
      max_frames == 0) {
    return 0;
  }

  while (handle->remaining_start_delay > 0) {
    const int available = handle->api->available(handle->state);
    if (available <= 0) {
      return 0;
    }
    const uint32_t discarded = handle->retrieve_and_discard(std::min(
        handle->remaining_start_delay, static_cast<uint32_t>(available)));
    if (discarded == 0) {
      return 0;
    }
    handle->remaining_start_delay -=
        std::min(handle->remaining_start_delay, discarded);
  }

  const int available = handle->api->available(handle->state);
  if (available <= 0) {
    return 0;
  }
  const uint32_t requested = std::min(
      {max_frames, static_cast<uint32_t>(available), kMaxProcessFrames});
  const uint32_t received =
      handle->api->retrieve(handle->state, handle->output_ptrs.data(), requested);
  for (uint32_t frame = 0; frame < received; ++frame) {
    for (uint32_t channel = 0; channel < handle->channels; ++channel) {
      interleaved[frame * handle->channels + channel] =
          handle->output[channel][frame];
    }
  }
  return received;
}

extern "C" void frkb_r3_stretch_finish(void* opaque) {
  StretchHandle* handle = as_handle(opaque);
  if (handle == nullptr || handle->state == nullptr || handle->finished) {
    return;
  }
  handle->api->process(handle->state, handle->input_ptrs.data(), 0, 1);
  handle->finished = true;
}
