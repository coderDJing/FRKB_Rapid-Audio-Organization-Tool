#pragma once

#include <algorithm>
#include <cstddef>
#include <functional>
#include <vector>

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
        // First frame centered into the window for stable onset detection.
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
