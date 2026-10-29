import { useCallback, useEffect, useRef, useState } from 'react'

// ─── Colores y constantes ────────────────────────────────────────────────────
const NEON = { cyan: '#19f0ff', magenta: '#ff2bd6', green: '#3dff8e', amber: '#ffb020' }
const DECK_COLOR = { A: NEON.cyan, B: NEON.magenta }
const SR = 44100
const BPM = 124
const BEAT = 60 / BPM
const BAR = BEAT * 4
const MAX_PAD_SECONDS = 20

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const mtof = (m) => 440 * 2 ** ((m - 69) / 12)
const fmt = (t) => {
  if (!Number.isFinite(t) || t < 0) t = 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const d = Math.floor((t * 10) % 10)
  return `${m}:${String(s).padStart(2, '0')}.${d}`
}

// ─── Síntesis offline: pistas demo y sonidos del sampler ────────────────────
async function render(seconds, build) {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR)
  build(ctx, ctx.destination)
  return ctx.startRendering()
}

function normalize(buffer, peak = 0.9) {
  let max = 0
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c)
    for (let i = 0; i < d.length; i++) max = Math.max(max, Math.abs(d[i]))
  }
  if (max > 0) {
    const k = peak / max
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c)
      for (let i = 0; i < d.length; i++) d[i] *= k
    }
  }
  return buffer
}

function noiseBuffer(ctx, seconds = 1) {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate)
  const d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  return b
}

function distCurve(k) {
  const n = 1024
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x))
  }
  return c
}

function env(param, t, peak, attack, decay) {
  param.setValueAtTime(0.0001, t)
  param.linearRampToValueAtTime(peak, t + attack)
  param.exponentialRampToValueAtTime(0.0001, t + attack + decay)
}

function filter(ctx, type, freq, Q = 1) {
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = Q
  return f
}

function kick(ctx, out, t, amp = 0.9) {
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.frequency.setValueAtTime(165, t)
  o.frequency.exponentialRampToValueAtTime(46, t + 0.11)
  env(g.gain, t, amp, 0.002, 0.42)
  o.connect(g).connect(out)
  o.start(t)
  o.stop(t + 0.5)
}

function hat(ctx, out, t, nb, amp = 0.2, decay = 0.045) {
  const s = ctx.createBufferSource()
  s.buffer = nb
  const g = ctx.createGain()
  env(g.gain, t, amp, 0.001, decay)
  s.connect(filter(ctx, 'highpass', 7600)).connect(g).connect(out)
  s.start(t, Math.random() * 0.5)
  s.stop(t + decay + 0.05)
}

function clap(ctx, out, t, nb, amp = 0.45) {
  const s = ctx.createBufferSource()
  s.buffer = nb
  const g = ctx.createGain()
  g.gain.setValueAtTime(0, t)
  for (const k of [0, 0.011, 0.022]) {
    g.gain.setValueAtTime(amp, t + k)
    g.gain.exponentialRampToValueAtTime(amp * 0.15, t + k + 0.01)
  }
  g.gain.setValueAtTime(amp, t + 0.033)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26)
  s.connect(filter(ctx, 'bandpass', 1350, 1.1)).connect(g).connect(out)
  s.start(t, Math.random() * 0.5)
  s.stop(t + 0.3)
}

function bass(ctx, out, t, midi, len, amp = 0.32, cutoff = 900) {
  const o = ctx.createOscillator()
  o.type = 'sawtooth'
  o.frequency.value = mtof(midi)
  const f = filter(ctx, 'lowpass', cutoff, 7)
  f.frequency.setValueAtTime(cutoff, t)
  f.frequency.exponentialRampToValueAtTime(170, t + len)
  const g = ctx.createGain()
  env(g.gain, t, amp, 0.004, len)
  o.connect(f).connect(g).connect(out)
  o.start(t)
  o.stop(t + len + 0.05)
}

function stab(ctx, out, t, notes, len, amp = 0.12, cutoff = 2400) {
  const f = filter(ctx, 'lowpass', cutoff, 3)
  f.frequency.setValueAtTime(cutoff, t)
  f.frequency.exponentialRampToValueAtTime(500, t + len)
  const g = ctx.createGain()
  env(g.gain, t, amp, 0.005, len)
  f.connect(g).connect(out)
  for (const n of notes) {
    for (const det of [-8, 8]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = mtof(n)
      o.detune.value = det
      o.connect(f)
      o.start(t)
      o.stop(t + len + 0.05)
    }
  }
}

function pad(ctx, out, t, notes, len, amp = 0.05) {
  const f = filter(ctx, 'lowpass', 1100, 1)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(amp, t + len * 0.4)
  g.gain.linearRampToValueAtTime(0.0001, t + len)
  f.connect(g).connect(out)
  for (const n of notes) {
    for (const det of [-12, 0, 12]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = mtof(n)
      o.detune.value = det
      o.connect(f)
      o.start(t)
      o.stop(t + len + 0.05)
    }
  }
}

function pluck(ctx, out, t, midi, amp = 0.1) {
  const o = ctx.createOscillator()
  o.type = 'square'
  o.frequency.value = mtof(midi)
  const f = filter(ctx, 'lowpass', 3200, 4)
  f.frequency.setValueAtTime(3200, t)
  f.frequency.exponentialRampToValueAtTime(400, t + 0.18)
  const g = ctx.createGain()
  env(g.gain, t, amp, 0.002, 0.2)
  o.connect(f).connect(g).connect(out)
  o.start(t)
  o.stop(t + 0.25)
}

function echoBus(ctx, out, time = BEAT * 0.75, feedback = 0.38, send = 0.35) {
  const input = ctx.createGain()
  input.gain.value = send
  const d = ctx.createDelay(2)
  d.delayTime.value = time
  const fb = ctx.createGain()
  fb.gain.value = feedback
  const tone = filter(ctx, 'lowpass', 2600)
  input.connect(d).connect(tone).connect(fb).connect(d)
  tone.connect(out)
  return input
}

// Pista demo A: "Neón Nocturno" · 124 BPM · La menor
function demoA() {
  const bars = 16
  return render(bars * BAR + 1.2, (ctx, dest) => {
    const out = ctx.createGain()
    out.gain.value = 0.8
    out.connect(dest)
    const echo = echoBus(ctx, out)
    const nb = noiseBuffer(ctx)
    const prog = [
      { root: 45, chord: [57, 60, 64] },
      { root: 41, chord: [57, 60, 65] },
      { root: 48, chord: [55, 60, 64] },
      { root: 43, chord: [55, 59, 62] },
    ]
    for (let b = 0; b < bars; b++) {
      const { root, chord } = prog[Math.floor(b / 2) % 4]
      for (let k = 0; k < 4; k++) {
        const t = b * BAR + k * BEAT
        kick(ctx, out, t)
        hat(ctx, out, t + BEAT / 2, nb, b >= 2 ? 0.22 : 0.14, b >= 2 ? 0.16 : 0.05)
        if (b >= 4) {
          hat(ctx, out, t + BEAT / 4, nb, 0.06)
          hat(ctx, out, t + (BEAT * 3) / 4, nb, 0.06)
        }
        if (b >= 4 && k % 2 === 1) clap(ctx, out, t, nb)
        if (b >= 2) bass(ctx, out, t + BEAT / 2, root, BEAT * 0.42)
      }
      if (b >= 4) {
        for (const p of [1.5, 3.5]) {
          const t = b * BAR + p * BEAT
          stab(ctx, out, t, chord, 0.22)
          stab(ctx, echo, t, chord, 0.22)
        }
      }
      if (b >= 10) {
        for (let s = 0; s < 16; s++) {
          const note = chord[s % 3] + 12
          pluck(ctx, s % 4 === 2 ? echo : out, b * BAR + (s * BEAT) / 4, note, 0.05)
        }
      }
    }
  })
}

// Pista demo B: "Carbón 124" · 124 BPM · La menor (relativo)
function demoB() {
  const bars = 16
  return render(bars * BAR + 1.5, (ctx, dest) => {
    const out = ctx.createGain()
    out.gain.value = 0.8
    out.connect(dest)
    const echo = echoBus(ctx, out, BEAT * 0.5, 0.42, 0.4)
    const nb = noiseBuffer(ctx)
    const prog = [
      { root: 38, chord: [62, 65, 69] },
      { root: 45, chord: [57, 60, 64] },
      { root: 41, chord: [57, 60, 65] },
      { root: 40, chord: [55, 59, 64] },
    ]
    const accent = [0.12, 0.05, 0.08, 0.05]
    for (let b = 0; b < bars; b++) {
      const { root, chord } = prog[Math.floor(b / 2) % 4]
      if (b >= 4 && b % 2 === 0) pad(ctx, out, b * BAR, chord, BAR * 2)
      for (let k = 0; k < 4; k++) {
        const t = b * BAR + k * BEAT
        kick(ctx, out, t, 0.95)
        for (let s = 0; s < 4; s++) hat(ctx, out, t + (s * BEAT) / 4, nb, accent[s])
        if (b >= 4) hat(ctx, out, t + BEAT / 2, nb, 0.16, 0.2)
        if (b >= 2 && k % 2 === 1) clap(ctx, out, t, nb, 0.5)
        if (b >= 2) {
          for (let s = 1; s < 4; s++) {
            bass(ctx, out, t + (s * BEAT) / 4, root + (s === 3 ? 12 : 0), BEAT * 0.2, 0.26, 700)
          }
        }
      }
      if (b >= 8) {
        const arp = [0, 1, 2, 1, 2, 0, 2, 1]
        for (let s = 0; s < 8; s++) {
          pluck(ctx, echo, b * BAR + (s * BEAT) / 2, chord[arp[s]] + 12, 0.07)
        }
      }
    }
  })
}

