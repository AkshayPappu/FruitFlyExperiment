/**
 * Song analysis for Band mode: tempo, an 8th-note step grid over the whole
 * song, and per-step "is this layer prominent right now?" targets for four
 * frequency layers. Also builds the live crossover that splits playback into
 * those same layers.
 */

export const LAYERS = Object.freeze([
  { key: 'bass', label: 'Bass', color: '#ff7a59' },
  { key: 'body', label: 'Body', color: '#f2c14e' },
  { key: 'vocals', label: 'Vocals', color: '#5ad1a8' },
  { key: 'highs', label: 'Highs', color: '#6ea8ff' },
]);
export const CROSSOVERS = Object.freeze([160, 800, 3500]);

const FFT_SIZE = 2048;
const HOP = 512;
const ENERGY_HOP = 1024;
const TEMPO_WINDOW_SEC = 45;
/** Steps either side used to judge whether a layer stands out locally. */
const LOCAL_STEPS = 16;

export async function decodeSong(file) {
  const bytes = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, 44100);
  return ctx.decodeAudioData(bytes);
}

function monoSlice(buffer, startSec, endSec) {
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.floor(startSec * sr)),
    b = Math.min(buffer.length, Math.floor(endSec * sr));
  const out = new Float32Array(Math.max(0, b - a));
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[a + i] / channels;
  }
  return out;
}

/** In-place radix-2 complex FFT. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len,
      wr = Math.cos(ang),
      wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k,
          b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci,
          ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** Positive log-spectral change per hop: the "something new happened" curve. */
export function spectralFlux(samples) {
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  const flux = new Float32Array(frames);
  const window = Float32Array.from(
    { length: FFT_SIZE },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE),
  );
  const re = new Float64Array(FFT_SIZE),
    im = new Float64Array(FFT_SIZE);
  let previous = new Float32Array(FFT_SIZE / 2);
  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[offset + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    const current = new Float32Array(FFT_SIZE / 2);
    let sum = 0;
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      current[k] = Math.log1p(10 * Math.hypot(re[k], im[k]));
      sum += Math.max(0, current[k] - previous[k]);
    }
    flux[f] = f ? sum : 0;
    previous = current;
  }
  return flux;
}

/** Autocorrelation tempo with a soft prior around 110 bpm, plus beat phase. */
export function estimateTempo(flux, frameRate) {
  const n = flux.length;
  const mean = flux.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const x = Float32Array.from(flux, (v) => v - mean);
  const minLag = Math.floor((60 * frameRate) / 200),
    maxLag = Math.ceil((60 * frameRate) / 60);
  let best = 0,
    bestLag = 0;
  const scores = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    s /= n - lag;
    scores[lag] = s;
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.9) ** 2);
    if (s * prior > best) {
      best = s * prior;
      bestLag = lag;
    }
  }
  if (!bestLag) return { bpm: 100, beatOffsetSec: 0 };
  let lag = bestLag;
  const a = scores[lag - 1] ?? 0,
    b = scores[lag],
    c = scores[lag + 1] ?? 0;
  const denom = a - 2 * b + c;
  if (denom < 0) lag += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
  const period = lag;
  let bestPhase = 0,
    bestPhaseScore = -Infinity;
  for (let phase = 0; phase < period; phase++) {
    let s = 0;
    for (let t = phase; t < n; t += period) s += flux[Math.round(t)] ?? 0;
    if (s > bestPhaseScore) {
      bestPhaseScore = s;
      bestPhase = phase;
    }
  }
  // A flux frame is centred half a window after its start.
  const centre = FFT_SIZE / 2 / HOP;
  return {
    bpm: (60 * frameRate) / period,
    beatOffsetSec: (bestPhase + centre) / frameRate,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** Linkwitz-Riley 4th order: two cascaded Butterworth biquads. */
function lr4(ctx, input, type, frequency) {
  let node = input;
  for (let i = 0; i < 2; i++) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = Math.SQRT1_2;
    node.connect(f);
    node = f;
  }
  return node;
}

/** LR4 low + high at one crossover: an allpass that matches the other bands' phase. */
function allpass(ctx, input, frequency) {
  const sum = ctx.createGain();
  lr4(ctx, input, 'lowpass', frequency).connect(sum);
  lr4(ctx, input, 'highpass', frequency).connect(sum);
  return sum;
}

