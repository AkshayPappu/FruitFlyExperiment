import './style.css';
import { configureAssetBase } from './data-loader.js';
import { BrainView } from './brain-view.js';
import { FlyScene } from './scene.js';
import { FlyController } from './controller.js';
import { populations } from './stimulus.js';
import { YouTubeTV, parseYouTubeId } from './tv.js';
import { decodeSong, analyzeSong, LAYERS } from './song-analysis.js';
import { LivePlayer } from './layer-player.js';
import { BandLive, STEP_BATCHES, matchScore, loadTake, saveTake, takeId } from './band.js';
const assetBase = new URL(import.meta.env.BASE_URL, document.baseURI).href;
configureAssetBase(assetBase);
const $ = (id) => document.getElementById(id);
let scene,
  view,
  groups,
  worker,
  ready = false,
  paused = false,
  pending = false,
  resetting = false,
  epoch = 0,
  generation = 0,
  watchdog,
  timer,
  backend = 'cpu',
  lastResult = 0,
  simRate = 0,
  assetsReady = false,
  preparing = false,
  loading = false,
  disposed = false;
const controller = new FlyController();
const tv = new YouTubeTV();
// One entry per in-flight simulation batch: the band step that drove it.
let batchContexts = [];
const livePlayer = new LivePlayer();
let songFile = null;
let songBuffer = null;
let bandAnalysis = null;
let bandAnalyzing = false;
// The live play-through; it supplies the drive for every batch while active.
let bandRunner = null;
let bandPlayhead = -1;
let listenMode = 'fly';
let bandVisRAF = 0;
function openSetup(title, detail, error = false) {
  $('workspace').inert = true;
  if (view) view.enabled = false;
  $('setup').dataset.state = error ? 'error' : 'loading';
  $('setup-status').textContent = title;
  $('setup-detail').textContent = detail;
  $('setup-button').disabled = !error;
  $('setup-button-label').textContent = error ? 'Try again' : 'Preparing…';
  $('setup-progress').hidden = error;
  $('setup-progress').removeAttribute('value');
  if (!$('setup').open) $('setup').showModal();
  if (error) $('setup-button').focus({ preventScroll: true });
}
function completeSetup() {
  $('setup').close();
  $('workspace').inert = false;
  view.enabled = true;
  $('compute-menu').open = false;
  $('brain').focus({ preventScroll: true });
}
async function setup() {
  if (preparing || loading || disposed) return;
  if (!assetsReady) {
    const loaded = await boot();
    if (!loaded) return;
  }
  void start();
}
function status(title, detail, error = false) {
  if (preparing || loading) {
    $('setup-status').textContent = title;
    $('setup-detail').textContent = detail;
  }
  $('status').textContent = title;
  $('status-detail').textContent = detail;
  $('compute-detail').textContent = title + ' · ' + detail;
  $('status-wrap').dataset.state = error
    ? 'error'
    : ready || (assetsReady && !loading)
      ? 'ready'
      : 'loading';
  $('status-wrap').setAttribute('aria-live', ready ? 'off' : 'polite');
  $('status-light').className =
    'status-light' + (error ? ' error' : ready && !paused ? ' live' : '');
  $('runtime-label').textContent = ready
    ? `${backend === 'gpu' ? 'WebGPU' : 'JavaScript'} · ${paused ? 'paused' : simRate.toFixed(2) + '×'}`
    : loading
      ? 'Loading…'
      : error
        ? 'Unavailable'
        : $('backend').value === 'cpu'
          ? 'JavaScript'
          : 'WebGPU · auto';
}
function selectAction(key) {
  for (const button of document.querySelectorAll('[data-preset]'))
    button.setAttribute('aria-pressed', button.dataset.preset === key ? 'true' : 'false');
}
function transport() {
  $('pause-label').textContent = paused ? 'Resume' : 'Pause';
  $('pause-icon').setAttribute('href', paused ? '#i-play' : '#i-pause');
}
function rangeTrack(input) {
  input.style.setProperty(
    '--range',
    ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100 +
      '%',
  );
}
function timeout(ms, message) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => fail(message), ms);
}
function fail(message) {
  clearTimeout(timer);
  clearTimeout(watchdog);
  worker?.terminate();
  worker = null;
  ready = false;
  pending = false;
  loading = false;
  resetting = false;
  epoch++;
  $('pause').disabled = $('reset').disabled = true;
  $('start').hidden = false;
  $('start').disabled = !assetsReady;
  $('start').textContent = 'Retry simulation';
  $('backend').disabled = false;
  $('progress').hidden = true;
  status('Simulation stopped', message, true);
  openSetup('Setup interrupted', message, true);
}
function sendPulse(indices, options = {}) {
  if (!ready || !indices.length) return;
  $('paint-hint').textContent = `${indices.length.toLocaleString()} neurons selected`;
  worker.postMessage({
    type: 'pulse',
    indices,
    strength: Number($('strength').value),
    profile: options.profile ?? 'paint',
    replace: options.replace === true,
  });
  request();
}
function request() {
  clearTimeout(timer);
  if (!ready || paused || pending || resetting || document.hidden) return;
  pending = true;
  let context = null;
  const next = bandRunner?.next();
  if (next) {
    worker.postMessage({ type: 'drive', rates: next.rates });
    context = next.context;
    context.runner = bandRunner;
    if (context.batch === 0) bandHighlight(next.rates);
  }
  batchContexts.push(context);
  worker.postMessage({
    type: 'step',
    generation,
    silenced: $('silence').checked,
  });
  timeout(60000, 'The neural calculation stopped responding. Retry with the JavaScript reference.');
}
function resetUI() {
  controller.reset();
  view.reset();
  scene.reset();
  lastResult = 0;
  simRate = 0;
  $('behavior').textContent = 'At rest';
  $('body-description').textContent = '';
  $('walk-rate').textContent = $('escape-rate').textContent = '0 Hz';
  $('turn-rate').textContent = '0°/s';
  $('turn-rate').title = 'No turn';
  $('turn-rate').setAttribute('aria-label', 'No turn');
  $('walk-meter').style.width = $('escape-meter').style.width = $('turn-meter').style.width = '0';
  $('turn-cursor').style.left = '50%';
  document.querySelector('.body-state').dataset.rest = 'true';
  selectAction(null);
}
async function start(forceCPU = false) {
  if (!assetsReady || loading || disposed) return;
  openSetup('Loading neural weights', 'Completed downloads are reused');
  if (forceCPU) $('backend').value = 'cpu';
  backend = 'cpu';
  loading = true;
  ready = false;
  pending = false;
  paused = false;
  resetting = false;
  generation = 0;
  batchContexts = [];
  const token = ++epoch;
  clearTimeout(timer);
  clearTimeout(watchdog);
  worker?.terminate();
  controller.reset();
  scene.reset();
  view.fc.clearRect(0, 0, view.w, view.h);
  view.tick = 0;
  view.pulseTick = 0;
  lastResult = 0;
  simRate = 0;
  $('start').disabled = true;
  $('backend').disabled = true;
  $('pause').disabled = $('reset').disabled = true;
  $('progress').hidden = false;
  $('progress').value = 0;
  status('Loading connectome', 'Completed downloads are reused');
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
    });
  } catch (error) {
    fail(error.message);
    return;
  }
  worker.onerror = (e) => {
    if (epoch === token) fail(e.message || 'Worker failed to start');
  };
  worker.onmessageerror = () => {
    if (epoch === token) fail('Could not decode a simulation response');
  };
  worker.onmessage = ({ data: m }) => {
    if (epoch !== token || disposed) return;
    if (m.type === 'stage') {
      status('Preparing simulation', m.message);
      timeout(180000, 'Simulation initialization timed out. Retry with JavaScript.');
    } else if (m.type === 'progress') {
      $('progress').value = m.value;
      $('setup-progress').value = m.value;
      status('Loading connectome', Math.round(m.value * 100) + '% · 76 MB, downloaded once');
      timeout(180000, 'The data download stalled. Retry to resume saved files.');
    } else if (m.type === 'fallback') {
      status('Using JavaScript', m.message);
      $('backend').value = 'cpu';
    } else if (m.type === 'ready') {
      clearTimeout(watchdog);
      ready = true;
      loading = false;
      backend = m.backend;
      $('progress').hidden = $('start').hidden = true;
      $('pause').disabled = $('reset').disabled = false;
      transport();
      $('backend').disabled = false;
      status(
        'Ready to paint',
        backend === 'gpu' ? 'WebGPU · @huggingface/kernels' : 'JavaScript reference',
      );
      completeSetup();
      updateBandUI();
      startLearning();
      if (view.selection.size) {
        view.pulseAt = performance.now();
        worker.postMessage({
          type: 'pulse',
          indices: Uint32Array.from(view.selection),
          strength: Number($('strength').value),
          profile: view.pulseProfile,
          replace: view.replacePulse,
        });
      }
      request();
    } else if (m.type === 'reset') {
      if (m.generation !== generation) return;
      clearTimeout(watchdog);
      pending = false;
      resetting = false;
      request();
    } else if (m.type === 'result') {
      const context = batchContexts.shift();
      if (m.generation !== generation || resetting) return;
      clearTimeout(watchdog);
      pending = false;
      if (context?.runner) bandObserve(context, m.rates);
      const now = performance.now(),
        elapsed = lastResult ? now - lastResult : m.wallMs;
      lastResult = now;
      const rate = (m.steps * 0.1) / Math.max(elapsed, 0.001);
      simRate = simRate ? simRate * 0.85 + rate * 0.15 : rate;
      const pose = controller.advance(m.rates, m.steps * 0.0001);
      scene.update(pose);
      view.result(m.firing, m.counts, m.tick);
      const r = controller.rates;
      $('behavior').textContent = bandRunner ? 'Learning the song' : pose.behavior;
      document.querySelector('.body-state').dataset.rest = String(
        paused || (!bandRunner && pose.behavior === 'At rest'),
      );
      $('body-description').textContent =
        pose.y > 0.05
          ? `${pose.y.toFixed(1)} mm high · ${controller.distance.toFixed(1)} mm travelled`
          : '';
      const walking = (r[0] + r[1]) / 2;
      $('walk-rate').textContent = Math.round(walking) + ' Hz';
      $('escape-rate').textContent = Math.round(r[5]) + ' Hz';
      const degrees = Math.round(Math.abs((pose.yawRate * 180) / Math.PI));
      $('turn-rate').textContent = degrees + '°/s';
      $('turn-rate').title = degrees ? `Turning ${pose.yawRate > 0 ? 'left' : 'right'}` : 'No turn';
      $('turn-rate').setAttribute(
        'aria-label',
        degrees
          ? `${degrees} degrees per second ${pose.yawRate > 0 ? 'left' : 'right'}`
          : 'No turn',
      );
      $('walk-meter').style.width = Math.min(100, (walking / 36) * 100) + '%';
      $('escape-meter').style.width = Math.min(100, (r[5] / 200) * 100) + '%';
      const turn = Math.max(-50, Math.min(50, (-pose.yawRate / 3.8) * 50));
      $('turn-meter').style.width = Math.abs(turn) + '%';
      $('turn-meter').style.left = (turn < 0 ? 50 + turn : 50) + '%';
      $('turn-cursor').style.left = 50 + turn + '%';
      status(
        paused ? 'Paused' : `${(m.tick * 0.0001).toFixed(2)} s neural time`,
        `${backend === 'gpu' ? 'WebGPU' : 'JavaScript'} · ${simRate.toFixed(2)}× realtime · ${m.total.toLocaleString()} spikes`,
      );
      timer = setTimeout(request, Math.max(0, 10 - m.wallMs));
    } else if (m.type === 'error') {
      if (backend === 'gpu' && !forceCPU) {
        fail('WebGPU stopped. Restarting with JavaScript.');
        void start(true);
      } else fail(m.message);
    }
  };
  timeout(180000, 'Initialization timed out. Retry to reuse saved downloads.');
  worker.postMessage({
    type: 'init',
    backend: forceCPU ? 'cpu' : $('backend').value,
    assetBase,
  });
}
async function boot() {
  preparing = true;
  openSetup('Preparing the scene', 'Loading brain anatomy and fly geometry');
  try {
    scene?.dispose();
    view?.dispose();
    scene = new FlyScene($('fly'));
    scene.onCameraChange = (mode) => {
      for (const camera of ['side', 'top', 'follow'])
        $('camera-' + camera).setAttribute('aria-pressed', mode === camera);
    };
    view = new BrainView($('brain'), sendPulse, (n) => {
      selectAction(null);
      $('replay').disabled = !n;
      $('paint-hint').textContent = n
        ? `${n.toLocaleString()} neurons selected`
        : 'Paint neurons. Release to stimulate.';
    });
    view.brush = Number($('size').value) / 2;
    scene.setDepthOfField($('depth-of-field').checked);
    const results = await Promise.allSettled([view.load(), scene.load()]);
    if (disposed) return false;
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    groups = populations(results[0].value);
    if (songFile) setBandMode(true);
    assetsReady = true;
    $('anatomy-status').hidden = true;
    $('start').disabled = false;
    return true;
  } catch (error) {
    fail(error.message);
    return false;
  } finally {
    preparing = false;
  }
}
$('setup-button').onclick = () => void setup();
$('setup').addEventListener('cancel', (event) => event.preventDefault());
$('start').onclick = () => void start();
$('replay').onclick = () => view?.pulse();
$('brush').onclick = () => {
  if (!view) return;
  view.mode = 'paint';
  $('brush').setAttribute('aria-pressed', 'true');
  $('erase').setAttribute('aria-pressed', 'false');
};
$('erase').onclick = () => {
  if (!view) return;
  view.mode = 'erase';
  $('brush').setAttribute('aria-pressed', 'false');
  $('erase').setAttribute('aria-pressed', 'true');
};
$('size').oninput = () => {
  if (view) view.brush = Number($('size').value) / 2;
  $('size-label').textContent = $('size').value + ' px';
  rangeTrack($('size'));
};
$('clear').onclick = () => {
  view?.clear();
  if (ready) worker.postMessage({ type: 'clear' });
};
$('projection').onchange = () => {
  if (view) {
    view.projection = $('projection').value;
    view.layout();
  }
};
for (const button of document.querySelectorAll('[data-preset]'))
  button.onclick = () => {
    if (!ready || !groups) return;
    const key = button.dataset.preset;
    view.preset(
      groups[key === 'escape' ? 'escapeInput' : key],
      key === 'left' || key === 'right' ? 'turn' : 'paint',
    );
    selectAction(key);
  };