// Sonidos del sampler
function sAirHorn() {
  return render(1.7, (ctx, out) => {
    const ws = ctx.createWaveShaper()
    ws.curve = distCurve(8)
    const lp = filter(ctx, 'lowpass', 3200)
    ws.connect(lp).connect(out)
    for (const [t, len] of [[0, 0.13], [0.19, 0.13], [0.38, 1.1]]) {
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.5, t + 0.012)
      g.gain.setValueAtTime(0.5, t + len - 0.05)
      g.gain.linearRampToValueAtTime(0, t + len)
      g.connect(ws)
      for (const f of [415, 420.5, 523, 527.5]) {
        const o = ctx.createOscillator()
        o.type = 'sawtooth'
        o.frequency.setValueAtTime(f, t)
        if (len > 0.5) {
          o.frequency.setValueAtTime(f, t + len - 0.3)
          o.frequency.linearRampToValueAtTime(f * 0.92, t + len)
        }
        o.connect(g)
        o.start(t)
        o.stop(t + len + 0.02)
      }
    }
  }).then(normalize)
}

function sScratch() {
  return render(1.0, (ctx, out) => {
    const N = 400
    const dur = 0.9
    const strokes = 4
    const v = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const x = (i / N) * strokes
      const s = Math.floor(x)
      const p = x - s
      v[i] = Math.sin(Math.PI * p) ** 0.7 * (s % 2 ? 0.75 : 1.2)
    }
    const o = ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.setValueCurveAtTime(v.map((x) => 40 + 280 * x), 0, dur)
    const n = ctx.createBufferSource()
    n.buffer = noiseBuffer(ctx, 1)
    const bp1 = filter(ctx, 'bandpass', 800, 3)
    const bp2 = filter(ctx, 'bandpass', 1600, 4)
    bp1.frequency.setValueCurveAtTime(v.map((x) => 250 + 1500 * x), 0, dur)
    bp2.frequency.setValueCurveAtTime(v.map((x) => 600 + 3200 * x), 0, dur)
    const g = ctx.createGain()
    g.gain.setValueCurveAtTime(v.map((x) => Math.min(1, x * 1.5)), 0, dur)
    const og = ctx.createGain()
    og.gain.value = 0.6
    const ng = ctx.createGain()
    ng.gain.value = 0.5
    const ws = ctx.createWaveShaper()
    ws.curve = distCurve(4)
    o.connect(og)
    n.connect(ng)
    for (const bp of [bp1, bp2]) {
      og.connect(bp)
      ng.connect(bp)
      bp.connect(g)
    }
    g.connect(ws).connect(out)
    o.start(0)
    o.stop(dur)
    n.start(0)
    n.stop(dur)
  }).then(normalize)
}

function sRewind() {
  return render(1.5, (ctx, out) => {
    const o = ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.setValueAtTime(220, 0)
    o.frequency.exponentialRampToValueAtTime(950, 0.25)
    o.frequency.exponentialRampToValueAtTime(55, 1.4)
    const n = ctx.createBufferSource()
    n.buffer = noiseBuffer(ctx, 1.5)
    const bp = filter(ctx, 'bandpass', 1200, 2)
    bp.frequency.setValueAtTime(700, 0)
    bp.frequency.exponentialRampToValueAtTime(3000, 0.25)
    bp.frequency.exponentialRampToValueAtTime(180, 1.4)
    const trem = ctx.createGain()
    trem.gain.value = 0.5
    const lfo = ctx.createOscillator()
    lfo.type = 'square'
    lfo.frequency.setValueAtTime(26, 0)
    lfo.frequency.linearRampToValueAtTime(9, 1.4)
    const lfoG = ctx.createGain()
    lfoG.gain.value = 0.5
    lfo.connect(lfoG).connect(trem.gain)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, 0)
    g.gain.linearRampToValueAtTime(0.9, 0.05)
    g.gain.setValueAtTime(0.9, 1.0)
    g.gain.exponentialRampToValueAtTime(0.0001, 1.42)
    const og = ctx.createGain()
    og.gain.value = 0.5
    o.connect(og).connect(trem)
    n.connect(bp).connect(trem)
    trem.connect(g).connect(out)
    for (const s of [o, n, lfo]) {
      s.start(0)
      s.stop(1.45)
    }
  }).then(normalize)
}

function sSiren() {
  return render(2.2, (ctx, out) => {
    const o = ctx.createOscillator()
    o.type = 'square'
    o.frequency.setValueAtTime(520, 0)
    o.frequency.linearRampToValueAtTime(820, 1.6)
    const lfo = ctx.createOscillator()
    lfo.type = 'triangle'
    lfo.frequency.value = 5
    const lfoG = ctx.createGain()
    lfoG.gain.value = 300
    lfo.connect(lfoG).connect(o.frequency)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, 0)
    g.gain.linearRampToValueAtTime(0.4, 0.03)
    g.gain.setValueAtTime(0.4, 1.5)
    g.gain.exponentialRampToValueAtTime(0.0001, 1.65)
    const echo = echoBus(ctx, out, 0.18, 0.4, 0.5)
    o.connect(filter(ctx, 'lowpass', 2600)).connect(g)
    g.connect(out)
    g.connect(echo)
    for (const s of [o, lfo]) {
      s.start(0)
      s.stop(1.7)
    }
  }).then(normalize)
}

function sLaser() {
  return render(1.1, (ctx, out) => {
    const echo = echoBus(ctx, out, 0.12, 0.35, 0.4)
    for (let i = 0; i < 3; i++) {
      const t = i * 0.16
      const o = ctx.createOscillator()
      o.type = 'square'
      o.frequency.setValueAtTime(2600, t)
      o.frequency.exponentialRampToValueAtTime(110, t + 0.2)
      const g = ctx.createGain()
      env(g.gain, t, 0.35, 0.002, 0.22)
      o.connect(g)
      g.connect(out)
      g.connect(echo)
      o.start(t)
      o.stop(t + 0.25)
    }
  }).then(normalize)
}

function sDrop() {
  return render(2.4, (ctx, out) => {
    const o = ctx.createOscillator()
    o.frequency.setValueAtTime(170, 0)
    o.frequency.exponentialRampToValueAtTime(44, 0.35)
    const g = ctx.createGain()
    env(g.gain, 0, 1, 0.004, 2.1)
    const ws = ctx.createWaveShaper()
    ws.curve = distCurve(2.5)
    o.connect(g).connect(ws).connect(out)
    o.start(0)
    o.stop(2.3)
    const n = ctx.createBufferSource()
    n.buffer = noiseBuffer(ctx, 0.1)
    const ng = ctx.createGain()
    env(ng.gain, 0, 0.4, 0.001, 0.03)
    n.connect(filter(ctx, 'highpass', 3000)).connect(ng).connect(out)
    n.start(0)
  }).then(normalize)
}

// Voz sintética: diente de sierra (cuerdas vocales) por filtros de formantes
function voice(ctx, out, { t = 0, dur, f0, formants, amp = 1, vibrato = 0.02, pan = 0 }) {
  const src = ctx.createOscillator()
  src.type = 'sawtooth'
  src.frequency.setValueAtTime(f0[0][1], t)
  for (const [time, f] of f0) src.frequency.linearRampToValueAtTime(f, t + time)
  const lfo = ctx.createOscillator()
  lfo.frequency.value = 5.8
  const lfoG = ctx.createGain()
  lfoG.gain.value = f0[0][1] * vibrato
  lfo.connect(lfoG).connect(src.frequency)
  const vg = ctx.createGain()
  vg.gain.setValueAtTime(0.0001, t)
  vg.gain.linearRampToValueAtTime(amp, t + 0.035)
  vg.gain.setValueAtTime(amp, t + dur * 0.7)
  vg.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  const panner = ctx.createStereoPanner()
  panner.pan.value = pan
  vg.connect(panner).connect(out)
  for (const { from, to, gain, Q } of formants) {
    const bp = filter(ctx, 'bandpass', from, Q)
    bp.frequency.setValueAtTime(from, t)
    bp.frequency.linearRampToValueAtTime(to, t + dur * 0.8)
    const fg = ctx.createGain()
    fg.gain.value = gain
    src.connect(bp).connect(fg).connect(vg)
  }
  for (const s of [src, lfo]) {
    s.start(t)
    s.stop(t + dur + 0.05)
  }
}

function sHey() {
  return render(0.8, (ctx, out) => {
    const bus = ctx.createGain()
    const ws = ctx.createWaveShaper()
    ws.curve = distCurve(1.5)
    bus.connect(ws).connect(out)
    const n = ctx.createBufferSource()
    n.buffer = noiseBuffer(ctx, 0.2)
    const ng = ctx.createGain()
    env(ng.gain, 0, 0.5, 0.01, 0.07)
    n.connect(filter(ctx, 'bandpass', 1800, 0.8)).connect(ng).connect(bus)
    n.start(0)
    const formants = [
      { from: 680, to: 430, gain: 1, Q: 9 },
      { from: 1820, to: 2250, gain: 0.7, Q: 11 },
      { from: 2600, to: 2900, gain: 0.35, Q: 14 },
    ]
    const voices = [
      { k: 1, dt: 0.05, pan: 0 },
      { k: 1.05, dt: 0.062, pan: -0.4 },
      { k: 0.94, dt: 0.07, pan: 0.4 },
      { k: 1.5, dt: 0.058, pan: 0.15 },
    ]
    for (const { k, dt, pan } of voices) {
      voice(ctx, bus, {
        t: dt,
        dur: 0.48,
        f0: [[0, 230 * k], [0.1, 255 * k], [0.45, 175 * k]],
        formants,
        pan,
        amp: k > 1.3 ? 0.5 : 1,
      })
    }
  }).then(normalize)
}

