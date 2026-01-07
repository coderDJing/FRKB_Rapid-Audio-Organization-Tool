#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include "dsp/keydetection/GetKeyMode.h"

namespace {

class DownmixAndOverlapHelper {
  public:
    using WindowReadyCallback = std::function<bool(double* pBuffer, std::size_t frames)>;

    bool initialize(std::size_t windowSize,
            std::size_t stepSize,
            const WindowReadyCallback& callback) {
        m_buffer.assign(windowSize, 0.0);
        m_callback = callback;
        m_windowSize = windowSize;
        m_stepSize = stepSize;
        m_bufferWritePosition = windowSize / 2;
        return m_windowSize > 0 && m_stepSize > 0 &&
                m_stepSize <= m_windowSize && static_cast<bool>(m_callback);
    }

    bool processStereoSamples(const float* pInput, std::size_t numInputFrames) {
        return processInner(pInput, numInputFrames);
    }

    bool finalize() {
        std::size_t framesToFillWindow = m_windowSize - m_bufferWritePosition;
        std::size_t numInputFrames = std::max(framesToFillWindow, m_windowSize / 2 - 1);
        return processInner(nullptr, numInputFrames);
    }

  private:
    bool processInner(const float* pInput, std::size_t numInputFrames) {
        std::size_t inRead = 0;
        double* pDownmix = m_buffer.data();

        while (inRead < numInputFrames) {
            std::size_t readAvailable = numInputFrames - inRead;
            std::size_t writeAvailable = m_windowSize - m_bufferWritePosition;
            std::size_t numFrames = std::min(readAvailable, writeAvailable);

            if (pInput) {
                for (std::size_t i = 0; i < numFrames; ++i) {
                    const std::size_t base = (inRead + i) * 2;
                    pDownmix[m_bufferWritePosition + i] =
                            (pInput[base] + pInput[base + 1]) * 0.5;
                }
            } else {
                for (std::size_t i = 0; i < numFrames; ++i) {
                    pDownmix[m_bufferWritePosition + i] = 0.0;
                }
            }

            m_bufferWritePosition += numFrames;
            inRead += numFrames;

            if (m_bufferWritePosition == m_windowSize) {
                if (!m_callback(pDownmix, m_windowSize)) {
                    return false;
                }

                for (std::size_t i = 0; i < (m_windowSize - m_stepSize); ++i) {
                    pDownmix[i] = pDownmix[i + m_stepSize];
                }
                m_bufferWritePosition -= m_stepSize;
            }
        }
        return true;
    }

    std::vector<double> m_buffer;
    std::size_t m_windowSize = 0;
    std::size_t m_stepSize = 0;
    std::size_t m_bufferWritePosition = 0;
    WindowReadyCallback m_callback;
};

struct KeyChange {
    int key;
    std::int64_t frame;
};

class QmKeyDetector {
  public:
    explicit QmKeyDetector(double sampleRate)
            : m_prevKey(0),
              m_currentFrame(0) {
        GetKeyMode::Config config(sampleRate, kTuningFrequencyHertz);
        m_keyMode = std::make_unique<GetKeyMode>(config);
        const std::size_t windowSize = static_cast<std::size_t>(m_keyMode->getBlockSize());
        const std::size_t stepSize = static_cast<std::size_t>(m_keyMode->getHopSize());
        m_ready = m_helper.initialize(windowSize, stepSize,
                [this](double* pWindow, std::size_t) {
                    return this->handleWindow(pWindow);
                });
    }

    bool isReady() const {
        return m_ready;
    }

    bool process(const float* interleaved, std::size_t frames, int channels) {
        if (!m_ready || !interleaved || channels != 2) {
            return false;
        }
        m_currentFrame += static_cast<std::int64_t>(frames);
        return m_helper.processStereoSamples(interleaved, frames);
    }

    int finalize() {
        if (!m_ready) {
            return 0;
        }
        m_helper.finalize();
        return calculateGlobalKey();
    }

  private:
    static constexpr float kTuningFrequencyHertz = 440.0f;

    bool handleWindow(double* pWindow) {
        const int key = m_keyMode->process(pWindow);
        if (key <= 0 || key > 24) {
            return false;
        }
        if (key != m_prevKey) {
            m_keyChanges.push_back({ key, m_currentFrame });
            m_prevKey = key;
        }
        return true;
    }

    int calculateGlobalKey() const {
        if (m_keyChanges.empty()) {
            return 0;
        }
        if (m_keyChanges.size() == 1) {
            return m_keyChanges.front().key;
        }

        std::array<double, 25> histogram{};
        const std::int64_t totalFrames = m_currentFrame;

        for (std::size_t i = 0; i < m_keyChanges.size(); ++i) {
            const int key = m_keyChanges[i].key;
            const double start = static_cast<double>(m_keyChanges[i].frame);
            const double next = (i + 1 < m_keyChanges.size())
                    ? static_cast<double>(m_keyChanges[i + 1].frame)
                    : static_cast<double>(totalFrames);
            const double duration = next - start;
            if (key > 0 && key < static_cast<int>(histogram.size()) && duration > 0) {
                histogram[static_cast<std::size_t>(key)] += duration;
            }
        }

        int maxKey = 0;
        double maxValue = 0.0;
        for (std::size_t key = 1; key < histogram.size(); ++key) {
            if (histogram[key] > maxValue) {
                maxValue = histogram[key];
                maxKey = static_cast<int>(key);
            }
        }
        return maxKey;
    }

    bool m_ready = false;
    std::unique_ptr<GetKeyMode> m_keyMode;
    DownmixAndOverlapHelper m_helper;
    std::vector<KeyChange> m_keyChanges;
    int m_prevKey;
    std::int64_t m_currentFrame;
};

} // namespace

extern "C" {

struct QmKeyDetectorHandle {
    QmKeyDetector* detector;
};

QmKeyDetectorHandle* qm_key_create(double sampleRate) {
    auto* handle = new QmKeyDetectorHandle{ nullptr };
    handle->detector = new QmKeyDetector(sampleRate);
    if (!handle->detector->isReady()) {
        delete handle->detector;
        delete handle;
        return nullptr;
    }
    return handle;
}

void qm_key_destroy(QmKeyDetectorHandle* handle) {
    if (!handle) {
        return;
    }
    delete handle->detector;
    delete handle;
}

int qm_key_process(QmKeyDetectorHandle* handle,
        const float* interleaved,
        std::size_t frames,
        int channels) {
    if (!handle || !handle->detector) {
        return 0;
    }
    return handle->detector->process(interleaved, frames, channels) ? 1 : 0;
}

int qm_key_finalize(QmKeyDetectorHandle* handle) {
    if (!handle || !handle->detector) {
        return 0;
    }
    return handle->detector->finalize();
}

} // extern "C"
