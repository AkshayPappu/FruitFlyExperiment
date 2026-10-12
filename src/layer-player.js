/**
 * Plays the song through a four-way crossover, one gain per layer. Each layer
 * opens or mutes at every step according to what the fly pressed, so what the
 * brain pressed is what you hear.
 */
import { connectLayers } from './song-analysis.js';

const FADE_SEC = 0.01;
const LEAD_SEC = 0.06;

export class LivePlayer {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.gains = null;
    this.buffer = null;
    this.grid = null;
    this.gateFor = null;
    this.t0 = 0;
    this.offset = 0;
    this.onEnd = null;
  }

  get playing() {
    return Boolean(this.source);
  }

  _context() {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  /**
   * `grid` has `steps[k].time`; `gateFor(k, layer)` returns true/false, or
   * null when the fly hasn't played step k yet (treated as muted).
   */
  async start(buffer, grid, fromSec, gateFor, onEnd) {
    this.stop();
    this.buffer = buffer;
    this.grid = grid;
    this.gateFor = gateFor;
    this.onEnd = onEnd ?? null;
    this.offset = fromSec;
    const ctx = this._context();
    if (ctx.state === 'suspended') await ctx.resume();
    if (!this.playing && this.buffer === buffer) this._begin(this.offset);
  }

  /** Call from a click so the browser lets audio start later without one. */
  prepare() {
    void this._context().resume();
  }

  _begin(fromSec) {
    const ctx = this.ctx;
    this.offset = Math.max(0, Math.min(fromSec, this.buffer.duration - 0.05));
    this.t0 = ctx.currentTime + LEAD_SEC;
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    this.gains = connectLayers(ctx, source).map((layer) => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      layer.connect(gain).connect(ctx.destination);
      return gain;
    });
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      const done = this.onEnd;
      this.onEnd = null;
      done?.();
    };
    source.start(this.t0, this.offset);
    this.source = source;
    this.refresh();
  }

  /** Song time (seconds) currently being heard. */
  songTime() {
    if (!this.playing) return this.offset;
    return this.offset + Math.max(0, this.ctx.currentTime - this.t0);
  }

  currentStep() {
    if (!this.grid) return -1;
    const { steps } = this.grid;
    const t = this.songTime();
    const k = Math.floor((t - steps[0].time) / this.grid.stepSec);
    return Math.max(0, Math.min(steps.length - 1, k));
  }

  _schedule(k) {
    const step = this.grid.steps[k];
    if (!step) return;
    const at = this.t0 + (step.time - this.offset);
    const now = this.ctx.currentTime;
    if (at + this.grid.stepSec < now) return;
    this.gains.forEach(({ gain }, l) => {
      const open = this.gateFor(k, l) ? 1 : 0;
      const previous = k > 0 && this.gateFor(k - 1, l) ? 1 : 0;
      if (at <= now) {
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(open, now);
      } else if (open !== previous) {
        gain.setValueAtTime(previous, Math.max(now, at - FADE_SEC));
        gain.linearRampToValueAtTime(open, at);
      }
    });
  }

  /** Re-apply every gate from now on (after a resume or a listen-mode switch). */
  refresh() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const first = this.currentStep();
    this.gains.forEach(({ gain }, l) => {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(this.gateFor(first, l) ? 1 : 0, now);
    });
    for (let k = first + 1; k < this.grid.steps.length; k++) {
      if (this.gateFor(k, 0) === null) break;
      this._schedule(k);
    }
  }

  /** Stop the sound but remember where we were. */
  pause() {
    if (!this.playing) return;
    const at = this.songTime();
    this._teardown();
    this.offset = at;
  }

  resume() {
    if (this.playing || !this.buffer) return;
    this._begin(this.offset);
  }

  _teardown() {
    const source = this.source;
    this.source = null;
    try {
      source?.stop();
    } catch {
      /* Already stopped. */
    }
    source?.disconnect();
    for (const gain of this.gains ?? []) gain.disconnect();
    this.gains = null;
  }

  stop() {
    this._teardown();
    this.buffer = null;
    this.onEnd = null;
  }

  dispose() {
    this.stop();
    this.ctx?.close();
    this.ctx = null;
  }
}