function sWoo() {
  return render(1.35, (ctx, out) => {
    const formants = [
      { from: 320, to: 500, gain: 1, Q: 8 },
      { from: 780, to: 880, gain: 0.55, Q: 10 },
      { from: 2450, to: 2600, gain: 0.18, Q: 14 },
    ]
    const voices = [
      { k: 1, dt: 0, pan: 0 },
      { k: 1.02, dt: 0.03, pan: -0.5 },
      { k: 0.985, dt: 0.05, pan: 0.5 },
      { k: 1.48, dt: 0.02, pan: 0.2 },
    ]
    for (const { k, dt, pan } of voices) {
      voice(ctx, out, {
        t: dt,
        dur: 1.2,
        f0: [[0, 330 * k], [0.2, 650 * k], [0.6, 700 * k], [1.15, 440 * k]],
        formants,
        pan,
        vibrato: 0.025,
        amp: k > 1.3 ? 0.45 : 1,
      })
    }
  }).then(normalize)
}

// Tipo: Hit = magenta, FX = cian, Voz = verde
const PADS = [
  { id: 'horn', name: 'Air Horn', type: 'Hit', color: NEON.magenta, synth: sAirHorn },
  { id: 'scratch', name: 'Scratch', type: 'FX', color: NEON.cyan, synth: sScratch },
  { id: 'hey', name: 'Hey!', type: 'Voz', color: NEON.green, synth: sHey },
  { id: 'woo', name: 'Wooo!', type: 'Voz', color: NEON.green, synth: sWoo },
  { id: 'rewind', name: 'Rewind', type: 'FX', color: NEON.cyan, synth: sRewind },
  { id: 'siren', name: 'Sirena', type: 'Hit', color: NEON.magenta, synth: sSiren },
  { id: 'laser', name: 'Láser', type: 'FX', color: NEON.cyan, synth: sLaser },
  { id: 'drop', name: '808 Drop', type: 'Hit', color: NEON.magenta, synth: sDrop },
]

function computePeaks(buffer, n = 900) {
  const chans = [buffer.getChannelData(0), buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0)]
  const len = chans[0].length
  const size = Math.max(1, Math.floor(len / n))
  const stride = Math.max(1, Math.floor(size / 200))
  const peaks = new Float32Array(n)
  let max = 0
  for (let i = 0; i < n; i++) {
    let m = 0
    const start = i * size
    for (let j = start; j < start + size && j < len; j += stride) {
      const v = Math.max(Math.abs(chans[0][j]), Math.abs(chans[1][j]))
      if (v > m) m = v
    }
    peaks[i] = m
    if (m > max) max = m
  }
  if (max > 0) for (let i = 0; i < n; i++) peaks[i] /= max
  return peaks
}

// Detección de tempo: envolvente de graves → autocorrelación → fase del beat
async function detectTempo(buffer) {
  const sr = 22050
  const hop = 128
  const fps = sr / hop
  const len = Math.min(40, buffer.duration)
  const start = clamp(buffer.duration * 0.15, 0, Math.max(0, buffer.duration - len))
  const off = new OfflineAudioContext(1, Math.ceil(len * sr), sr)
  const src = off.createBufferSource()
  src.buffer = buffer
  src.connect(filter(off, 'lowpass', 160, 0.8)).connect(off.destination)
  src.start(0, start, len)
  const data = (await off.startRendering()).getChannelData(0)
  const frames = Math.floor(data.length / hop)
  const onset = new Float32Array(frames)
  let prev = 0
  for (let i = 0; i < frames; i++) {
    let e = 0
    for (let j = i * hop; j < (i + 1) * hop; j++) e += data[j] * data[j]
    e = Math.log1p(e * 100)
    onset[i] = Math.max(0, e - prev)
    prev = e
  }
  const ac = (lag) => {
    let sum = 0
    for (let i = 0; i + lag < frames; i++) sum += onset[i] * onset[i + lag]
    return sum / (frames - lag)
  }
  let best = 0
  let bestLag = 0
  const minLag = Math.floor((60 * fps) / 180)
  const maxLag = Math.ceil((60 * fps) / 70)
  const scores = []
  for (let lag = minLag; lag <= maxLag; lag++) {
    const score = ac(lag) + 0.5 * ac(lag * 2) + 0.25 * ac(Math.round(lag / 2))
    scores[lag] = score
    if (score > best) {
      best = score
      bestLag = lag
    }
  }
  if (!best) return null
  // Interpolación parabólica para afinar el periodo
  const y0 = scores[bestLag - 1] ?? best
  const y2 = scores[bestLag + 1] ?? best
  const denom = y0 - 2 * best + y2
  const lag = bestLag + (denom ? (0.5 * (y0 - y2)) / denom : 0)
  let bpm = (60 * fps) / lag
  while (bpm < 85) bpm *= 2
  while (bpm >= 175) bpm /= 2
  const period = (60 * fps) / bpm
  let bestPhase = 0
  let bestSum = -1
  for (let ph = 0; ph < period; ph++) {
    let sum = 0
    for (let t = ph; t < frames; t += period) sum += onset[Math.round(t)] || 0
    if (sum > bestSum) {
      bestSum = sum
      bestPhase = ph
    }
  }
  return { bpm: Math.round(bpm * 10) / 10, offset: start + bestPhase / fps }
}

// ─── Motor de audio ──────────────────────────────────────────────────────────
class Engine {
  constructor() {
    const AC = window.AudioContext || window.webkitAudioContext
    const c = (this.ctx = new AC({ latencyHint: 'interactive' }))
    this.limiter = c.createDynamicsCompressor()
    this.limiter.threshold.value = -6
    this.limiter.knee.value = 6
    this.limiter.ratio.value = 12
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.2
    this.master = c.createGain()
    this.master.gain.value = 0.8
    this.masterAn = c.createAnalyser()
    this.masterAn.fftSize = 1024
    this.master.connect(this.limiter).connect(this.masterAn).connect(c.destination)
    this.sampler = c.createGain()
    this.sampler.gain.value = 0.8
    this.sampler.connect(this.master)
    this.decks = { A: this.makeDeck(), B: this.makeDeck() }
    this.padSources = {}
    this.listeners = new Set()
    this.setXf(0.5)
  }

  makeDeck() {
    const c = this.ctx
    const input = c.createGain()
    const low = c.createBiquadFilter()
    low.type = 'lowshelf'
    low.frequency.value = 220
    const mid = c.createBiquadFilter()
    mid.type = 'peaking'
    mid.frequency.value = 1000
    mid.Q.value = 0.9
    const high = c.createBiquadFilter()
    high.type = 'highshelf'
    high.frequency.value = 3500
    const vol = c.createGain()
    vol.gain.value = 0.64
    const xf = c.createGain()
    const an = c.createAnalyser()
    an.fftSize = 1024
    input.connect(low).connect(mid).connect(high).connect(vol)
    vol.connect(an)
    vol.connect(xf).connect(this.master)
    return { input, eq: { low, mid, high }, vol, xf, an, buffer: null, playing: false, offset: 0, startedAt: 0, rate: 1, bend: 1, curRate: 1, source: null, cue: 0, tempo: null }
  }

  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit() {
    for (const fn of this.listeners) fn()
  }
  resume() {
    if (this.ctx.state !== 'running') this.ctx.resume()
  }

  pos(id) {
    const d = this.decks[id]
    if (!d.buffer) return 0
    if (!d.playing) return d.offset
    return Math.min(d.offset + (this.ctx.currentTime - d.startedAt) * d.curRate, d.buffer.duration)
  }

  load(id, buffer, tempo = null) {
    this.pause(id)
    const d = this.decks[id]
    d.buffer = buffer
    d.tempo = tempo
    d.offset = 0
    d.cue = 0
    this.emit()
  }

  play(id) {
    const d = this.decks[id]
    if (!d.buffer || d.playing) return
    this.resume()
    if (d.offset >= d.buffer.duration - 0.05) d.offset = d.cue < d.buffer.duration - 0.05 ? d.cue : 0
    const src = this.ctx.createBufferSource()
    src.buffer = d.buffer
    d.curRate = d.rate * d.bend
    src.playbackRate.value = d.curRate
    src.connect(d.input)
    src.onended = () => {
      if (d.source !== src) return
      d.source = null
      d.playing = false
      d.offset = d.buffer.duration
      this.emit()
    }
    src.start(0, d.offset)
    d.source = src
    d.startedAt = this.ctx.currentTime
    d.playing = true
    this.emit()
  }

  pause(id) {
    const d = this.decks[id]
    if (!d.playing) return
    d.offset = this.pos(id)
    const src = d.source
    d.source = null
    d.playing = false
    try {
      src.stop()
    } catch {
      /* ya detenido */
    }
    this.emit()
  }

  seek(id, t) {
    const d = this.decks[id]
    if (!d.buffer) return
    const was = d.playing
    if (was) this.pause(id)
    d.offset = clamp(t, 0, d.buffer.duration)
    if (was) this.play(id)
    else this.emit()
  }

  setRate(id, rate, bend) {
    const d = this.decks[id]
    if (rate != null) d.rate = rate
    if (bend != null) d.bend = bend
    if (d.playing) {
      d.offset = this.pos(id)
      d.startedAt = this.ctx.currentTime
    }
    d.curRate = d.rate * d.bend
    if (d.source) d.source.playbackRate.setTargetAtTime(d.curRate, this.ctx.currentTime, 0.01)
  }

