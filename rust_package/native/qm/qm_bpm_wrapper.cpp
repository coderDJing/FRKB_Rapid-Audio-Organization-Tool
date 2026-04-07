#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <vector>

#include "dsp/onsets/DetectionFunction.h"
#include "dsp/tempotracking/TempoTrackV2.h"
#include "maths/MathUtilities.h"
#include "qm_downmix_overlap.h"

namespace {

constexpr float kStepSecs = 0.01161f;
constexpr int kMaximumBinSizeHz = 50;

constexpr double kMaxSecsPhaseError = 0.025;
constexpr double kMaxSecsPhaseErrorSum = 0.1;
constexpr int kMaxOutliersCount = 1;
constexpr int kMinRegionBeatCount = 16;

struct ConstRegion {
    double firstBeat;
    double beatLength;
};

struct BeatGridEstimate {
    double bpm = 0.0;
    double beatLength = 0.0;
    double firstBeat = std::numeric_limits<double>::quiet_NaN();

    bool isValid() const {
        return bpm > 0.0 && beatLength > 0.0 &&
                std::isfinite(firstBeat) && firstBeat >= 0.0;
    }
};

DFConfig make_detection_function_config(int stepSizeFrames, int windowSize) {
    DFConfig config;
    config.DFType = DF_COMPLEXSD;
    config.stepSize = stepSizeFrames;
    config.frameLength = windowSize;
    config.dbRise = 3;
    config.adaptiveWhitening = false;
    config.whiteningRelaxCoeff = -1;
    config.whiteningFloor = -1;
    return config;
}

double calculate_average_bpm(int numberOfBeats, double sampleRate, double lowerFrame, double upperFrame) {
    const double frames = upperFrame - lowerFrame;
    if (frames <= 0 || numberOfBeats < 1) {
        return 0.0;
    }
    return 60.0 * numberOfBeats * sampleRate / frames;
}

double normalize_first_beat(double firstBeat, double beatLength) {
    if (!std::isfinite(firstBeat) || !std::isfinite(beatLength) || beatLength <= 0.0) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    double normalized = std::fmod(firstBeat, beatLength);
    if (normalized < 0.0) {
        normalized += beatLength;
    }
    if (normalized >= beatLength) {
        normalized = std::fmod(normalized, beatLength);
    }
    return normalized;
}

// Adapted from Mixxx BeatUtils/BeatFactory: the BPM estimate may stay raw,
// but the anchor beat should be folded back near track start and phase-fitted
// against all detected beats instead of blindly taking the first detected beat.
double adjust_phase(double firstBeat,
        double beatLength,
        const std::vector<double>& beats,
        double sampleRate) {
    const double normalizedFirstBeat = normalize_first_beat(firstBeat, beatLength);
    if (!std::isfinite(normalizedFirstBeat) || beats.empty() || sampleRate <= 0.0) {
        return normalizedFirstBeat;
    }

    double offsetAdjust = 0.0;
    int offsetAdjustCount = 0;
    for (double beat : beats) {
        if (!std::isfinite(beat)) {
            continue;
        }
        double offset = std::fmod(beat - normalizedFirstBeat, beatLength);
        if (offset < 0.0) {
            offset += beatLength;
        }
        if (offset > beatLength / 2.0) {
            offset -= beatLength;
        }
        if (std::fabs(offset) < (kMaxSecsPhaseError * sampleRate)) {
            offsetAdjust += offset;
            offsetAdjustCount++;
        }
    }

    if (offsetAdjustCount <= 0) {
        return normalizedFirstBeat;
    }

    return normalize_first_beat(
            normalizedFirstBeat + (offsetAdjust / offsetAdjustCount),
            beatLength);
}

std::vector<ConstRegion> retrieve_const_regions(const std::vector<double>& coarseBeats, double sampleRate) {
    if (coarseBeats.size() < 2) {
        return {};
    }

    const double maxPhaseError = kMaxSecsPhaseError * sampleRate;
    const double maxPhaseErrorSum = kMaxSecsPhaseErrorSum * sampleRate;

    int leftIndex = 0;
    int rightIndex = static_cast<int>(coarseBeats.size()) - 1;
    std::vector<ConstRegion> constantRegions;

    while (leftIndex < static_cast<int>(coarseBeats.size()) - 1) {
        const double meanBeatLength =
                (coarseBeats[rightIndex] - coarseBeats[leftIndex]) /
                (rightIndex - leftIndex);
        int outliersCount = 0;
        double ironedBeat = coarseBeats[leftIndex];
        double phaseErrorSum = 0.0;
        int i = leftIndex + 1;
        for (; i <= rightIndex; ++i) {
            ironedBeat += meanBeatLength;
            const double phaseError = ironedBeat - coarseBeats[i];
            phaseErrorSum += phaseError;
            if (std::fabs(phaseError) > maxPhaseError) {
                outliersCount++;
                if (outliersCount > kMaxOutliersCount || i == leftIndex + 1) {
                    break;
                }
            }
            if (std::fabs(phaseErrorSum) > maxPhaseErrorSum) {
                break;
            }
        }
        if (i > rightIndex) {
            double regionBorderError = 0.0;
            if (rightIndex > leftIndex + 2) {
                const double firstBeatLength = coarseBeats[leftIndex + 1] - coarseBeats[leftIndex];
                const double lastBeatLength = coarseBeats[rightIndex] - coarseBeats[rightIndex - 1];
                regionBorderError = std::fabs(firstBeatLength + lastBeatLength - (2 * meanBeatLength));
            }
            if (regionBorderError < maxPhaseError / 2) {
                constantRegions.push_back({coarseBeats[leftIndex], meanBeatLength});
                leftIndex = rightIndex;
                rightIndex = static_cast<int>(coarseBeats.size()) - 1;
                continue;
            }
        }
        rightIndex--;
    }

    constantRegions.push_back({coarseBeats.back(), 0.0});
    return constantRegions;
}

BeatGridEstimate make_const_grid(const std::vector<ConstRegion>& constantRegions, double sampleRate) {
    if (constantRegions.empty()) {
        return {};
    }

    int midRegionIndex = 0;
    double longestRegionLength = 0.0;
    double longestRegionBeatLength = 0.0;
    for (int i = 0; i < static_cast<int>(constantRegions.size()) - 1; ++i) {
        const double length = constantRegions[i + 1].firstBeat - constantRegions[i].firstBeat;
        if (length > longestRegionLength) {
            longestRegionLength = length;
            longestRegionBeatLength = constantRegions[i].beatLength;
            midRegionIndex = i;
        }
    }

    if (longestRegionLength == 0.0 || longestRegionBeatLength == 0.0) {
        return {};
    }

    int longestRegionNumberOfBeats = static_cast<int>(
            (longestRegionLength / longestRegionBeatLength) + 0.5);
    double longestRegionBeatLengthMin = longestRegionBeatLength -
            ((kMaxSecsPhaseError * sampleRate) / longestRegionNumberOfBeats);
    double longestRegionBeatLengthMax = longestRegionBeatLength +
            ((kMaxSecsPhaseError * sampleRate) / longestRegionNumberOfBeats);

    int startRegionIndex = midRegionIndex;

    for (int i = 0; i < midRegionIndex; ++i) {
        const double length = constantRegions[i + 1].firstBeat - constantRegions[i].firstBeat;
        const int numberOfBeats = static_cast<int>((length / constantRegions[i].beatLength) + 0.5);
        if (numberOfBeats < kMinRegionBeatCount) {
            continue;
        }
        const double thisRegionBeatLengthMin = constantRegions[i].beatLength -
                ((kMaxSecsPhaseError * sampleRate) / numberOfBeats);
        const double thisRegionBeatLengthMax = constantRegions[i].beatLength +
                ((kMaxSecsPhaseError * sampleRate) / numberOfBeats);
        if (longestRegionBeatLength > thisRegionBeatLengthMin &&
                longestRegionBeatLength < thisRegionBeatLengthMax) {
            const double newLongestRegionLength =
                    constantRegions[midRegionIndex + 1].firstBeat -
                    constantRegions[i].firstBeat;

            const double beatLengthMin = std::max(longestRegionBeatLengthMin, thisRegionBeatLengthMin);
            const double beatLengthMax = std::min(longestRegionBeatLengthMax, thisRegionBeatLengthMax);

            const int maxNumberOfBeats =
                    static_cast<int>(std::round(newLongestRegionLength / beatLengthMin));
            const int minNumberOfBeats =
                    static_cast<int>(std::round(newLongestRegionLength / beatLengthMax));

            if (minNumberOfBeats != maxNumberOfBeats) {
                continue;
            }
            const int numberOfBeats = minNumberOfBeats;
            const double newBeatLength = newLongestRegionLength / numberOfBeats;
            if (newBeatLength > longestRegionBeatLengthMin &&
                    newBeatLength < longestRegionBeatLengthMax) {
                longestRegionLength = newLongestRegionLength;
                longestRegionBeatLength = newBeatLength;
                longestRegionNumberOfBeats = numberOfBeats;
                longestRegionBeatLengthMin = longestRegionBeatLength -
                        ((kMaxSecsPhaseError * sampleRate) / longestRegionNumberOfBeats);
                longestRegionBeatLengthMax = longestRegionBeatLength +
                        ((kMaxSecsPhaseError * sampleRate) / longestRegionNumberOfBeats);
                startRegionIndex = i;
                break;
            }
        }
    }

    for (int i = static_cast<int>(constantRegions.size()) - 2; i > midRegionIndex; --i) {
        const double length = constantRegions[i + 1].firstBeat - constantRegions[i].firstBeat;
        const int numberOfBeats = static_cast<int>((length / constantRegions[i].beatLength) + 0.5);
        if (numberOfBeats < kMinRegionBeatCount) {
            continue;
        }
        const double thisRegionBeatLengthMin = constantRegions[i].beatLength -
                ((kMaxSecsPhaseError * sampleRate) / numberOfBeats);
        const double thisRegionBeatLengthMax = constantRegions[i].beatLength +
                ((kMaxSecsPhaseError * sampleRate) / numberOfBeats);
        if (longestRegionBeatLength > thisRegionBeatLengthMin &&
                longestRegionBeatLength < thisRegionBeatLengthMax) {
            const double newLongestRegionLength =
                    constantRegions[i + 1].firstBeat -
                    constantRegions[startRegionIndex].firstBeat;

            const double minBeatLength = std::max(longestRegionBeatLengthMin, thisRegionBeatLengthMin);
            const double maxBeatLength = std::min(longestRegionBeatLengthMax, thisRegionBeatLengthMax);

            const int maxNumberOfBeats =
                    static_cast<int>(std::round(newLongestRegionLength / minBeatLength));
            const int minNumberOfBeats =
                    static_cast<int>(std::round(newLongestRegionLength / maxBeatLength));

            if (minNumberOfBeats != maxNumberOfBeats) {
                continue;
            }
            const int numberOfBeats = minNumberOfBeats;
            const double newBeatLength = newLongestRegionLength / numberOfBeats;
            if (newBeatLength > longestRegionBeatLengthMin &&
                    newBeatLength < longestRegionBeatLengthMax) {
                longestRegionLength = newLongestRegionLength;
                longestRegionBeatLength = newBeatLength;
                longestRegionNumberOfBeats = numberOfBeats;
                break;
            }
        }
    }

    longestRegionBeatLengthMin = longestRegionBeatLength -
            ((kMaxSecsPhaseError * sampleRate) / longestRegionNumberOfBeats);
    longestRegionBeatLengthMax = longestRegionBeatLength +
            ((kMaxSecsPhaseError * sampleRate) / longestRegionNumberOfBeats);

    const double centerBpm = 60.0 * sampleRate / longestRegionBeatLength;

    // Keep the raw tempo estimate for downstream grid math instead of snapping it to
    // "nice" BPM values like integers or coarse fractions.
    return {
        centerBpm,
        longestRegionBeatLength,
        normalize_first_beat(constantRegions[startRegionIndex].firstBeat, longestRegionBeatLength)
    };
}

BeatGridEstimate calculate_beat_grid(const std::vector<double>& beats, double sampleRate) {
    if (beats.size() < 2 || sampleRate <= 0.0) {
        return {};
    }

    if (beats.size() < kMinRegionBeatCount || beats.front() >= beats.back()) {
        const double bpm = calculate_average_bpm(static_cast<int>(beats.size()) - 1,
                sampleRate,
                beats.front(),
                beats.back());
        if (bpm <= 0.0) {
            return {};
        }
        const double beatLength = (beats.back() - beats.front()) /
                static_cast<double>(beats.size() - 1);
        const double firstBeat = adjust_phase(beats.front(), beatLength, beats, sampleRate);
        return {bpm, beatLength, firstBeat};
    }

    const auto constantRegions = retrieve_const_regions(beats, sampleRate);
    auto estimate = make_const_grid(constantRegions, sampleRate);
    if (!estimate.isValid()) {
        const double bpm = calculate_average_bpm(static_cast<int>(beats.size()) - 1,
                sampleRate,
                beats.front(),
                beats.back());
        if (bpm <= 0.0) {
            return {};
        }
        const double beatLength = (beats.back() - beats.front()) /
                static_cast<double>(beats.size() - 1);
        const double firstBeat = adjust_phase(beats.front(), beatLength, beats, sampleRate);
        return {bpm, beatLength, firstBeat};
    }
    estimate.firstBeat = adjust_phase(
            estimate.firstBeat,
            estimate.beatLength,
            beats,
            sampleRate);
    return estimate;
}

} // namespace