$('pause').onclick = () => {
  if (!ready) return;
  paused = !paused;
  transport();
  document.querySelector('.body-state').dataset.rest = String(
    paused || $('behavior').textContent === 'At rest',
  );
  if (paused) {
    clearTimeout(timer);
    status('Paused', 'Painting will pulse when you resume');
  } else {
    lastResult = 0;
    status('Resumed', backend === 'gpu' ? 'WebGPU · @huggingface/kernels' : 'JavaScript reference');
    request();
  }
};
$('reset').onclick = () => {
  if (!ready || resetting) return;
  resetting = true;
  generation++;
  batchContexts = [];
  clearTimeout(timer);
  stopPlayback();
  bandRunner?.rewind();
  resetUI();
  updateBandUI();
  worker.postMessage({ type: 'reset', generation });
  timeout(60000, 'Reset did not complete');
};
$('backend').onchange = () => {
  if (ready) {
    ready = false;
    void start();
  } else if (!loading) status('Ready to paint', '166,700 neurons · 25.6 million connections');
};
$('depth-of-field').onchange = () => scene?.setDepthOfField($('depth-of-field').checked);
document.addEventListener('click', (event) => {
  if (!$('compute-menu').contains(event.target)) $('compute-menu').open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') $('compute-menu').open = false;
});
for (const camera of ['side', 'top', 'follow'])
  $('camera-' + camera).onclick = () => scene?.setCamera(camera);