  setEq(id, band, db) {
    this.decks[id].eq[band].gain.setTargetAtTime(db, this.ctx.currentTime, 0.02)
  }
  setVol(id, v) {
    this.decks[id].vol.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.02)
  }
  setXf(x) {
    const t = this.ctx.currentTime
    this.decks.A.xf.gain.setTargetAtTime(Math.cos((x * Math.PI) / 2), t, 0.01)
    this.decks.B.xf.gain.setTargetAtTime(Math.sin((x * Math.PI) / 2), t, 0.01)
  }
  setMaster(v) {
    this.master.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.02)
  }
  setSampler(v) {
    this.sampler.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.02)
  }

  triggerPad(id, buffer, onEnd) {
    this.resume()
    const prev = this.padSources[id]
    if (prev) {
      prev.onended = null
      try {
        prev.stop()
      } catch {
        /* ya detenido */
      }
    }
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.sampler)
    src.onended = () => {
      if (this.padSources[id] === src) delete this.padSources[id]
      onEnd()
    }
    src.start()
    this.padSources[id] = src
  }
}

let engineSingleton = null
const getEngine = () => (engineSingleton ??= new Engine())

function useEngineTick() {
  const [, set] = useState(0)
  useEffect(() => getEngine().on(() => set((n) => n + 1)), [])
}

function useFrame(cb) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    let raf
    const loop = () => {
      ref.current()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
}

// ─── Controles de hardware ──────────────────────────────────────────────────
function Screws() {
  return (
    <>
      <span className="screw left-2.5 top-2.5" />
      <span className="screw right-2.5 top-2.5" />
      <span className="screw bottom-2.5 left-2.5" />
      <span className="screw bottom-2.5 right-2.5" />
    </>
  )
}

const polar = (cx, cy, r, deg) => {
  const a = (deg * Math.PI) / 180
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)]
}
const arc = (cx, cy, r, a0, a1) => {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0
  const sweep = a1 > a0 ? 1 : 0
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`
}

function Knob({ id, label, value, min, max, def, onChange, color, size = 46, format }) {
  const drag = useRef(null)
  const toAngle = (v) => -135 + (270 * (v - min)) / (max - min)
  const a = toAngle(value)
  const a0 = toAngle(def)
  const c = size / 2
  const r = c - 3
  const step = (max - min) / 40
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        id={id}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(value.toFixed(2))}
        aria-valuetext={format ? format(value) : undefined}
        title="Arrastra arriba/abajo · doble clic para centrar"
        className="relative cursor-ns-resize touch-none select-none rounded-full"
        style={{ width: size, height: size }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { y: e.clientY, v: value }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const dv = ((drag.current.y - e.clientY) / 160) * (max - min)
          onChange(clamp(drag.current.v + dv, min, max))
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => onChange(def)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onChange(clamp(value + step, min, max))
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onChange(clamp(value - step, min, max))
          else if (e.key === 'Home' || e.key === '0') onChange(def)
          else return
          e.preventDefault()
        }}
      >
        <svg width={size} height={size} className="absolute inset-0" aria-hidden="true">
          <path d={arc(c, c, r, -135, 135)} stroke="#24242b" strokeWidth="3" fill="none" strokeLinecap="round" />
          {Math.abs(a - a0) > 0.5 && (
            <path d={arc(c, c, r, Math.min(a0, a), Math.max(a0, a))} stroke={color} strokeWidth="3" fill="none" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
          )}
        </svg>
        <div
          className="absolute rounded-full"
          style={{
            inset: 7,
            background: 'radial-gradient(circle at 35% 30%, #3a3a44, #18181d 70%)',
            boxShadow: '0 3px 6px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.12)',
            transform: `rotate(${a}deg)`,
          }}
        >
          <span className="absolute left-1/2 top-1 h-[32%] w-[2px] -translate-x-1/2 rounded-full bg-carbon-200" />
        </div>
      </div>
      <span className="silk !text-[9px]">{label}</span>
    </div>
  )
}

function Fader({ id, label, value, def, onChange, color, vertical = true, length = 150, notch = false, ticks = 9, ariaText }) {
  const track = useRef(null)
  const set = (e) => {
    const r = track.current.getBoundingClientRect()
    const v = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width
    onChange(clamp(v, 0, 1))
  }
  const capStyle = vertical
    ? { left: '50%', top: `${(1 - value) * 100}%`, transform: 'translate(-50%,-50%)', width: 34, height: 18 }
    : { top: '50%', left: `${value * 100}%`, transform: 'translate(-50%,-50%)', width: 20, height: 36 }
  return (
    <div
      ref={track}
      id={id}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-valuetext={ariaText}
      className={`relative touch-none select-none ${vertical ? 'cursor-ns-resize' : 'cursor-ew-resize'}`}
      style={vertical ? { height: length, width: 38 } : { width: '100%', height: 40 }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        set(e)
      }}
      onPointerMove={(e) => e.buttons && set(e)}
      onDoubleClick={() => onChange(def)}
      onKeyDown={(e) => {
        const inc = { ArrowUp: 0.02, ArrowRight: 0.02, ArrowDown: -0.02, ArrowLeft: -0.02 }[e.key]
        if (inc != null) onChange(clamp(value + inc, 0, 1))
        else if (e.key === 'Home') onChange(def)
        else return
        e.preventDefault()
      }}
    >
      {Array.from({ length: ticks }, (_, i) => {
        const p = (i / (ticks - 1)) * 100
        const center = notch && i === (ticks - 1) / 2
        return vertical ? (
          <span key={i} className="absolute h-px" style={{ top: `${p}%`, left: 0, right: 0, background: center ? '#6a6a78' : '#24242b' }} />
        ) : (
          <span key={i} className="absolute w-px" style={{ left: `${p}%`, top: center ? 0 : 6, bottom: center ? 0 : 6, background: center ? '#6a6a78' : '#24242b' }} />
        )
      })}
      <span
        className="absolute rounded-full bg-black shadow-[inset_0_1px_3px_rgba(0,0,0,.9)]"
        style={vertical ? { left: '50%', top: 0, bottom: 0, width: 5, transform: 'translateX(-50%)' } : { top: '50%', left: 0, right: 0, height: 5, transform: 'translateY(-50%)' }}
      />
      <span
        className="absolute rounded-[5px]"
        style={{
          ...capStyle,
          background: 'linear-gradient(180deg,#4a4a55,#1e1e24 55%,#2b2b33)',
          boxShadow: '0 4px 8px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.18)',
        }}
      >
        <span
          className="absolute"
          style={{
            ...(vertical ? { left: 3, right: 3, top: '50%', height: 2, transform: 'translateY(-50%)' } : { top: 3, bottom: 3, left: '50%', width: 2, transform: 'translateX(-50%)' }),
            background: color,
            boxShadow: `0 0 6px ${color}`,
          }}
        />
      </span>
    </div>
  )
}

function Meter({ analyser, segments = 16, vertical = true, className = '' }) {
  const box = useRef(null)
  const level = useRef(0)
  const buf = useRef(null)
  useFrame(() => {
    if (!analyser || !box.current) return
    if (!buf.current) buf.current = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buf.current)
    let peak = 0
    for (let i = 0; i < buf.current.length; i++) peak = Math.max(peak, Math.abs(buf.current[i]))
    const db = 20 * Math.log10(peak || 1e-6)
    const target = clamp((db + 42) / 42, 0, 1)
    level.current = Math.max(target, level.current - 0.025)
    const lit = Math.round(level.current * segments)
    const kids = box.current.children
    for (let i = 0; i < segments; i++) {
      const el = kids[segments - 1 - i]
      const on = i < lit
      const color = i >= segments - 2 ? NEON.magenta : i >= segments - 5 ? NEON.amber : NEON.green
      el.style.backgroundColor = on ? color : ''
      el.style.boxShadow = on ? `0 0 6px ${color}` : ''
    }
  })
  return (
    <div ref={box} aria-hidden="true" className={`flex ${vertical ? 'flex-col' : 'flex-row-reverse'} gap-[3px] ${className}`}>
      {Array.from({ length: segments }, (_, i) => (
        <span key={i} className={`led rounded-[2px] ${vertical ? 'h-[5px] w-2.5' : 'h-2.5 flex-1'}`} />
      ))}
    </div>
  )
}

// ─── Deck ───────────────────────────────────────────────────────────────────
function Waveform({ deck, peaks, color }) {
  const canvas = useRef(null)
  useFrame(() => {
    const cv = canvas.current
    if (!cv) return
    const engine = getEngine()
    const d = engine.decks[deck]
    const dpr = window.devicePixelRatio || 1
    const W = cv.clientWidth
    const H = cv.clientHeight
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
    }
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    const mid = H / 2
    g.fillStyle = '#1b1b21'
    g.fillRect(0, mid, W, 1)
    if (!peaks || !d.buffer) return
    const dur = d.buffer.duration
    const px = (engine.pos(deck) / dur) * W
    const n = peaks.length
    for (let x = 0; x < W; x += 2) {
      const amp = peaks[Math.min(n - 1, Math.floor((x / W) * n))]
      const h = Math.max(1, amp * (mid - 3))
      g.fillStyle = x < px ? color : `${color}48`
      g.fillRect(x, mid - h, 1.4, h * 2)
    }
    const cx = (d.cue / dur) * W
    g.fillStyle = NEON.amber
    g.fillRect(cx, 0, 1, H)
    g.beginPath()
    g.moveTo(cx - 4, 0)
    g.lineTo(cx + 4, 0)
    g.lineTo(cx, 5)
    g.fill()
    g.shadowColor = '#fff'
    g.shadowBlur = 8
    g.fillStyle = '#fff'
    g.fillRect(px - 1, 0, 2, H)
    g.shadowBlur = 0
  })
  const seek = (e) => {
    const d = getEngine().decks[deck]
    if (!d.buffer) return
    const r = canvas.current.getBoundingClientRect()
    getEngine().seek(deck, ((e.clientX - r.left) / r.width) * d.buffer.duration)
  }
  return (
    <canvas
      ref={canvas}
      className="lcd block h-[72px] w-full cursor-pointer touch-none"
      aria-label="Forma de onda: toca para saltar a ese punto"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        seek(e)
      }}
      onPointerMove={(e) => e.buttons && seek(e)}
    />
  )
}

function Platter({ deck, color, playing, label }) {
  const disc = useRef(null)
  const drag = useRef(null)
  useFrame(() => {
    if (disc.current) disc.current.style.transform = `rotate(${getEngine().pos(deck) * 200}deg)`
  })
  const angle = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI
  }
  const end = () => {
    if (!drag.current) return
    drag.current = null
    getEngine().setRate(deck, null, 1)
  }
  return (
    <div
      className="relative aspect-square w-full max-w-[220px] touch-none select-none rounded-full p-[6px]"
      style={{
        background: 'linear-gradient(145deg,#2c2c34,#121216)',
        boxShadow: playing ? `0 0 0 2px ${color}, 0 0 24px ${color}66, inset 0 0 12px rgba(0,0,0,.8)` : '0 0 0 2px #24242b, inset 0 0 12px rgba(0,0,0,.8)',
        transition: 'box-shadow .25s ease',
      }}
      title="Jog: arrastra en círculo para buscar (en pausa) o empujar el tempo (en reproducción)"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { a: angle(e) }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        const a = angle(e)
        let da = a - drag.current.a
        if (da > 180) da -= 360
        if (da < -180) da += 360
        drag.current.a = a
        const engine = getEngine()
        if (engine.decks[deck].playing) engine.setRate(deck, null, clamp(1 + da * 0.02, 0.85, 1.15))
        else engine.seek(deck, engine.pos(deck) + da / 200)
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div ref={disc} className="vinyl relative h-full w-full rounded-full">
        <div
          className="absolute left-1/2 top-1/2 flex aspect-square w-[34%] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
          style={{ background: `radial-gradient(circle, #0b0b0d 0 9%, ${color} 10% 100%)`, boxShadow: playing ? `0 0 18px ${color}` : 'none' }}
        >
          <span className="absolute top-[14%] font-display text-[10px] font-bold tracking-widest text-black/80">{label}</span>
        </div>
        <span className="absolute left-1/2 top-[3%] h-[16%] w-[3px] -translate-x-1/2 rounded-full bg-white/80" />
      </div>
    </div>
  )
}

