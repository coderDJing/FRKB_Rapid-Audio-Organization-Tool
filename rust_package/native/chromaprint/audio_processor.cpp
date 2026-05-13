// Copyright (C) 2010-2016  Lukas Lalinsky
// Distributed under the MIT license, see the LICENSE file for details.
// FRKB: Removed FFmpeg avresample dependency, replaced with simple linear resampler.

#include <assert.h>
#include <algorithm>
#include <stdio.h>
#include <cmath>
#include "debug.h"
#include "audio_processor.h"

namespace chromaprint {

static const int kMinSampleRate = 1000;
static const int kMaxBufferSize = 1024 * 32;

AudioProcessor::AudioProcessor(int sample_rate, AudioConsumer *consumer)
	: m_buffer(kMaxBufferSize),
	  m_buffer_offset(0),
	  m_resample_buffer(kMaxBufferSize),
	  m_target_sample_rate(sample_rate),
	  m_consumer(consumer),
	  m_resample_ctx(0),
	  m_resample_ratio(1.0),
	  m_resample_phase(0.0)
{
}

AudioProcessor::~AudioProcessor()
{
}

void AudioProcessor::LoadMono(const int16_t *input, int length)
{
	int16_t *output = m_buffer.data() + m_buffer_offset;
	while (length--) {
		*output++ = input[0];
		input++;
	}
}

void AudioProcessor::LoadStereo(const int16_t *input, int length)
{
	int16_t *output = m_buffer.data() + m_buffer_offset;
	while (length--) {
		*output++ = (input[0] + input[1]) / 2;
		input += 2;
	}
}

void AudioProcessor::LoadMultiChannel(const int16_t *input, int length)
{
	int16_t *output = m_buffer.data() + m_buffer_offset;
	while (length--) {
		int32_t sum = 0;
		for (int i = 0; i < m_num_channels; i++) {
			sum += *input++;
		}
		*output++ = (int16_t)(sum / m_num_channels);
	}
}

int AudioProcessor::Load(const int16_t *input, int length)
{
	assert(length >= 0);
	assert(m_buffer_offset <= m_buffer.size());
	length = std::min(length, static_cast<int>(m_buffer.size() - m_buffer_offset));
	switch (m_num_channels) {
	case 1:
		LoadMono(input, length);
		break;
	case 2:
		LoadStereo(input, length);
		break;
	default:
		LoadMultiChannel(input, length);
		break;
	}
	m_buffer_offset += length;
	return length;
}

void AudioProcessor::Resample()
{
	if (!m_resample_ctx) {
		m_consumer->Consume(m_buffer.data(), int(m_buffer_offset));
		m_buffer_offset = 0;
		return;
	}

	// Simple linear interpolation resampler
	int input_len = int(m_buffer_offset);
	int output_capacity = kMaxBufferSize;
	int output_len = 0;
	const int16_t *input = m_buffer.data();
	int16_t *output = m_resample_buffer.data();

	double phase = m_resample_phase;
	while (phase < input_len && output_len < output_capacity) {
		int idx = int(phase);
		double frac = phase - idx;
		double sample;
		if (idx + 1 < input_len) {
			sample = input[idx] * (1.0 - frac) + input[idx + 1] * frac;
		} else {
			sample = input[idx];
		}
		output[output_len++] = (int16_t)(sample + (sample >= 0 ? 0.5 : -0.5));
		phase += m_resample_ratio;
	}

	// Keep track of fractional phase for next chunk
	m_resample_phase = phase - input_len;
	if (m_resample_phase < 0) m_resample_phase = 0;

	m_consumer->Consume(output, output_len);
	m_buffer_offset = 0;
}


bool AudioProcessor::Reset(int sample_rate, int num_channels)
{
	if (num_channels <= 0) {
		DEBUG("chromaprint::AudioProcessor::Reset() -- No audio channels.");
		return false;
	}
	if (sample_rate <= kMinSampleRate) {
		DEBUG("chromaprint::AudioProcessor::Reset() -- Sample rate less than "
              << kMinSampleRate << " (" << sample_rate << ").");
		return false;
	}
	m_buffer_offset = 0;
	m_resample_phase = 0.0;
	if (sample_rate != m_target_sample_rate) {
		m_resample_ctx = 1; // flag: resampling needed
		m_resample_ratio = (double)sample_rate / (double)m_target_sample_rate;
	} else {
		m_resample_ctx = 0;
		m_resample_ratio = 1.0;
	}
	m_num_channels = num_channels;
	return true;
}

void AudioProcessor::Consume(const int16_t *input, int length)
{
	assert(length >= 0);
	assert(length % m_num_channels == 0);
	length /= m_num_channels;
	while (length > 0) {
		int consumed = Load(input, length);
		input += consumed * m_num_channels;
		length -= consumed;
		if (m_buffer.size() == m_buffer_offset) {
			Resample();
			if (m_buffer.size() == m_buffer_offset) {
				DEBUG("chromaprint::AudioProcessor::Consume() -- Resampling failed?");
				return;
			}
		}
	}
}

void AudioProcessor::Flush()
{
	if (m_buffer_offset) {
		Resample();
	}
}

}; // namespace chromaprint