$('settings-button').onclick = () => $('settings').showModal();
$('close-settings').onclick = () => $('settings').close();
$('settings').addEventListener('click', (e) => {
  if (e.target === $('settings')) {
    const r = $('settings').getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
      $('settings').close();
  }
});
$('strength').oninput = () => {
  $('strength-label').textContent = $('strength').value + ' Hz';
  rangeTrack($('strength'));
};
rangeTrack($('size'));
rangeTrack($('strength'));

/* ---- Band mode ---- */

function showSelection(indices) {
  if (!view) return;
  view.selectionDirty = true;
  view.selection = new Set(indices);
  view.pulseProfile = 'music';
  view.replacePulse = false;
  if (indices.length) {
    view.pulseAt = performance.now();
    view.pulseTick = view.tick;
  }
  view.onSelection(view.selection.size);
}

const ROLL_STEPS = 32;
// The fly's presses for the whole song once the brain has played it: { presses, cells }.
let bandTake = null;
let bandScore = null;

function setBandStatus(text, error = false) {
  const el = $('band-status');
  el.textContent = text;
  el.dataset.error = String(error);
}

const bandStartSec = () => Number($('music-seek').value) || 0;

function stepAt(sec) {
  const { steps, gridStart, stepSec } = bandAnalysis;
  return Math.max(0, Math.min(steps.length - 1, Math.floor((sec - gridStart) / stepSec)));
}

