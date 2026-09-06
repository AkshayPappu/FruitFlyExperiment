import { requestBytes } from './data-loader.js';
/** Soma coordinates projected into canvas space for rendering and hit tests. */
export class BrainView {
  constructor(canvas, onPulse, onSelection) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.base = document.createElement('canvas');
    this.bc = this.base.getContext('2d');
    this.selectedLayer = document.createElement('canvas');
    this.sc = this.selectedLayer.getContext('2d');
    this.fireLayer = document.createElement('canvas');
    this.fc = this.fireLayer.getContext('2d');
    this.selectionDirty = true;
    this.onPulse = onPulse;
    this.onSelection = onSelection;
    this.neurons = [];
    this.points = [];
    this.selection = new Set();
    this.brush = 21;
    this.mode = 'paint';
    this.pulseProfile = 'paint';
    this.replacePulse = false;
    this.projection = 'brain';
    this.tick = 0;
    this.lastTickAt = performance.now();
    this.hover = null;
    this.enabled = false;
    this.spark = document.createElement('canvas');
    this.spark.width = this.spark.height = 48;
    const glow = this.spark.getContext('2d'),
      gradient = glow.createRadialGradient(24, 24, 0, 24, 24, 24);
    gradient.addColorStop(0, '#fff8df');
    gradient.addColorStop(0.08, '#ffe59d');
    gradient.addColorStop(0.22, '#ffbf57ad');
    gradient.addColorStop(0.55, '#ffaa3329');
    gradient.addColorStop(1, '#ff922000');
    glow.fillStyle = gradient;
    glow.fillRect(0, 0, 48, 48);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.down = (e) => {
      if (!this.enabled || !this.neurons.length || e.button !== 0) return;
      e.preventDefault();
      canvas.focus();
      canvas.setPointerCapture(e.pointerId);
      this.pointer = e.pointerId;
      this.dragging = true;
      this.last = null;
      this.segment(e);
    };
    this.move = (e) => {
      if (!this.enabled) return;
      this.hover = this.local(e);
      if (this.dragging && this.pointer === e.pointerId) this.segment(e);
      this.tooltip();
    };
    this.up = (e) => {
      if (this.pointer !== e.pointerId) return;
      this.dragging = false;
      this.last = null;
      this.pointer = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      this.finish();
    };
    this.leave = () => {
      if (!this.dragging) this.hover = null;
      document.getElementById('neuron-tooltip').hidden = true;
    };
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.move);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('pointercancel', this.up);
    canvas.addEventListener('pointerleave', this.leave);
    this.animate = this.animate.bind(this);
    this.frame = requestAnimationFrame(this.animate);
  }
  async load() {
    const bytes = await requestBytes('./data/neurons.json.gz');
    const json = await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text();
    this.neurons = JSON.parse(json);
    this.resize();
    return this.neurons;
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    const dpr = Math.min(2, devicePixelRatio || 1);
    for (const c of [this.canvas, this.base, this.selectedLayer, this.fireLayer]) {
      c.width = Math.round(this.w * dpr);
      c.height = Math.round(this.h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.bc.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.sc.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fc.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.layout();
  }
  layout() {
    this.selectionDirty = true;
    // Projection changes the view; hit tests retain the original neuron indices.
    const brain = this.projection === 'brain',
      angle = brain ? (25 * Math.PI) / 180 : 0;
    const centerX = brain ? -48075.50325 : -48000,
      centerY = brain ? 37479.76546015124 : 72500;
    const spanX = brain ? 90971.2755 : 92000,
      spanY = brain ? 41180.64216351028 : 127000;
    const scale = Math.min(Math.max(1, this.w - 36) / spanX, Math.max(1, this.h - 36) / spanY);
    const sine = Math.sin(angle),
      cosine = Math.cos(angle);
    this.points = [];
    this.byIndex = new Map();
    this.grid = new Map();
    this.cell = 24;
    this.neurons.forEach((r, i) => {
      const p = r[6];
      if (!p || p[2] > (brain ? 58000 : 136000) || p[2] < 9000) return;
      const x = this.w / 2 + (-p[0] - centerX) * scale,
        y = this.h / 2 + (p[1] * sine + p[2] * cosine - centerY) * scale,
        v = { i, x, y };
      this.points.push(v);
      this.byIndex.set(i, v);
      const k = `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(v);
    });
    this.bc.clearRect(0, 0, this.w, this.h);
    this.bc.fillStyle = '#add5f1';
    this.bc.globalAlpha = 0.72;
    this.bc.beginPath();
    for (const p of this.points) {
      this.bc.moveTo(p.x + 0.65, p.y);
      this.bc.arc(p.x, p.y, 0.65, 0, Math.PI * 2);
    }
    this.bc.fill();
    this.bc.globalAlpha = 1;
  }
  tooltip() {
    const tip = document.getElementById('neuron-tooltip');
    if (this.dragging || !this.hover) {
      tip.hidden = true;
      return;
    }
    const { x, y } = this.hover;
    let nearest,
      dist = 36;
    const gx = Math.floor(x / this.cell),
      gy = Math.floor(y / this.cell);
    for (let a = gx - 1; a <= gx + 1; a++)
      for (let b = gy - 1; b <= gy + 1; b++)
        for (const p of this.grid.get(`${a},${b}`) ?? []) {
          const d = (p.x - x) ** 2 + (p.y - y) ** 2;
          if (d < dist) {
            nearest = p;
            dist = d;
          }
        }
    if (!nearest) {
      tip.hidden = true;
      return;
    }
    const r = this.neurons[nearest.i];
    tip.textContent = `${r[1] || 'Unclassified type'}${r[3] ? ' · ' + (r[3] === 'L' ? 'Left' : r[3] === 'R' ? 'Right' : r[3]) : ''}\n${r[4] || 'Unknown transmitter'}\nDataset ID ${r[0]}`;
    tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(this.w - 240, x + 18)) + 'px';
    tip.style.top = Math.max(6, Math.min(this.h - 82, y + 18)) + 'px';
  }
  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  segment(e) {
    const point = this.local(e),
      start = this.last ?? point;
    const dx = point.x - start.x,
      dy = point.y - start.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(2, this.brush * 0.3)));
    for (let k = 0; k <= steps; k++)
      this.stamp(start.x + (dx * k) / steps, start.y + (dy * k) / steps);
    this.last = point;
    this.onSelection(this.selection.size);
  }
  stamp(x, y) {
    this.pulseProfile = 'paint';
    this.replacePulse = false;
    this.selectionDirty = true;
    const r = this.brush;
    for (let gx = Math.floor((x - r) / this.cell); gx <= Math.floor((x + r) / this.cell); gx++)
      for (let gy = Math.floor((y - r) / this.cell); gy <= Math.floor((y + r) / this.cell); gy++)
        for (const p of this.grid.get(`${gx},${gy}`) ?? []) {
          if ((p.x - x) ** 2 + (p.y - y) ** 2 <= r * r) {
            if (this.mode === 'erase') this.selection.delete(p.i);
            else this.selection.add(p.i);
          }
        }
  }
  finish() {
    if (this.enabled && this.mode === 'paint' && this.selection.size) this.pulse();
  }
  pulse() {
    if (!this.enabled || !this.selection.size) return;
    this.pulseAt = performance.now();
    this.pulseTick = this.tick;
    this.onPulse(Uint32Array.from(this.selection), {
      profile: this.pulseProfile,
      replace: this.replacePulse,
    });
  }
  preset(indices, profile = 'paint') {
    this.pulseProfile = profile;
    this.replacePulse = true;
    this.selectionDirty = true;
    this.selection = new Set(indices);
    this.onSelection(this.selection.size);
    this.pulse();
  }
  clear() {
    this.pulseProfile = 'paint';
    this.replacePulse = false;
    this.selectionDirty = true;
    this.selection.clear();
    this.onSelection(0);
  }
  result(indices, counts, tick) {
    this.tick = tick;
    this.lastTickAt = performance.now();
    const c = this.fc;
    c.clearRect(0, 0, this.w, this.h);
    c.fillStyle = '#ffd180';
    for (let bucket = 0; bucket < 3; bucket++) {
      c.globalAlpha = [0.55, 0.8, 1][bucket];
      c.beginPath();
      for (let j = 0; j < indices.length; j++) {
        if (Math.min(2, Math.floor((counts[j] - 1) / 3)) !== bucket) continue;
        const p = this.byIndex.get(indices[j]);
        if (!p) continue;
        c.moveTo(p.x + 1.4, p.y);
        c.arc(p.x, p.y, 1.4, 0, Math.PI * 2);
      }
      c.fill();
    }
    c.globalAlpha = 1;
    let halos = 0;
    for (let j = 0; j < indices.length && halos < 48; j++) {
      if (counts[j] < 2) continue;
      const p = this.byIndex.get(indices[j]);
      if (!p) continue;
      const radius = 5 + Math.min(6, counts[j]) * 1.4;
      c.drawImage(this.spark, p.x - radius, p.y - radius, radius * 2, radius * 2);
      halos++;
    }
  }
  animate(now) {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    if (document.hidden) return;
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);
    c.drawImage(this.base, 0, 0, this.w, this.h);
    const age = (now - (this.pulseAt ?? -10000)) / 1000,
      pulse =
        (this.pulseProfile === 'turn'
          ? Math.exp(
              -Math.max(0, (this.tick - (this.pulseTick ?? this.tick)) * 0.0001 - 0.65) / 0.4,
            )
          : Math.exp(-age * 1.7)) *
        (1 + 0.18 * Math.sin(age * 11));
    if (this.selectionDirty) {
      const s = this.sc;
      s.clearRect(0, 0, this.w, this.h);
      s.fillStyle = '#bba0ff';
      s.beginPath();
      for (const i of this.selection) {
        const p = this.byIndex.get(i);
        if (!p) continue;
        s.moveTo(p.x + 1, p.y);
        s.arc(p.x, p.y, 1, 0, Math.PI * 2);
      }
      s.fill();
      this.selectionDirty = false;
    }
    c.globalAlpha = 0.34 + 0.66 * pulse;
    c.drawImage(this.selectedLayer, 0, 0, this.w, this.h);
    c.globalAlpha = Math.max(0, 1 - (now - this.lastTickAt) / 700);
    c.drawImage(this.fireLayer, 0, 0, this.w, this.h);
    c.globalAlpha = 1;
    if (this.hover) {
      c.strokeStyle = this.mode === 'erase' ? '#eab2b2bb' : '#b696ffdb';
      c.lineWidth = 1.6;
      c.beginPath();
      c.arc(this.hover.x, this.hover.y, this.brush, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = this.mode === 'erase' ? '#ffc1c109' : '#ab83ff0d';
      c.fill();
    }
  }
  reset() {
    this.fc.clearRect(0, 0, this.w, this.h);
    this.tick = 0;
    this.clear();
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    for (const [type, fn] of [
      ['pointerdown', this.down],
      ['pointermove', this.move],
      ['pointerup', this.up],
      ['pointercancel', this.up],
      ['pointerleave', this.leave],
    ])
      this.canvas.removeEventListener(type, fn);
  }
}
