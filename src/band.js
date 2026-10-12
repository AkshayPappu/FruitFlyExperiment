/**
 * Band mode: each pad is pressed by the brain's own motor neurons. At every
 * step of the song, each layer that stands out stimulates the upstream
 * neurons that reach its pad; whatever the motor neurons actually do decides
 * which layers are heard. Everything is counted in simulation batches
 * (10 ms neural).
 */
import { LAYERS } from './song-analysis.js';

export const PADS = LAYERS.map((l) => l.key);
/** Readout CHANNELS feeding each pad: walking, turning, song, grooming. */
export const PAD_CHANNELS = Object.freeze([[0, 1], [2, 3], [7], [6]]);
/** Mean step rate (Hz) that counts as a press; resting rates are ~0 Hz. */
export const PAD_THRESHOLD_HZ = Object.freeze([20, 20, 20, 20]);
/**
 * Which neurons each layer stimulates, how hard and for how many batches,
 * chosen from strength/duration sweeps on this connectome. Grooming lingers
 * after its input stops, so the highs get a short, gentle pulse.
 */
export const PAD_DRIVES = Object.freeze([
  { key: 'walk', rate: 220, batches: 2 },
  { key: 'left', rate: 80, batches: 3 },
  { key: 'courtship', rate: 220, batches: 3 },
  { key: 'joE', rate: 50, batches: 1 },
]);
export const STEP_BATCHES = 6;

export function padRates(rates) {
  return PAD_CHANNELS.map((channels) => Math.max(...channels.map((c) => rates[c] ?? 0)));
}

function cellFor(on, pressed) {
  return on ? (pressed ? 'hit' : 'miss') : pressed ? 'false' : 'rest';
}

/** Balanced score, so pressing everything (or nothing) scores 50%. */
export function matchScore(steps, cells, from, to) {
  let hit = 0,
    miss = 0,
    wrong = 0,
    rest = 0;
  for (let k = from; k < to; k++)
    for (const cell of cells[k] ?? [])
      if (cell === 'hit') hit++;
      else if (cell === 'miss') miss++;
      else if (cell === 'false') wrong++;
      else rest++;
  if (!hit && !miss && !wrong && !rest) return null;
  const half = (a, b) => (b ? a / b : 0.5);
  return 0.5 * (half(hit, hit + miss) + half(rest, rest + wrong));
}

export function cellsFor(analysis, presses) {
  return presses.map((p, k) => p.map((pressed, l) => cellFor(analysis.steps[k].on[l], pressed)));
}

/**
 * Feeds the whole song to the brain step by step, in brain time, and records
 * which pads the motor neurons pressed at every step.
 */
export class BandLive {
  constructor(analysis, { onStep } = {}) {
    this.analysis = analysis;
    this.onStep = onStep;
    this.k = 0;
    this.batch = 0;
    this.sums = null;
    this.epoch = 0;
    this.cells = [];
    this.presses = [];
    this.known = 0;
    this.done = false;
  }

  get progress() {
    return this.known / this.analysis.steps.length;
  }

  next() {
    const steps = this.analysis.steps;
    if (this.k >= steps.length) return null;
    if (this.batch === 0) this.sums = [0, 0, 0, 0];
    const rates = {};
    steps[this.k].on.forEach((on, l) => {
      const drive = PAD_DRIVES[l];
      if (on && this.batch < drive.batches)
        rates[drive.key] = Math.max(rates[drive.key] ?? 0, drive.rate);
    });
    const context = {
      kind: 'play',
      k: this.k,
      batch: this.batch,
      sums: this.sums,
      epoch: this.epoch,
    };
    if (++this.batch === STEP_BATCHES) {
      this.batch = 0;
      this.k++;
    }
    return { rates, context };
  }

  /** Restart the unfinished step, e.g. after a brain reset; batches in flight are ignored. */
  rewind() {
    this.epoch++;
    this.k = this.known;
    this.batch = 0;
  }

  observe(context, rates) {
    if (context.epoch !== this.epoch) return;
    const { sums, k } = context;
    padRates(rates).forEach((r, l) => (sums[l] += r / STEP_BATCHES));
    if (context.batch !== STEP_BATCHES - 1) return;
    const step = this.analysis.steps[k];
    const presses = sums.map((hz, l) => hz > PAD_THRESHOLD_HZ[l]);
    this.presses[k] = presses;
    this.cells[k] = presses.map((pressed, l) => cellFor(step.on[l], pressed));
    this.known = k + 1;
    if (this.known >= this.analysis.steps.length) this.done = true;
    this.onStep?.(k, presses);
  }
}

const TAKE_KEY = 'neural-canvas-band-takes-v1';
const TAKES_KEPT = 8;

/** Identifies a learned song: the file, its step grid and the stimulus settings. */
export function takeId(file, analysis) {
  const drives = PAD_DRIVES.map((d) => `${d.key}${d.rate}x${d.batches}`).join(',');
  return `${file.name}|${file.size}|${analysis.steps.length}|${drives}`;
}

function readTakes() {
  try {
    return JSON.parse(localStorage.getItem(TAKE_KEY)) ?? {};
  } catch {
    return {};
  }
}

/** A previously learned song: `{ presses, cells }`, or null. */
export function loadTake(id, analysis) {
  const saved = readTakes()[id];
  if (typeof saved !== 'string' || saved.length !== analysis.steps.length) return null;
  const presses = [...saved].map((ch) => {
    const bits = parseInt(ch, 16);
    return PADS.map((_, l) => Boolean(bits & (1 << l)));
  });
  return { presses, cells: cellsFor(analysis, presses) };
}

export function saveTake(id, presses) {
  const takes = readTakes();
  delete takes[id];
  takes[id] = presses
    .map((p) => p.reduce((bits, on, l) => bits | (on ? 1 << l : 0), 0).toString(16))
    .join('');
  const ids = Object.keys(takes);
  for (const old of ids.slice(0, Math.max(0, ids.length - TAKES_KEPT))) delete takes[old];
  try {
    localStorage.setItem(TAKE_KEY, JSON.stringify(takes));
  } catch {
    /* Storage full or unavailable: the take just isn't remembered. */
  }
}