/** With a song loaded, the fly stands at its pads facing the TV view. */
function setBandMode(on) {
  controller.setBand(on);
  scene?.setBand(on);
}

async function analyseBand() {
  if (!songFile || bandAnalyzing) return;
  const file = songFile;
  bandAnalyzing = true;
  stopBand();
  updateBandUI();
  try {
    setBandStatus('Decoding the song…');
    if (!songBuffer) songBuffer = await decodeSong(file);
    if (file !== songFile) return;
    const analysis = await analyzeSong(songBuffer, (stage) => setBandStatus(stage + '…'));
    if (file !== songFile) return;
    bandAnalysis = analysis;
    $('music-seek').max = analysis.duration;
    $('music-controls').hidden = false;
    bandTake = loadTake(takeId(file, analysis), analysis);
    if (bandTake) bandReady('The fly already learned this song');
    else startLearning();
  } catch (error) {
    if (file === songFile) setBandStatus('Could not analyse this song: ' + error.message, true);
  } finally {
    bandAnalyzing = false;
    updateBandUI();
    if (file !== songFile) void analyseBand();
  }
}

/** Light up the neurons being stimulated (only groups driven hard enough to matter). */
function bandHighlight(rates) {
  if (!groups) return;
  showSelection(
    Object.entries(rates)
      .filter(([, rate]) => rate >= 40)
      .flatMap(([key]) => groups[key] ?? []),
  );
}

