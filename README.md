---
title: Fruit Fly Simulation
emoji: 🪰
colorFrom: purple
colorTo: purple
sdk: static
app_file: dist/index.html
pinned: false
license: apache-2.0
short_description: Simulate a fruit fly in your browser using WebGPU kernels
thumbnail: https://cdn-uploads.huggingface.co/production/uploads/61b253b7ac5ecaae3d1efe0c/0V_xp6SNzo4Hovk1KH63I.png
---

# Neural Canvas

A standalone fruit fly connectome demo: paint neurons, stimulate the network, and watch an articulated Three.js fly respond. Vanilla JavaScript, Vite, Three.js, and `@huggingface/kernels`.

Simulated neural activity drives crafted walking, turning, and flight animations. The movements are illustrative, not validated predictions of fly behavior.

It also has a **Fly Band** mode: upload a song and the simulated brain "plays" it. The song is split into four layers (Bass, Body, Vocals, Highs), each layer stimulates neurons that lead to one of four pads in front of the fly, and on playback you only hear the layers whose pads the fly's motor neurons actually pressed. A YouTube video of the song can play in sync on a TV behind the fly.

## Fly Band

### Using it

1. Click **Download & start** and wait for the brain to load.
2. Click **Band**, optionally paste a YouTube link for the TV, and drop in an audio file of the same song.
3. A progress bar shows the brain working through the whole song. This takes a while, because the simulation runs slower than real time.
4. Press **Play**. The song and the TV start together, the fly taps its pads, and only the layers it pressed are heard. **Original** plays the unfiltered song for comparison.

The finished take is saved in the browser (`localStorage`, last 8 songs), so loading the same file again is instant.

### How it works

**Song analysis** (`src/song-analysis.js`). The file is decoded with Web Audio. The tempo is estimated from spectral flux and autocorrelation, and the song is divided into an 8th-note step grid. Each step gets an energy value for four frequency bands: Bass < 160 Hz, Body 160–800 Hz, Vocals 800–3,500 Hz, Highs > 3,500 Hz. A layer counts as "on" at a step when it stands out from its local median over ±16 steps, with a guard against near-silence.

**Driving the brain** (`src/band.js`, `src/worker.js`). The brain runs in 10 ms batches of neural time, and each song step lasts 6 batches (60 ms). At the start of a step, every layer that is on stimulates its own neuron group with a steady input rate (the rate and duration were picked from strength/duration sweeps):

| Layer  | Stimulated neurons                   | Drive            | Pad readout (descending neurons) |
| ------ | ------------------------------------ | ---------------- | -------------------------------- |
| Bass   | LC9 (walking input)                  | 220 Hz for 20 ms | Walking: DNp09, DNg100, DNg97    |
| Body   | Left LC9 and DNa02 (turning)         | 80 Hz for 30 ms  | Turning: DNa02, DNa11, DNg13     |
| Vocals | pC1 courtship neurons                | 220 Hz for 30 ms | Wing song: pIP10, pMP2           |
| Highs  | Johnston's organ E neurons (antenna) | 50 Hz for 10 ms  | Grooming: DNg12                  |

If a group isn't found in the data, the closest hearing group stands in for it (Johnston's organ A/B neurons or excitatory auditory relay neurons).

**Reading the presses.** Over each 60 ms step, the firing rate of each pad's readout neurons is averaged. Above 20 Hz counts as a press. Activity spreads through the real MaleCNS wiring, so a layer is only pressed if its stimulus actually reaches those output neurons. The network adds latency, thresholds, crosstalk between pads, and lingering activity (grooming keeps going after its input stops).

**"Learning" the song.** The whole song is run through the brain once, step by step, before it can be played, and the presses for every step are recorded as the take. Nothing in the network changes: there is no plasticity or reward, so this is a recording of the connectome's response, not learned behavior. The match score compares presses with the "on" targets and is balanced, so 50% is what guessing scores.

**Playback** (`src/layer-player.js`). The decoded song plays through Linkwitz–Riley crossovers into four gain nodes. Each layer's gain is scheduled per step, open only where the fly pressed that pad. The pads glow and the front legs tap the pressed pads using per-pad foot targets and the existing leg inverse kinematics (`src/scene.js`, `src/gait.js`).