class QmBpmDetector {
  public:
    explicit QmBpmDetector(double sampleRate)
            : m_sampleRate(sampleRate) {
        m_stepSizeFrames = static_cast<int>(m_sampleRate * kStepSecs);
        m_windowSize = MathUtilities::nextPowerOfTwo(
                static_cast<int>(m_sampleRate / kMaximumBinSizeHz));
        m_detectionFunction = std::make_unique<DetectionFunction>(
                make_detection_function_config(m_stepSizeFrames, m_windowSize));
        m_ready = m_helper.initialize(
                static_cast<std::size_t>(m_windowSize),
                static_cast<std::size_t>(m_stepSizeFrames),
                [this](double* pWindow, std::size_t) {
                    m_detectionResults.push_back(
                            m_detectionFunction->processTimeDomain(pWindow));
                    return true;
                });
    }

    bool isReady() const {
        return m_ready;
    }

    bool process(const float* interleaved, std::size_t frames, int channels) {
        if (!m_ready || !interleaved || channels != 2) {
            return false;
        }
        return m_helper.processStereoSamples(interleaved, frames);
    }

    double finalize() {
        m_firstBeatFrame = std::numeric_limits<double>::quiet_NaN();
        if (!m_ready) {
            return 0.0;
        }
        m_helper.finalize();

        std::size_t nonZeroCount = m_detectionResults.size();
        while (nonZeroCount > 0 && m_detectionResults.at(nonZeroCount - 1) <= 0.0) {
            --nonZeroCount;
        }
        if (nonZeroCount < 3) {
            return 0.0;
        }

        const std::size_t requiredSize = std::max(static_cast<std::size_t>(2), nonZeroCount) - 2;

        std::vector<double> df;
        df.reserve(requiredSize);
        std::vector<int> beatPeriod(requiredSize / 128 + 1);

        for (std::size_t i = 2; i < nonZeroCount; ++i) {
            df.push_back(m_detectionResults.at(i));
        }

        TempoTrackV2 tt(static_cast<float>(m_sampleRate), m_stepSizeFrames);
        tt.calculateBeatPeriod(df, beatPeriod);

        std::vector<double> beats;
        tt.calculateBeats(df, beatPeriod, beats);

        std::vector<double> beatPositions;
        beatPositions.reserve(beats.size());
        for (double beat : beats) {
            beatPositions.push_back((beat * m_stepSizeFrames) + m_stepSizeFrames / 2.0);
        }
        const auto estimate = calculate_beat_grid(beatPositions, m_sampleRate);
        if (estimate.isValid()) {
            m_firstBeatFrame = estimate.firstBeat;
            return estimate.bpm;
        }
        if (!beatPositions.empty()) {
            m_firstBeatFrame = beatPositions.front();
        }
        return 0.0;
    }