function bandObserve(context, rates) {
  const runner = context.runner;
  if (runner === bandRunner) runner.observe(context, rates);
}

function showPresses(k, presses) {
  bandAnalysis.steps[k].level.forEach((level, l) => {
    const pressed = presses?.[l];
    scene?.setPadLevel(l, pressed ? 0.35 + 0.65 * level : 0);
    if (pressed) scene?.hitPad(l);
  });
}

function clearPads() {
  for (let l = 0; l < LAYERS.length; l++) scene?.setPadLevel(l, 0);
}

/** Run the whole song through the brain, step by step, before it can be played. */
function startLearning() {
  if (!bandAnalysis || bandTake) return;
  if (!ready) {
    setBandStatus('Start the simulation (Download & start) and the fly will learn this song.');
    return;
  }
  if (!bandRunner) bandRunner = new BandLive(bandAnalysis, { onStep: learnedStep });
  bandLearnStatus();
  updateBandUI();
  request();
}

function bandLearnStatus() {
  const runner = bandRunner;
  const total = bandAnalysis.steps.length;
  const left = ((total - runner.known) * STEP_BATCHES * 0.01) / Math.max(simRate, 1e-3);
  const eta =
    runner.known < 3
      ? ''
      : left > 90
        ? ` · about ${Math.round(left / 60)} min left`
        : ` · about ${Math.max(1, Math.round(left))} s left`;
  setBandStatus(
    `The fly is learning the song: step ${runner.known} of ${total}${eta}. Keep this tab open.`,
  );
}