**TV** (`src/tv.js`). A muted YouTube IFrame player is placed in the 3D scene as a CSS3D object behind and above the fly. Play starts the video at the same position as the audio and corrects drift greater than 0.35 s every few seconds. The video must start at the same moment as the audio file, or the two will be offset. Because the video layer is always drawn over the 3D scene, the TV is shown only in the band camera view, where it is framed clear of the fly.

### Limitations

The layer-to-neuron mapping, drive strengths and threshold are design choices tuned for the demo. Bass and Body stimulate neurons close to the motor output instead of the fly's auditory pathway, so a good match score mostly reflects that tuning. Treat Fly Band as an interactive visualization of signals flowing through real wiring, not a model of how flies hear or respond to music.

## Run

Use Node.js 22.12 or newer.

```sh
npm install
npm run dev
```

Open the address printed by Vite, then click **Download & start**. All neural weights, fly meshes, fonts, and kernel templates are included in `public/`; setup loads them into the browser and caches verified weight chunks. No API key or external model service is required.

## Build

```sh
npm run build
npm run preview
```

Deploy the generated `dist/` directory to any static HTTPS host. Relative asset paths support deployment under a subdirectory. Use Vite or an HTTP server locally; opening `index.html` as a `file://` URL will not work. WebGPU requires HTTPS or localhost; JavaScript provides the compute fallback. Rendering requires WebGL2.

Serve the `.bin.gz` and `.json.gz` files as stored bytes, without adding a `Content-Encoding: gzip` header: the app decompresses them itself.

## Code

- `index.html`, `src/main.js`, `src/style.css`: interface, startup, and controls.
- `src/brain.js`, `src/brain-gpu.js`, `src/propagate-sparse.wgsl`: JavaScript and WebGPU simulation.
- `src/worker.js`, `src/data-loader.js`: worker protocol, downloads, caching, and checksums.
- `src/stimulus.js`, `src/controller.js`: painted inputs and neural-output-to-motion translation.
- `src/scene.js`, `src/gait.js`, `src/body/`: rendering, stable leg IK, and measured skeleton.
- `src/song-analysis.js`, `src/band.js`, `src/layer-player.js`, `src/tv.js`: Fly Band song analysis, brain-time song runner and saved takes, layered playback, and the YouTube TV.
- `public/data/`, `public/body/`, `public/kernels/`: complete local runtime assets.
- `public/model.json`: model parameters, provenance, and limitations.

The page passes its public asset base to the bundled worker so data and kernels resolve correctly in development and production. The custom propagation shader is imported as raw text. Three.js and the kernel runtime are exact pinned npm versions matching the working demo.

The ZIP includes the editable Vite source and a prebuilt `dist/` directory, ready for static HTTPS hosting. It excludes installed dependencies, deployment configuration, Git history, and development benchmarks. The source and build each include the connectome data so either can be used independently.

## Data and licenses

The simulation retains 166,700 MaleCNS entries from the brain and nerve cord and 25,582,938 directed connections. Recorded connectivity drives a leaky integrate-and-fire model adapted from Shiu et al. The original model's validation does not validate this transfer to MaleCNS or the demo's movements.

Computed firing rates control speed, turning, and flight. Smooth body trajectories and a crafted tripod gait are mapped onto the measured skeleton with joint-limited inverse kinematics. Movement gains, activation thresholds, and foot trajectories are chosen for the demo. There is no contact, muscle, or aerodynamic simulation, and body motion does not feed sensory signals back into the neural network. The visual body is a female NeuroMechFly specimen.

Walk stimulates bilateral LC9 neurons; turns stimulate same-side LC9 and DNa02; Fly stimulates bilateral LC4. Turning can remain visible with recurrent transmission disabled because DNa02 is directly stimulated. Action targets and pulse envelopes are engineered stimulation choices.

Original application code is MIT licensed. Dataset attribution and license details are in `LICENSE`, `licenses/`, `public/body/assets/NOTICE`, and `public/fonts/OFL.txt`. MaleCNS is CC BY 4.0; body assets and kernel packages are Apache-2.0; Three.js and body kinematic code are MIT; Inter is OFL; Lucide retains its ISC/MIT notices.

Sources: [MaleCNS](https://male-cns.janelia.org/download/), [NeuroMechFly body](https://github.com/NeLy-EPFL/fly-svg-maker/tree/152506d3471646f009480c81f34aefbaec29a6e5), [neural model](https://www.nature.com/articles/s41586-024-07763-9), [WebGPU kernels](https://huggingface.co/blog/webgpu-kernels).