    double firstBeatFrame() const {
        return m_firstBeatFrame;
    }

  private:
    bool m_ready = false;
    double m_sampleRate = 0.0;
    int m_windowSize = 0;
    int m_stepSizeFrames = 0;
    std::unique_ptr<DetectionFunction> m_detectionFunction;
    DownmixAndOverlapHelper m_helper;
    std::vector<double> m_detectionResults;
    double m_firstBeatFrame = std::numeric_limits<double>::quiet_NaN();
};

extern "C" {

struct QmBpmDetectorHandle {
    QmBpmDetector* detector;
};

QmBpmDetectorHandle* qm_bpm_create(double sampleRate) {
    auto* handle = new QmBpmDetectorHandle{ nullptr };
    handle->detector = new QmBpmDetector(sampleRate);
    if (!handle->detector->isReady()) {
        delete handle->detector;
        delete handle;
        return nullptr;
    }
    return handle;
}

void qm_bpm_destroy(QmBpmDetectorHandle* handle) {
    if (!handle) {
        return;
    }
    delete handle->detector;
    delete handle;
}

int qm_bpm_process(QmBpmDetectorHandle* handle,
        const float* interleaved,
        std::size_t frames,
        int channels) {
    if (!handle || !handle->detector) {
        return 0;
    }
    return handle->detector->process(interleaved, frames, channels) ? 1 : 0;
}

double qm_bpm_finalize(QmBpmDetectorHandle* handle) {
    if (!handle || !handle->detector) {
        return 0.0;
    }
    return handle->detector->finalize();
}

double qm_bpm_first_beat_frame(QmBpmDetectorHandle* handle) {
    if (!handle || !handle->detector) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    return handle->detector->firstBeatFrame();
}

} // extern "C"