function learnedStep(k, presses) {
  const runner = bandRunner;
  showPresses(k, presses);
  bandPlayhead = k;
  if (!runner.done) {
    bandLearnStatus();
    updateBandUI();
    return;
  }
  bandTake = { presses: runner.presses, cells: runner.cells };
  saveTake(takeId(songFile, bandAnalysis), runner.presses);
  bandRunner = null;
  bandPlayhead = -1;
  if (ready) worker.postMessage({ type: 'drive', rates: {} });
  showSelection([]);
  clearPads();
  bandReady('The fly learned the whole song');
}

function bandReady(prefix) {
  const steps = bandAnalysis.steps;
  bandScore = matchScore(steps, bandTake.cells, 0, steps.length);
  setBandStatus(
    `${prefix}: ${Math.round(bandScore * 100)}% match (50% is guessing). Press Play to hear it.`,
  );
  updateBandUI();
}

/** Whether layer l is heard at step k. */
function bandGate(k, l) {
  if (listenMode === 'original') return true;
  return bandTake?.presses[k]?.[l] ?? false;
}

const formatTime = (sec) =>
  Math.floor(sec / 60) +
  ':' +
  Math.floor(sec % 60)
    .toString()
    .padStart(2, '0');

let tvSyncAt = 0;

function bandFrame(now) {
  bandVisRAF = requestAnimationFrame(bandFrame);
  if (!livePlayer.playing || !bandTake) return;
  const t = livePlayer.songTime();
  if (now - tvSyncAt > 3000) {
    tvSyncAt = now;
    tv.sync(t);
  }
  const k = livePlayer.currentStep();
  if (k === bandPlayhead) return;
  bandPlayhead = k;
  $('music-seek').value = t;
  $('music-time').textContent = formatTime(t);
  showPresses(k, bandTake.presses[k]);
  drawBandRoll();
}

function stopPlayback() {
  livePlayer.stop();
  tv.pause();
  cancelAnimationFrame(bandVisRAF);
  bandVisRAF = 0;
  if (!bandRunner) bandPlayhead = -1;
  $('music-button').setAttribute('aria-pressed', 'false');
  clearPads();
}

/** Forget the song's take and any learning in progress (a new song was loaded). */
function stopBand() {
  stopPlayback();
  const was = bandRunner;
  bandRunner = null;
  bandTake = null;
  bandScore = null;
  bandPlayhead = -1;
  if (was && ready) worker.postMessage({ type: 'drive', rates: {} });
  if (was) showSelection([]);
}