function Icon({ name, className = 'h-5 w-5' }) {
  const paths = {
    play: <path d="M7 4.5v15l13-7.5z" fill="currentColor" />,
    pause: <path d="M6 4.5h4.5v15H6zm7.5 0H18v15h-4.5z" fill="currentColor" />,
    upload: <path d="M12 3l5 5h-3.2v6h-3.6V8H7zM4.5 17.5h15v3h-15z" fill="currentColor" />,
    search: <path d="M10.5 3a7.5 7.5 0 0 1 6 12l4.3 4.3-1.8 1.8-4.3-4.3A7.5 7.5 0 1 1 10.5 3zm0 2.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10z" fill="currentColor" />,
    reset: <path d="M12 5a7 7 0 1 1-6.6 9.3l2.3-.8A4.6 4.6 0 1 0 12 7.4V10L7.5 6.2 12 2.5z" fill="currentColor" />,
  }
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

// ─── Audius: catálogo abierto con streaming compatible con Web Audio (CORS) ──
const AUDIUS_API = 'https://api.audius.co/v1'
const AUDIUS_APP = 'dark-theme-dj-mixer'
const AUDIUS_OFFLINE = 'No se pudo conectar con Audius. En la vista previa de Claude el internet está bloqueado; en la versión publicada sí funciona.'

async function audiusTracks(query) {
  const url = query
    ? `${AUDIUS_API}/tracks/search?query=${encodeURIComponent(query)}&app_name=${AUDIUS_APP}`
    : `${AUDIUS_API}/tracks/trending?genre=Electronic&time=week&app_name=${AUDIUS_APP}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Audius respondió ${res.status}`)
  const { data = [] } = await res.json()
  return data.filter((t) => t.is_streamable !== false).slice(0, 30)
}

async function audiusBuffer(track, ctx, onProgress) {
  const res = await fetch(`${AUDIUS_API}/tracks/${track.id}/stream?app_name=${AUDIUS_APP}`)
  if (!res.ok) throw new Error(`Audius respondió ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  let bytes
  if (res.body && total) {
    const reader = res.body.getReader()
    const chunks = []
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      got += value.length
      onProgress(Math.round((got / total) * 100))
    }
    bytes = new Uint8Array(got)
    let o = 0
    for (const c of chunks) {
      bytes.set(c, o)
      o += c.length
    }
    bytes = bytes.buffer
  } else {
    bytes = await res.arrayBuffer()
  }
  return ctx.decodeAudioData(bytes)
}

function AudiusSearch({ deck, color, onPick, onClose }) {
  const [q, setQ] = useState('')
  const [shown, setShown] = useState('')
  const [results, setResults] = useState([])
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  const run = useCallback(async (query) => {
    setStatus('loading')
    setError('')
    try {
      const tracks = await audiusTracks(query)
      setResults(tracks)
      setShown(query)
      setStatus('done')
    } catch (e) {
      setError(e instanceof TypeError ? AUDIUS_OFFLINE : `No se pudo buscar en Audius (${e.message}). Intenta de nuevo.`)
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    run('')
    inputRef.current?.focus()
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run, onClose])

  return (
    <div className="absolute inset-0 z-20 flex flex-col gap-3 rounded-[18px] bg-carbon-900/[.97] p-5 backdrop-blur sm:p-6" role="dialog" aria-label={`Buscar en Audius para el deck ${deck}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="silk">
          Deck {deck} · Buscar en <span style={{ color }}>Audius</span>
        </p>
        <button type="button" onClick={onClose} className="hw-btn px-3 py-1.5 font-display text-xs font-semibold uppercase tracking-wider text-carbon-200 hover:text-white">
          Cerrar
        </button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          run(q.trim())
        }}
      >
        <input
          ref={inputRef}
          id={`audius-q-${deck}`}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Artista, canción o género"
          className="lcd min-w-0 flex-1 px-3 py-2.5 text-sm text-white placeholder:text-carbon-400 focus:outline-none"
          style={{ caretColor: color }}
          autoComplete="off"
        />
        <button type="submit" className="hw-btn px-4 font-display text-xs font-bold uppercase tracking-wider" style={{ color }}>
          Buscar
        </button>
      </form>
      <p className="text-[11px] text-carbon-400">
        {status === 'loading' ? 'Buscando…' : status === 'done' ? (shown ? `${results.length} resultados para “${shown}”` : 'Tendencias de electrónica esta semana') : ''}
      </p>
      {status === 'error' && <p className="rounded-md border border-neon-magenta/40 bg-neon-magenta/10 px-3 py-2 text-xs text-neon-magenta">{error}</p>}
      {status === 'done' && results.length === 0 && <p className="text-sm text-carbon-300">Sin resultados. Prueba con otro nombre o un género como “house” o “techno”.</p>}
      <ul className="-mx-2 min-h-0 flex-1 overflow-y-auto">
        {results.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onPick(t)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/5 focus-visible:bg-white/5"
            >
              <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded-md" style={{ background: `linear-gradient(135deg, ${color}55, #141418)` }}>
                {t.artwork?.['150x150'] && <img src={t.artwork['150x150']} alt="" className="absolute inset-0 h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = 'none')} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-display text-sm font-semibold text-white">{t.title}</span>
                <span className="block truncate text-xs text-carbon-400">
                  {t.user?.name}
                  {t.genre ? ` · ${t.genre}` : ''}
                </span>
              </span>
              <span className="font-mono text-xs tabular-nums text-carbon-300">{fmt(t.duration).slice(0, -2)}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-carbon-400">Música de artistas independientes en Audius. La canción completa se descarga para poder mezclarla.</p>
    </div>
  )
}

