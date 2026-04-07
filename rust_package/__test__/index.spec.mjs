import test from 'ava'

import rustPackage from '../index.js'

const { analyzeKeyAndBpmFromPcm } = rustPackage

const createClickTrackBuffer = ({
  sampleRate,
  channels,
  durationSec,
  bpm,
  firstPulseSec,
  pulseSec = 0.02
}) => {
  const frames = Math.floor(sampleRate * durationSec)
  const beatSec = 60 / bpm
  const pcm = new Float32Array(frames * channels)

  for (let frame = 0; frame < frames; frame += 1) {
    const timeSec = frame / sampleRate
    const relativeBeat = (timeSec - firstPulseSec) / beatSec
    const nearestBeat = Math.round(relativeBeat)
    const pulseStartSec = firstPulseSec + nearestBeat * beatSec
    const isPulse =
      pulseStartSec >= firstPulseSec &&
      timeSec >= pulseStartSec &&
      timeSec < pulseStartSec + pulseSec
    const value = isPulse ? 0.9 * Math.exp(-(timeSec - pulseStartSec) * 30) : 0

    for (let channel = 0; channel < channels; channel += 1) {
      pcm[frame * channels + channel] = value
    }
  }

  return Buffer.from(pcm.buffer)
}

test('native exports beat analysis entrypoint', (t) => {
  t.is(typeof analyzeKeyAndBpmFromPcm, 'function')
})

test('analyzeKeyAndBpmFromPcm folds the beat anchor near track start', (t) => {
  const sampleRate = 44100
  const channels = 2
  const bpm = 120
  const firstPulseSec = 2.25
  const beatMs = 60000 / bpm
  const expectedAnchorMs = (firstPulseSec % (60 / bpm)) * 1000

  const result = analyzeKeyAndBpmFromPcm(
    createClickTrackBuffer({
      sampleRate,
      channels,
      durationSec: 30,
      bpm,
      firstPulseSec
    }),
    sampleRate,
    channels,
    false
  )

  t.true(Math.abs(result.bpm - bpm) < 0.5)
  t.true(Number.isFinite(result.firstBeatMs))
  t.true(result.firstBeatMs < 1000)
  t.true(Math.abs(result.firstBeatMs - expectedAnchorMs) < beatMs * 0.2)
})