function startPlayback() {
  if (!bandTake || !songBuffer) return;
  stopPlayback();
  livePlayer.prepare();
  const at = bandAnalysis.steps[stepAt(bandStartSec())].time;
  tv.play(at);
  tvSyncAt = performance.now();
  void livePlayer.start(songBuffer, bandAnalysis, at, bandGate, () => {
    stopPlayback();
    setBandStatus('Song finished. Press Play to hear it again.');
    updateBandUI();
  });
  setBandStatus('Playing the fly’s take: each layer is heard only where the fly pressed its pad.');
  bandVisRAF = requestAnimationFrame(bandFrame);
  $('music-button').setAttribute('aria-pressed', 'true');
  // Get out of the way so the TV and the fly are both in view.
  $('music-dialog').close();
  scene?.setCamera('band');
  updateBandUI();
}

function updateBandUI() {
  if (!$('band-panel')) return;
  const playing = Boolean(bandVisRAF);
  $('band-play').disabled = !playing && (!bandTake || bandAnalyzing);
  $('band-play').textContent = playing ? 'Stop' : 'Play';
  $('band-play').setAttribute('aria-pressed', String(playing));
  const progress = $('band-progress');
  progress.hidden = !bandRunner;
  if (bandRunner) progress.value = bandRunner.progress;
  for (const button of document.querySelectorAll('[data-listen]'))
    button.setAttribute('aria-pressed', String(button.dataset.listen === listenMode));
  $('band-score').textContent = bandScore === null ? '–' : Math.round(bandScore * 100) + '%';
  drawBandRoll();
}

function canvasContext(canvas) {
  const dpr = Math.min(2, devicePixelRatio || 1),
    w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (!w || !h) return null;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

function drawBandRoll() {
  const c = canvasContext($('band-roll'));
  if (!c || !bandAnalysis) return;
  const { g, w, h } = c;
  const steps = bandAnalysis.steps,
    rows = LAYERS.length,
    labelW = 50;
  const head = bandPlayhead >= 0 ? bandPlayhead : stepAt(bandStartSec());
  const first = Math.max(0, Math.min(steps.length - ROLL_STEPS, head - 8));
  const cw = (w - labelW) / ROLL_STEPS,
    ch = h / rows,
    r = Math.min(cw, ch) * 0.26;
  g.font = '11px system-ui, sans-serif';
  g.textBaseline = 'middle';
  LAYERS.forEach((layer, l) => {
    g.fillStyle = layer.color;
    g.fillText(layer.label, 0, l * ch + ch / 2);
  });
  for (let i = 0; i < ROLL_STEPS && first + i < steps.length; i++) {
    const k = first + i,
      step = steps[k],
      cells = (bandRunner ?? bandTake)?.cells[k];
    // Presses the music hasn't reached yet are dimmed.
    const ahead = bandPlayhead >= 0 && k > bandPlayhead;
    for (let l = 0; l < rows; l++) {
      const x = labelW + i * cw,
        y = l * ch;
      g.globalAlpha = 1;
      g.fillStyle = '#232d38';
      g.fillRect(x + 1, y + 1, cw - 2, ch - 2);
      if (step.on[l]) {
        g.globalAlpha = 0.3 + 0.6 * step.level[l];
        g.fillStyle = LAYERS[l].color;
        g.fillRect(x + 1, y + 1, cw - 2, ch - 2);
      }
      const cell = cells?.[l];
      if (!cell || cell === 'rest') continue;
      g.globalAlpha = ahead ? 0.4 : 1;
      const cx = x + cw / 2,
        cy = y + ch / 2;
      g.lineWidth = 1.5;
      if (cell === 'hit') {
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.fill();
      } else if (cell === 'miss') {
        g.strokeStyle = '#f08080';
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.stroke();
      } else {
        g.strokeStyle = '#ff5d5d';
        g.beginPath();
        g.moveTo(cx - r, cy - r);
        g.lineTo(cx + r, cy + r);
        g.moveTo(cx + r, cy - r);
        g.lineTo(cx - r, cy + r);
        g.stroke();
      }
    }
  }
  g.globalAlpha = 1;
  g.fillStyle = '#0c141d';
  for (let i = 1; i < ROLL_STEPS; i++)
    if ((first + i) % 8 === 0) g.fillRect(labelW + i * cw - 1, 0, 2, h);
  if (bandPlayhead >= first && bandPlayhead < first + ROLL_STEPS) {
    g.strokeStyle = '#ffffffcc';
    g.lineWidth = 2;
    g.strokeRect(labelW + (bandPlayhead - first) * cw + 1, 1, cw - 2, h - 2);
  }
}

$('band-play').onclick = () => {
  if (bandVisRAF) {
    stopPlayback();
    setBandStatus('Stopped. Press Play to start again from the song slider.');
    updateBandUI();
  } else startPlayback();
};
for (const button of document.querySelectorAll('[data-listen]'))
  button.onclick = () => {
    listenMode = button.dataset.listen;
    livePlayer.refresh();
    updateBandUI();
  };
$('music-seek').oninput = () => {
  const t = bandStartSec();
  $('music-time').textContent = formatTime(t);
  if (bandVisRAF) return;
  tv.seek(t);
  drawBandRoll();
};
$('music-button').onclick = () => {
  $('music-dialog').showModal();
  updateBandUI();
};
$('close-music').onclick = () => $('music-dialog').close();
$('music-dialog').addEventListener('click', (e) => {
  if (e.target === $('music-dialog')) {
    const r = $('music-dialog').getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
      $('music-dialog').close();
  }
});

function handleMusicFile(file) {
  if (!file || !file.type.startsWith('audio/')) return;
  songFile = file;
  songBuffer = null;
  bandAnalysis = null;
  stopBand();
  setBandMode(true);
  $('music-seek').value = 0;
  $('music-time').textContent = formatTime(0);
  $('track-name').textContent = file.name;
  $('track-info').hidden = false;
  $('band-panel').hidden = false;
  $('drop-label').textContent = 'Drop another file to change track';
  updateBandUI();
  void analyseBand();
}

$('music-file').onchange = (e) => {
  if (e.target.files[0]) handleMusicFile(e.target.files[0]);
};

const dropZone = $('drop-zone');
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleMusicFile(e.dataTransfer.files[0]);
});

