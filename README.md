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