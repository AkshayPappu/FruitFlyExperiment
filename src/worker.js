import { loadGraph, configureAssetBase } from './data-loader.js';
import { BrainCPU } from './brain.js';
import { PulseBank, populations, decodeCounts } from './stimulus.js';
let graph,
  brain,
  groups,
  pulses,
  backend = 'cpu',
  generation = 0;
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue
    .then(() => handle(data))
    .catch((error) => postMessage({ type: 'error', message: error.message, generation }));
};
async function handle(m) {
  if (m.type === 'init') {
    configureAssetBase(m.assetBase);
    graph = await loadGraph(
      (value) => postMessage({ type: 'progress', value }),
      (message) => postMessage({ type: 'stage', message }),
    );
    // Shiu's monoamine convention; histamine/unknown remain omitted in this adaptation.
    graph.neurons.forEach((r, i) => {
      if (['dopamine', 'octopamine', 'serotonin'].includes(r[4])) graph.sign[i] = 1;
    });
    groups = populations(graph.neurons);
    pulses = new PulseBank(graph.n);
    if (m.backend !== 'cpu')
      try {
        postMessage({ type: 'stage', message: 'Checking WebGPU against JavaScript…' });
        const { BrainGPU } = await import('./brain-gpu.js');
        const { checkGPU } = await import('./gpu-check.js');
        await checkGPU((g) => BrainGPU.create(g));
        postMessage({ type: 'stage', message: 'Preparing resident connectome and motor readout…' });
        brain = await BrainGPU.create(graph);
        await brain.prepareReadout(groups);
        backend = 'gpu';
      } catch (error) {
        brain?.destroy?.();
        postMessage({ type: 'fallback', message: error.message });
        brain = new BrainCPU(graph);
        backend = 'cpu';
      }
    else brain = new BrainCPU(graph);
    postMessage({ type: 'ready', backend });
  } else if (m.type === 'pulse') {
    if (m.replace) pulses.reset();
    pulses.add(m.indices, brain.tick, m.strength, m.profile ?? 'paint');
  } else if (m.type === 'reset') {
    generation = m.generation;
    await brain.reset();
    pulses.reset();
    postMessage({ type: 'reset', generation });
  } else if (m.type === 'clear') {
    pulses.reset();
  } else if (m.type === 'step') {
    if (m.generation !== generation) return;
    const started = performance.now(),
      steps = 100;
    const result = await brain.batch(steps, pulses.sample(brain.tick), m.silenced);
    const reference = decodeCounts(result.counts, groups, steps);
    let rates = reference;
    if (backend === 'gpu') {
      rates = result.rates;
      for (let c = 0; c < rates.length; c++)
        if (
          !Number.isFinite(rates[c]) ||
          Math.abs(rates[c] - reference[c]) > 1e-3 * Math.max(1, reference[c])
        )
          throw Error('GPU population readout disagrees with JavaScript');
    }
    const ids = [],
      values = [];
    for (let i = 0; i < result.counts.length; i++)
      if (result.counts[i]) {
        ids.push(i);
        values.push(result.counts[i]);
      }
    const firing = Uint32Array.from(ids),
      counts = Uint16Array.from(values);
    postMessage(
      {
        type: 'result',
        generation,
        tick: result.tick,
        steps,
        total: result.total,
        rates,
        firing,
        counts,
        wallMs: performance.now() - started,
      },
      [rates.buffer, firing.buffer, counts.buffer],
    );
  }
}