function Deck({ id, info, onLoadFile, onPickAudius }) {
  useEngineTick()
  const engine = getEngine()
  const d = engine.decks[id]
  const color = DECK_COLOR[id]
  const [pitch, setPitch] = useState(0.5)
  const [over, setOver] = useState(false)
  const [searching, setSearching] = useState(false)
  const closeSearch = useCallback(() => setSearching(false), [])
  const elapsed = useRef(null)
  const remain = useRef(null)
  const preview = useRef(false)
  const rate = 1 + (pitch - 0.5) * 0.16

  useFrame(() => {
    const p = engine.pos(id)
    const dur = d.buffer?.duration ?? 0
    if (elapsed.current) elapsed.current.textContent = fmt(p)
    if (remain.current) remain.current.textContent = `-${fmt(dur - p)}`
  })

  const changePitch = (v) => {
    setPitch(v)
    engine.setRate(id, 1 + (v - 0.5) * 0.16, null)
  }

  const cueDown = () => {
    engine.resume()
    if (d.playing) {
      engine.pause(id)
      engine.seek(id, d.cue)
    } else if (Math.abs(engine.pos(id) - d.cue) < 0.03) {
      preview.current = true
      engine.play(id)
    } else {
      d.cue = engine.pos(id)
      engine.emit()
    }
  }
  const cueUp = () => {
    if (!preview.current) return
    preview.current = false
    engine.pause(id)
    engine.seek(id, d.cue)
  }

  const inputId = `deck-file-${id}`
  return (
    <section
      className="panel flex min-w-0 flex-col gap-4 p-5 sm:p-6"
      style={
        over
          ? { boxShadow: `0 0 0 2px ${color}, 0 0 30px ${color}55` }
          : { borderColor: `color-mix(in srgb, ${color} calc(var(--beat-${id.toLowerCase()}, 0) * 70%), #26262d)`, boxShadow: `0 0 calc(var(--beat-${id.toLowerCase()}, 0) * 60px) color-mix(in srgb, ${color} calc(var(--beat-${id.toLowerCase()}, 0) * 75%), transparent), inset 0 1px 0 rgba(255,255,255,.06)` }
      }
      aria-label={`Deck ${id}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = e.dataTransfer.files?.[0]
        if (f) onLoadFile(id, f)
      }}
    >
      <Screws />
      {searching && (
        <AudiusSearch
          deck={id}
          color={color}
          onClose={closeSearch}
          onPick={(t) => {
            setSearching(false)
            onPickAudius(id, t)
          }}
        />
      )}
      <header className="flex items-center gap-3">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg font-display text-lg font-bold text-black"
          style={{ background: color, boxShadow: `0 0 14px ${color}88` }}
        >
          {id}
        </span>
        <div className="min-w-0 flex-1">
          <p className="silk truncate">
            Deck {id}
            {info.demo ? ' · pista demo' : ''}
            {info.link && (
              <>
                {' · '}
                <a href={info.link} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-white" style={{ color }}>
                  Audius
                </a>
              </>
            )}
          </p>
          <p className="truncate font-display text-base font-semibold text-carbon-200" title={info.name}>
            {info.loading ? (info.progress != null ? `Descargando… ${info.progress}%` : 'Cargando…') : info.name}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSearching(true)}
          className="hw-btn flex shrink-0 items-center gap-1.5 px-3 py-2 font-display text-xs font-semibold uppercase tracking-wider text-carbon-200 hover:text-white"
          aria-label={`Buscar canción en Audius para el deck ${id}`}
        >
          <Icon name="search" className="h-4 w-4" />
          <span className="hidden sm:inline">Buscar</span>
        </button>
        <label htmlFor={inputId} className="hw-btn flex shrink-0 cursor-pointer items-center gap-1.5 px-3 py-2 font-display text-xs font-semibold uppercase tracking-wider text-carbon-200 hover:text-white" title="Cargar un archivo de tu equipo">
          <Icon name="upload" className="h-4 w-4" />
          <span className="hidden sm:inline">Cargar</span>
          <span className="sr-only sm:hidden">Cargar archivo</span>
        </label>
        <input
          id={inputId}
          type="file"
          accept="audio/*"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onLoadFile(id, f)
            e.target.value = ''
          }}
        />
      </header>

      {info.error && <p className="rounded-md border border-neon-magenta/40 bg-neon-magenta/10 px-3 py-2 text-xs text-neon-magenta">{info.error}</p>}

      <Waveform deck={id} peaks={info.peaks} color={color} />

      <div className="flex items-center gap-4">
        <div className="flex flex-1 justify-center">
          <Platter deck={id} color={color} playing={d.playing} label={`DECK ${id}`} />
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <span className="silk !text-[9px]">+8%</span>
          <Fader id={`pitch-${id}`} label={`Tempo deck ${id}`} value={pitch} def={0.5} onChange={changePitch} color={color} length={150} notch ariaText={`${((rate - 1) * 100).toFixed(1)}%`} />
          <span className="silk !text-[9px]">−8%</span>
        </div>
      </div>

      <div className="lcd grid grid-cols-4 gap-2 px-3 py-2 text-center">
        {[
          ['Tiempo', <span key="e" ref={elapsed}>0:00.0</span>],
          ['Resta', <span key="r" ref={remain}>-0:00.0</span>],
          ['BPM', info.bpm ? (info.bpm * rate).toFixed(1) : info.analyzing ? '…' : '—'],
          ['Tempo', `${rate >= 1 ? '+' : ''}${((rate - 1) * 100).toFixed(1)}%`],
        ].map(([k, v]) => (
          <div key={k} className="min-w-0">
            <div className="text-[9px] uppercase tracking-[.18em] text-carbon-400">{k}</div>
            <div className="truncate text-sm" style={{ color }}>{v}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          className="hw-btn flex h-14 items-center justify-center gap-2 font-display text-sm font-bold uppercase tracking-[.2em]"
          style={{ color: NEON.amber, borderColor: preview.current || (!d.playing && Math.abs((d.offset ?? 0) - d.cue) < 0.03) ? `${NEON.amber}aa` : undefined }}
          onPointerDown={cueDown}
          onPointerUp={cueUp}
          onPointerLeave={cueUp}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !e.repeat && (e.preventDefault(), cueDown())}
          onKeyUp={(e) => (e.key === 'Enter' || e.key === ' ') && cueUp()}
          aria-label={`Cue deck ${id}`}
          disabled={!d.buffer}
        >
          Cue
        </button>
        <button
          type="button"
          className="hw-btn flex h-14 items-center justify-center gap-2 font-display text-sm font-bold uppercase tracking-[.2em] disabled:opacity-40"
          style={
            d.playing
              ? { color: '#050506', background: color, borderColor: color, boxShadow: `0 0 22px ${color}aa, 0 3px 0 #08080a` }
              : { color }
          }
          onClick={() => (d.playing ? engine.pause(id) : engine.play(id))}
          aria-label={d.playing ? `Pausar deck ${id}` : `Reproducir deck ${id}`}
          disabled={!d.buffer}
        >
          <Icon name={d.playing ? 'pause' : 'play'} />
          {d.playing ? 'Pausa' : 'Play'}
        </button>
      </div>
    </section>
  )
}

// ─── Mixer central ──────────────────────────────────────────────────────────
function Channel({ id }) {
  const engine = getEngine()
  const color = DECK_COLOR[id]
  const [eq, setEq] = useState({ high: 0, mid: 0, low: 0 })
  const [vol, setVol] = useState(0.8)
  const db = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
  return (
    <div className="flex flex-col items-center gap-3">
      <span className="font-display text-sm font-bold" style={{ color, textShadow: `0 0 8px ${color}` }}>{id}</span>
      {[
        ['high', 'Agudos'],
        ['mid', 'Medios'],
        ['low', 'Graves'],
      ].map(([band, label]) => (
        <Knob
          key={band}
          id={`eq-${band}-${id}`}
          label={label}
          value={eq[band]}
          min={-15}
          max={15}
          def={0}
          color={color}
          format={db}
          onChange={(v) => {
            setEq((s) => ({ ...s, [band]: v }))
            engine.setEq(id, band, v)
          }}
        />
      ))}
      <div className="mt-1 flex items-end gap-2">
        <Fader
          id={`vol-${id}`}
          label={`Volumen deck ${id}`}
          value={vol}
          def={0.8}
          color={color}
          length={140}
          ariaText={`${Math.round(vol * 100)}%`}
          onChange={(v) => {
            setVol(v)
            engine.setVol(id, v)
          }}
        />
        <Meter analyser={engine.decks[id].an} segments={16} />
      </div>
      <span className="silk !text-[9px]">Volumen</span>
    </div>
  )
}

function Mixer() {
  const engine = getEngine()
  const [xf, setXf] = useState(0.5)
  const [master, setMaster] = useState(0.9)
  return (
    <section className="panel flex flex-col gap-5 p-5 sm:p-6 lg:w-[300px]" aria-label="Mixer">
      <Screws />
      <p className="silk text-center">Mixer</p>
      <div className="flex items-start justify-center gap-5">
        <Channel id="A" />
        <div className="flex flex-col items-center gap-3 pt-7">
          <Knob
            id="master"
            label="Master"
            value={master}
            min={0}
            max={1}
            def={0.9}
            color={NEON.green}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => {
              setMaster(v)
              engine.setMaster(v)
            }}
          />
          <div className="flex gap-1">
            <Meter analyser={engine.masterAn} segments={22} />
          </div>
          <span className="silk !text-[9px]">L+R</span>
        </div>
        <Channel id="B" />
      </div>
      <div className="flex flex-col gap-2 border-t border-carbon-600 pt-4">
        <div className="flex items-center justify-between">
          <span className="font-display text-xs font-bold" style={{ color: NEON.cyan, opacity: 0.4 + (1 - xf) * 0.6 }}>◀ A</span>
          <span className="silk">Crossfader</span>
          <span className="font-display text-xs font-bold" style={{ color: NEON.magenta, opacity: 0.4 + xf * 0.6 }}>B ▶</span>
        </div>
        <Fader
          id="crossfader"
          label="Crossfader"
          vertical={false}
          value={xf}
          def={0.5}
          notch
          ticks={11}
          color="#ffffff"
          ariaText={xf < 0.48 ? `Hacia A ${Math.round((1 - xf) * 100)}%` : xf > 0.52 ? `Hacia B ${Math.round(xf * 100)}%` : 'Centro'}
          onChange={(v) => {
            setXf(v)
            engine.setXf(v)
          }}
        />
        <p className="text-center text-[11px] text-carbon-400">Curva de potencia constante: en el centro ambas suenan a −3 dB.</p>
      </div>
    </section>
  )
}