$('yt-load').onclick = () => loadYouTubeUrl();
$('yt-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadYouTubeUrl();
  }
});

async function loadYouTubeUrl() {
  const id = parseYouTubeId($('yt-url').value);
  const status = $('yt-status');
  if (!id) {
    status.hidden = false;
    status.dataset.error = 'true';
    status.textContent = 'Paste a YouTube watch, youtu.be, or embed URL.';
    return;
  }
  status.hidden = false;
  status.dataset.error = 'false';
  status.textContent = 'Loading video on the TV…';
  scene?.setTVVideo(id);
  try {
    await tv.load(id);
    tv.seek(bandStartSec());
    status.textContent = songFile
      ? 'TV ready. It plays along when you press Play.'
      : 'TV ready. Now upload the same song as an audio file.';
  } catch {
    status.dataset.error = 'true';
    status.textContent = 'Could not load the YouTube player.';
    scene?.setTVVideo(null);
  }
}

document.querySelector('.body-state').dataset.rest = 'true';
document.addEventListener('visibilitychange', () => {
  lastResult = 0;
  if (document.hidden) {
    clearTimeout(timer);
    clearTimeout(watchdog);
  } else {
    if (loading) timeout(180000, 'Initialization did not resume. Retry loading.');
    else if (pending || resetting) timeout(60000, 'The simulation did not resume. Retry loading.');
    request();
  }
});
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    disposed = true;
    clearTimeout(timer);
    clearTimeout(watchdog);
    worker?.terminate();
    livePlayer.dispose();
    view?.dispose();
    scene?.dispose();
  }
});
// The HTML overlay is visible before modules load; upgrade it to a native modal.
$('setup').close();
$('setup').showModal();