/** Route one layer of the crossover tree; the four outputs sum to an allpass of the input. */
function layerChain(ctx, source, layer) {
  const [c1, c2, c3] = CROSSOVERS;
  if (layer === 0) return allpass(ctx, allpass(ctx, lr4(ctx, source, 'lowpass', c1), c2), c3);
  const above1 = lr4(ctx, source, 'highpass', c1);
  if (layer === 1) return allpass(ctx, lr4(ctx, above1, 'lowpass', c2), c3);
  const above2 = lr4(ctx, above1, 'highpass', c2);
  if (layer === 2) return lr4(ctx, above2, 'lowpass', c3);
  return lr4(ctx, above2, 'highpass', c3);
}

/** Split a live source into the four layers; returns one output node per layer. */
export function connectLayers(ctx, source) {
  return LAYERS.map((_, layer) => layerChain(ctx, source, layer));
}

/** Per-hop energy in each layer's frequency band across the whole mono signal. */
function bandEnergies(samples, sampleRate) {
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / ENERGY_HOP) + 1);
  const bands = LAYERS.map(() => new Float32Array(frames));
  const edges = [0, ...CROSSOVERS, sampleRate / 2].map((f) =>
    Math.min(FFT_SIZE / 2, Math.round((f / sampleRate) * FFT_SIZE)),
  );
  const window = Float32Array.from(
    { length: FFT_SIZE },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE),
  );
  const re = new Float64Array(FFT_SIZE),
    im = new Float64Array(FFT_SIZE);
  for (let f = 0; f < frames; f++) {
    const offset = f * ENERGY_HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[offset + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let l = 0; l < LAYERS.length; l++) {
      let s = 0;
      for (let k = Math.max(1, edges[l]); k < edges[l + 1]; k++) s += re[k] * re[k] + im[k] * im[k];
      bands[l][f] = s;
    }
  }
  return bands;
}

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Analyse the whole song into 8th-note steps. A layer is "on" at a step when
 * it is louder than its own median over the surrounding four bars, so the
 * targets follow the arrangement as it changes. `onStage` reports progress.
 */
export async function analyzeSong(buffer, onStage = () => {}) {
  const duration = buffer.duration;
  const sr = buffer.sampleRate;
  onStage('Finding the tempo');
  await nextFrame();
  const windowStart = Math.max(0, Math.min(duration * 0.25, duration - TEMPO_WINDOW_SEC));
  const windowEnd = Math.min(duration, windowStart + TEMPO_WINDOW_SEC);
  const { bpm, beatOffsetSec } = estimateTempo(
    spectralFlux(monoSlice(buffer, windowStart, windowEnd)),
    sr / HOP,
  );
  const stepSec = 60 / bpm / 2;
  // Extend the beat grid found in the window back to the start of the song.
  const gridStart = (windowStart + beatOffsetSec) % stepSec;
  const count = Math.floor((duration - gridStart) / stepSec);
  if (count < 8) throw Error('The song is too short to play.');

  onStage('Listening to bass, body, vocals and highs');
  await nextFrame();
  const bands = bandEnergies(monoSlice(buffer, 0, duration), sr);
  const frameAt = (sec) => Math.max(0, Math.round((sec * sr - FFT_SIZE / 2) / ENERGY_HOP));
  const energy = bands.map((band) =>
    Float32Array.from({ length: count }, (_, k) => {
      const a = frameAt(gridStart + k * stepSec),
        b = Math.max(a + 1, frameAt(gridStart + (k + 1) * stepSec));
      let s = 0,
        n = 0;
      for (let f = a; f < b && f < band.length; f++, n++) s += band[f];
      return Math.sqrt(s / Math.max(1, n));
    }),
  );
  const loudest = energy.map((e) => Math.max(1e-12, ...e));
  const steps = Array.from({ length: count }, (_, k) => {
    const a = Math.max(0, k - LOCAL_STEPS),
      b = Math.min(count, k + LOCAL_STEPS);
    const on = [],
      level = [],
      weight = [];
    energy.forEach((e, l) => {
      const local = Array.from(e.subarray(a, b));
      const mid = median(local),
        top = Math.max(1e-12, ...local);
      // Near-silent passages never count as "on".
      on.push(e[k] > mid && e[k] > 0.02 * loudest[l]);
      level.push(e[k] / top);
      weight.push(0.5 + Math.min(1, Math.abs(e[k] - mid) / Math.max(1e-12, mid)));
    });
    return { time: gridStart + k * stepSec, on, level, weight };
  });
  return { bpm, stepSec, gridStart, duration, steps };
}