// ─── Sampler ────────────────────────────────────────────────────────────────
function Pad({ index, def, state, active, flash, onHit, onUpload, onReset }) {
  const color = def.color
  const inputId = `pad-file-${def.id}`
  const name = state.custom ? state.custom : def.name
  return (
    <div className="relative min-w-0">
      <button
        type="button"
        key={flash}
        className={`group relative flex h-24 w-full flex-col justify-between rounded-xl border p-2.5 text-left transition-[box-shadow,border-color,background-color] duration-150 active:scale-[.97] sm:h-32 sm:p-3 ${flash ? 'pad-hit' : ''}`}
        style={{
          borderColor: active ? color : '#2a2a32',
          background: active ? `radial-gradient(120% 120% at 50% 40%, ${color}55, ${color}18 60%, #121216)` : 'linear-gradient(180deg,#1b1b21,#121216)',
          boxShadow: active ? `0 0 0 1px ${color}, 0 0 26px ${color}88, inset 0 0 22px ${color}55` : 'inset 0 1px 0 rgba(255,255,255,.05), 0 4px 0 #070708',
        }}
        onPointerDown={(e) => {
          e.preventDefault()
          onHit()
        }}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onHit())}
        disabled={!state.buffer}
        aria-label={`Pad ${index + 1}: ${name}`}
      >
        <span className="flex w-full items-start justify-between">
          <span className="grid h-5 w-5 place-items-center rounded border border-carbon-600 font-mono text-[10px] text-carbon-300">{index + 1}</span>
          <span className="font-display text-[9px] font-semibold uppercase tracking-[.18em]" style={{ color }}>{def.type}</span>
        </span>
        <span className="block w-full pr-7">
          <span className="block truncate font-display text-sm font-bold text-white sm:text-base" title={name}>{name}</span>
          <span className="block truncate text-[10px] text-carbon-400">{state.custom ? 'Tu audio' : state.buffer ? 'Sintetizado' : 'Generando…'}</span>
        </span>
      </button>
      <div className="absolute bottom-2 right-2 flex gap-1">
        {state.custom && (
          <button
            type="button"
            onClick={onReset}
            className="grid h-6 w-6 place-items-center rounded-md border border-carbon-600 bg-carbon-900/90 text-carbon-300 hover:text-white"
            aria-label={`Volver al sonido original de ${def.name}`}
            title="Volver al sonido original"
          >
            <Icon name="reset" className="h-3.5 w-3.5" />
          </button>
        )}
        <label
          htmlFor={inputId}
          className="grid h-6 w-6 cursor-pointer place-items-center rounded-md border border-carbon-600 bg-carbon-900/90 text-carbon-300 hover:text-white"
          title="Reemplazar con tu propio audio corto"
        >
          <Icon name="upload" className="h-3.5 w-3.5" />
          <span className="sr-only">Subir audio para el pad {index + 1}</span>
        </label>
        <input
          id={inputId}
          type="file"
          accept="audio/*"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onUpload(f)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}

function Sampler({ pads, setPads }) {
  const engine = getEngine()
  const [active, setActive] = useState({})
  const [flash, setFlash] = useState({})
  const [vol, setVol] = useState(0.9)
  const [notice, setNotice] = useState('')
  const padsRef = useRef(pads)
  padsRef.current = pads

  const hit = useCallback(
    (i) => {
      const def = PADS[i]
      const buf = padsRef.current[def.id]?.buffer
      if (!buf) return
      setActive((s) => ({ ...s, [def.id]: true }))
      setFlash((s) => ({ ...s, [def.id]: (s[def.id] || 0) + 1 }))
      engine.triggerPad(def.id, buf, () => setActive((s) => ({ ...s, [def.id]: false })))
    },
    [engine]
  )

  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable]')) return
      const n = Number(e.key)
      if (n >= 1 && n <= 8) hit(n - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hit])

  const upload = async (def, file) => {
    setNotice('')
    try {
      const buffer = await engine.ctx.decodeAudioData(await file.arrayBuffer())
      if (buffer.duration > MAX_PAD_SECONDS) {
        setNotice(`“${file.name}” dura ${Math.round(buffer.duration)} s. Para un pad usa un audio de ${MAX_PAD_SECONDS} s o menos.`)
        return
      }
      setPads((p) => ({ ...p, [def.id]: { ...p[def.id], buffer, custom: file.name.replace(/\.[^.]+$/, '') } }))
      setNotice(`Pad ${PADS.indexOf(def) + 1} ahora dispara “${file.name}”.`)
    } catch {
      setNotice(`No se pudo leer “${file.name}”. Prueba con MP3, WAV, OGG o M4A.`)
    }
  }

  return (
    <section className="panel flex flex-col gap-4 p-5 sm:p-6" aria-label="Sampler">
      <Screws />
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div>
          <p className="silk">Sampler · 8 pads</p>
          <p className="mt-0.5 text-sm text-carbon-300">
            Toca un pad o usa las teclas <kbd className="rounded border border-carbon-600 px-1 font-mono text-xs">1</kbd>–<kbd className="rounded border border-carbon-600 px-1 font-mono text-xs">8</kbd>. Con <Icon name="upload" className="inline h-3.5 w-3.5 align-[-2px]" /> lo cambias por tu propio audio.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex gap-3 text-[10px] uppercase tracking-[.16em]">
            <span style={{ color: NEON.magenta }}>● Hit</span>
            <span style={{ color: NEON.cyan }}>● FX</span>
            <span style={{ color: NEON.green }}>● Voz</span>
          </div>
          <Knob
            id="sampler-vol"
            label="Nivel"
            value={vol}
            min={0}
            max={1}
            def={0.9}
            size={40}
            color={NEON.green}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => {
              setVol(v)
              engine.setSampler(v)
            }}
          />
        </div>
      </header>
      {notice && (
        <p role="status" className="rounded-md border border-carbon-600 bg-carbon-850 px-3 py-2 text-xs text-carbon-200">
          {notice}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        {PADS.map((def, i) => (
          <Pad
            key={def.id}
            index={i}
            def={def}
            state={pads[def.id] || {}}
            active={!!active[def.id]}
            flash={flash[def.id] || 0}
            onHit={() => hit(i)}
            onUpload={(f) => upload(def, f)}
            onReset={() => {
              setPads((p) => ({ ...p, [def.id]: { buffer: p[def.id].original, original: p[def.id].original, custom: null } }))
              setNotice(`Pad ${i + 1} volvió a “${def.name}”.`)
            }}
          />
        ))}
      </div>
    </section>
  )
}

// ─── App ────────────────────────────────────────────────────────────────────
// ─── Fondo de luces sincronizado al beat ─────────────────────────────────────
// Cada deck aporta un pulso: fase del beat (BPM detectado) × nivel real × posición del crossfader
const RGB = { A: [25, 240, 255], B: [255, 43, 214] }

function BeatBackdrop({ enabled }) {
  const canvas = useRef(null)
  const state = useRef({ A: 0, B: 0, buf: null, flash: 0, lastBar: { A: -1, B: -1 }, scroll: 0, last: 0 })
  const reduce = useRef(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    reduce.current = mq.matches
    const on = () => (reduce.current = mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  useFrame(() => {
    const cv = canvas.current
    const root = document.documentElement
    if (!cv) return
    const engine = getEngine()
    const st = state.current
    const now = performance.now()
    const dt = Math.min(0.05, (now - (st.last || now)) / 1000)
    st.last = now
    if (!st.buf) st.buf = new Float32Array(1024)

    const beats = {}
    for (const id of ['A', 'B']) {
      const d = engine.decks[id]
      let pulse = 0
      let beatF = 0
      if (enabled && d.playing && d.tempo) {
        d.an.getFloatTimeDomainData(st.buf)
        let sum = 0
        for (let i = 0; i < st.buf.length; i++) sum += st.buf[i] * st.buf[i]
        const level = clamp(Math.sqrt(sum / st.buf.length) * 7, 0, 1)
        const weight = level * Math.min(1, d.xf.gain.value / 0.7071)
        beatF = ((engine.pos(id) - d.tempo.offset) * d.tempo.bpm) / 60
        const phase = beatF - Math.floor(beatF)
        pulse = Math.exp(-phase * 4) * weight
        const bar = Math.floor(beatF / 4)
        if (bar !== st.lastBar[id] && beatF - bar * 4 < 0.2 && weight > 0.15) st.flash = Math.max(st.flash, weight)
        st.lastBar[id] = bar
        beats[id] = { beatF, weight }
      }
      if (reduce.current) pulse *= 0.25
      st[id] += (pulse - st[id]) * (pulse > st[id] ? 0.6 : 0.25)
      root.style.setProperty(`--beat-${id.toLowerCase()}`, st[id].toFixed(3))
    }
    st.flash = reduce.current ? 0 : st.flash * Math.pow(0.02, dt)

    const lead = beats.A && (!beats.B || beats.A.weight >= beats.B.weight) ? beats.A : beats.B
    // El piso avanza una línea por beat del deck que domina la mezcla
    if (lead && !reduce.current) st.scroll = lead.beatF
    const mixB = st.A + st.B > 0.01 ? st.B / (st.A + st.B) : (beats.B?.weight ?? 0) > (beats.A?.weight ?? 0) ? 1 : 0.5
    const mixRGB = RGB.A.map((c, i) => Math.round(c * (1 - mixB) + RGB.B[i] * mixB))
    const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${clamp(a, 0, 1).toFixed(3)})`

    const dpr = Math.min(1.5, window.devicePixelRatio || 1)
    const W = cv.clientWidth
    const H = cv.clientHeight
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
    }
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    if (!enabled) return
    const R = Math.max(W, H)

    // Halos de cada deck: A desde la izquierda, B desde la derecha
    for (const [id, x] of [['A', 0.08], ['B', 0.92]]) {
      const p = st[id]
      const grad = g.createRadialGradient(W * x, H * 0.85, 0, W * x, H * 0.85, R * (0.45 + 0.3 * p))
      grad.addColorStop(0, rgba(RGB[id], 0.1 + 0.55 * p))
      grad.addColorStop(1, rgba(RGB[id], 0))
      g.fillStyle = grad
      g.fillRect(0, 0, W, H)
    }

    // Piso de rejilla en perspectiva
    const energy = Math.max(st.A, st.B)
    const horizon = H * 0.58
    const vx = W / 2
    g.lineWidth = 1
    const frac = st.scroll - Math.floor(st.scroll)
    const rows = 14
    for (let k = 0; k < rows; k++) {
      const z = (k + 1 - frac) / rows
      const y = horizon + (H - horizon) * z * z
      g.strokeStyle = rgba(mixRGB, (0.05 + 0.4 * energy) * z + 0.03)
      g.beginPath()
      g.moveTo(0, y)
      g.lineTo(W, y)
      g.stroke()
    }
    const cols = 22
    for (let k = -cols; k <= cols; k++) {
      const xb = vx + (k / cols) * W * 1.6
      const grad = g.createLinearGradient(0, horizon, 0, H)
      grad.addColorStop(0, rgba(mixRGB, 0))
      grad.addColorStop(1, rgba(mixRGB, 0.06 + 0.35 * energy))
      g.strokeStyle = grad
      g.beginPath()
      g.moveTo(vx, horizon)
      g.lineTo(xb, H)
      g.stroke()
    }
    // Horizonte que destella en el primer beat de cada compás
    const hz = g.createLinearGradient(0, 0, W, 0)
    hz.addColorStop(0, rgba(RGB.A, 0))
    hz.addColorStop(0.5, rgba(mixRGB, 0.15 + 0.6 * st.flash + 0.25 * energy))
    hz.addColorStop(1, rgba(RGB.B, 0))
    g.fillStyle = hz
    g.fillRect(0, horizon - 1, W, 2 + 3 * st.flash)

    // Haces de luz desde arriba, giran con el beat
    if (lead && !reduce.current) {
      const beams = 5
      g.globalCompositeOperation = 'lighter'
      for (let i = 0; i < beams; i++) {
        const base = ((i - (beams - 1) / 2) / beams) * 1.6
        const a = base + Math.sin((lead.beatF * Math.PI) / 4 + i) * 0.35
        const len = R * 1.2
        const x0 = vx + (i - (beams - 1) / 2) * 30
        const x1 = x0 + Math.sin(a) * len
        const y1 = Math.cos(a) * len
        const grad = g.createLinearGradient(x0, 0, x1, y1)
        grad.addColorStop(0, rgba(i % 2 ? RGB.B : RGB.A, 0.05 + 0.25 * energy))
        grad.addColorStop(1, rgba(i % 2 ? RGB.B : RGB.A, 0))
        g.strokeStyle = grad
        g.lineWidth = 2 + 10 * energy
        g.beginPath()
        g.moveTo(x0, 0)
        g.lineTo(x1, y1)
        g.stroke()
      }
      g.globalCompositeOperation = 'source-over'
    }

    // Destello general en el downbeat
    if (st.flash > 0.01) {
      g.fillStyle = rgba(mixRGB, st.flash * 0.08)
      g.fillRect(0, 0, W, H)
    }
  })

  return <canvas ref={canvas} aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 h-full w-full" />
}

export default function DJMixer() {
  const engine = getEngine()
  const [decks, setDecks] = useState({
    A: { name: 'Neón Nocturno', demo: true, bpm: BPM, loading: true },
    B: { name: 'Carbón 124', demo: true, bpm: BPM, loading: true },
  })
  const [pads, setPads] = useState({})
  const [running, setRunning] = useState(engine.ctx.state === 'running')
  const [lights, setLights] = useState(() => {
    try {
      return localStorage.getItem('djmixer-luces') !== 'off'
    } catch {
      return true
    }
  })
  const toggleLights = () =>
    setLights((on) => {
      try {
        localStorage.setItem('djmixer-luces', on ? 'off' : 'on')
      } catch {
        /* sin almacenamiento */
      }
      return !on
    })

  useEffect(() => {
    let alive = true
    const onState = () => setRunning(engine.ctx.state === 'running')
    engine.ctx.addEventListener('statechange', onState)
    Promise.all([demoA(), demoB()]).then(([a, b]) => {
      if (!alive) return
      for (const [id, buf] of [['A', a], ['B', b]]) {
        if (!engine.decks[id].buffer) engine.load(id, buf, { bpm: BPM, offset: 0 })
      }
      setDecks((s) => ({
        A: { ...s.A, loading: false, peaks: computePeaks(engine.decks.A.buffer) },
        B: { ...s.B, loading: false, peaks: computePeaks(engine.decks.B.buffer) },
      }))
    })
    for (const def of PADS) {
      def.synth().then((buffer) => {
        if (alive) setPads((p) => (p[def.id] ? p : { ...p, [def.id]: { buffer, original: buffer, custom: null } }))
      })
    }
    return () => {
      alive = false
      engine.ctx.removeEventListener('statechange', onState)
    }
  }, [engine])

  // Cada carga recibe un turno; si llega otra al mismo deck, la anterior se descarta
  const loadTurn = useRef({ A: 0, B: 0 })

  const analyze = async (id, buffer, turn) => {
    let tempo = null
    try {
      tempo = await detectTempo(buffer)
    } catch {
      /* sin tempo: el fondo queda en modo ambiente para este deck */
    }
    if (loadTurn.current[id] !== turn) return
    engine.decks[id].tempo = tempo
    setDecks((s) => ({ ...s, [id]: { ...s[id], bpm: tempo?.bpm ?? null, analyzing: false } }))
  }

  const loadFile = async (id, file) => {
    const turn = ++loadTurn.current[id]
    setDecks((s) => ({ ...s, [id]: { ...s[id], loading: true, error: null } }))
    try {
      const buffer = await engine.ctx.decodeAudioData(await file.arrayBuffer())
      if (loadTurn.current[id] !== turn) return
      engine.load(id, buffer)
      setDecks((s) => ({ ...s, [id]: { name: file.name.replace(/\.[^.]+$/, ''), demo: false, bpm: null, analyzing: true, loading: false, peaks: computePeaks(buffer) } }))
      analyze(id, buffer, turn)
    } catch {
      setDecks((s) => ({ ...s, [id]: { ...s[id], loading: false, error: `No se pudo leer “${file.name}”. Prueba con MP3, WAV, OGG o M4A.` } }))
    }
  }

  const loadAudius = async (id, track) => {
    const turn = ++loadTurn.current[id]
    const current = () => loadTurn.current[id] === turn
    setDecks((s) => ({ ...s, [id]: { ...s[id], loading: true, progress: 0, error: null } }))
    try {
      const buffer = await audiusBuffer(track, engine.ctx, (p) => current() && setDecks((s) => ({ ...s, [id]: { ...s[id], progress: p } })))
      if (!current()) return
      engine.load(id, buffer)
      setDecks((s) => ({
        ...s,
        [id]: {
          name: `${track.title} · ${track.user?.name ?? ''}`,
          demo: false,
          bpm: null,
          analyzing: true,
          loading: false,
          peaks: computePeaks(buffer),
          link: track.permalink ? `https://audius.co${track.permalink}` : 'https://audius.co',
        },
      }))
      analyze(id, buffer, turn)
    } catch (e) {
      if (!current()) return
      const error = e instanceof TypeError ? AUDIUS_OFFLINE : `No se pudo cargar “${track.title}” desde Audius. Prueba con otra canción.`
      setDecks((s) => ({ ...s, [id]: { ...s[id], loading: false, progress: null, error } }))
    }
  }

  return (
    <>
    <BeatBackdrop enabled={lights} />
    <div
      className="relative z-[1] mx-auto flex max-w-[1320px] flex-col gap-4 py-5 sm:gap-5 sm:py-8"
      style={{ paddingLeft: 'max(16px, env(safe-area-inset-left, 0px))', paddingRight: 'max(16px, env(safe-area-inset-right, 0px))' }}
      onPointerDownCapture={() => engine.resume()}
      onKeyDownCapture={() => engine.resume()}
    >
      <header className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[.3em] text-carbon-400">App 10 · 101 great ideas</p>
          <h1 className="font-display text-2xl font-bold uppercase tracking-[.08em] text-white sm:text-3xl">
            Dark Theme <span style={{ color: NEON.cyan, textShadow: `0 0 18px ${NEON.cyan}88` }}>DJ</span>{' '}
            <span style={{ color: NEON.magenta, textShadow: `0 0 18px ${NEON.magenta}88` }}>Mixer</span>
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <span
          className="flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[.16em]"
          style={{ borderColor: running ? `${NEON.green}66` : '#2a2a32', color: running ? NEON.green : '#8a8a98' }}
          role="status"
        >
          <span className="h-2 w-2 rounded-full" style={{ background: running ? NEON.green : '#3a3a44', boxShadow: running ? `0 0 8px ${NEON.green}` : 'none' }} />
          {running ? 'Audio activo' : 'Toca Play o un pad para activar el audio'}
        </span>
        <button
          type="button"
          onClick={toggleLights}
          aria-pressed={lights}
          className="hw-btn flex items-center gap-2 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[.16em]"
          style={{ color: lights ? NEON.magenta : '#8a8a98' }}
          title="Fondo de luces que pulsa con el BPM de lo que suena"
        >
          <span className="h-2 w-2 rounded-full" style={{ background: lights ? NEON.magenta : '#3a3a44', boxShadow: lights ? `0 0 8px ${NEON.magenta}` : 'none' }} />
          Luces {lights ? 'on' : 'off'}
        </button>
        </div>
      </header>

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_300px_minmax(0,1fr)]">
        <Deck id="A" info={decks.A} onLoadFile={loadFile} onPickAudius={loadAudius} />
        <Mixer />
        <Deck id="B" info={decks.B} onLoadFile={loadFile} onPickAudius={loadAudius} />
      </div>

      <Sampler pads={pads} setPads={setPads} />

      <footer className="px-1 pb-2 text-xs leading-relaxed text-carbon-400">
        Arrastra un archivo a cualquier deck, usa <span className="text-carbon-300">Cargar</span> o busca una canción en <span className="text-carbon-300">Audius</span>. Las pistas demo (124 BPM, La menor) y los ocho sonidos del sampler se sintetizan en tu navegador con Web Audio API; tus archivos no se suben a ningún servidor.
        Cue: en pausa marca el punto; mantenlo presionado para escuchar desde ahí; en reproducción regresa al punto marcado.
      </footer>
    </div>
    </>
  )
}
