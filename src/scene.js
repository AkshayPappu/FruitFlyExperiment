import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { parseBinarySTL, transformVertices } from './body/stl.js';
import { Gait } from './gait.js';
import { requestBytes } from './data-loader.js';
import { restPose } from './controller.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { MacroOutputPass } from './macro-output.js';
import { MacroDOFPass, attachDepthBuffers } from './macro-dof.js';
import {
  createFlyMaterial,
  cloneFlyMaterial,
  createBristleMaterial,
  addFlyBristles,
} from './fly-appearance.js';
import {
  CAMERA_FOV,
  CAMERA_OFFSETS,
  BAND_FOCUS,
  cameraFit,
  cameraPullback,
  cameraTarget,
} from './camera-config.js';
const clamp = THREE.MathUtils.clamp;
const POSE_FIELDS = Object.keys(restPose()).filter((key) => key !== 'behavior');
// The TV stands behind the fly (world offset from the fly), turned to face the camera and raised
// on a stand so its screen sits above the fly in the band view: the screen is drawn over the scene.
const TV_SIZE = [9, 5.0625];
const TV_OFFSET = [0, 3];
const TV_LIFT = 2;
const TV_YAW = Math.atan2(CAMERA_OFFSETS.side[0], -CAMERA_OFFSETS.side[1]);
const PAD_COLORS = [0xff7a59, 0xf2c14e, 0x5ad1a8, 0x6ea8ff];
const PAD_ANGLES = [0.62, 0.21, -0.21, -0.62];
const PAD_RADIUS = 1.9;
const PAD_POSITIONS = PAD_ANGLES.map((a) => [PAD_RADIUS * Math.cos(a), PAD_RADIUS * Math.sin(a)]);
// Foot heights (level frame, fly origin): touching a pad top, and hovering between strikes.
const FOOT_CONTACT_Z = 0.25;
const FOOT_HOVER_Z = 0.45;
const TAP_MS = 180;
// When one leg has two pads to strike in a step, the second follows this much later.
const TAP_GAP_MS = 90;
const BAND_TAU = 0.25;
/** Pad dip over a tap, peaking when the foot lands mid-tap. */
const tapCurve = (age) => (age >= 0 && age < TAP_MS ? Math.sin((Math.PI * age) / TAP_MS) : 0);
const lerp3 = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
/** Weld duplicate vertices before computing smooth normals. */
function geometryFor(raw, scale, mirror) {
  const positions = transformVertices(raw, scale, mirror);
  if (mirror)
    for (let i = 0; i < positions.length; i += 9)
      for (let k = 0; k < 3; k++) {
        const t = positions[i + 3 + k];
        positions[i + 3 + k] = positions[i + 6 + k];
        positions[i + 6 + k] = t;
      }
  const unique = [],
    indices = [],
    lookup = new Map();
  for (let i = 0; i < positions.length; i += 3) {
    const key = [positions[i], positions[i + 1], positions[i + 2]]
      .map((v) => Math.round(v * 1e5))
      .join(',');
    let ix = lookup.get(key);
    if (ix === undefined) {
      ix = unique.length / 3;
      lookup.set(key, ix);
      unique.push(positions[i], positions[i + 1], positions[i + 2]);
    }
    indices.push(ix);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(unique, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
export class FlyScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(1.5, devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.03, 100);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.minDistance = 3.5;
    this.controls.maxDistance = 18;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.target.set(-0.4, 0, 0.68);
    this.controls.enablePan = false;
    this.orbitStart = () => {
      this.trackHeading = false;
      this.onCameraChange?.('free');
    };
    this.controls.addEventListener('start', this.orbitStart);
    this.composer = new EffectComposer(this.renderer);
    attachDepthBuffers(this.composer, this.renderer);
    this.beautyPass = new RenderPass(this.scene, this.camera);
    this.dof = new MacroDOFPass(this.camera);
    this.outputPass = new MacroOutputPass();
    this.composer.addPass(this.beautyPass);
    this.composer.addPass(this.dof);
    this.composer.addPass(this.outputPass);
    this.depthOfField = true;
    this.focusPoint = new THREE.Vector3();
    this.scene.add(new THREE.HemisphereLight(0xdce8ff, 0x4c3928, 1.6));
    this.key = new THREE.DirectionalLight(0xffe6c6, 4.2);
    this.key.position.set(2, -4, 7);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    Object.assign(this.key.shadow.camera, {
      left: -5,
      right: 5,
      top: 5,
      bottom: -5,
      near: 0.1,
      far: 20,
    });
    this.key.shadow.bias = -0.00015;
    this.key.shadow.normalBias = 0.012;
    this.scene.add(this.key, this.key.target);
    const rim = new THREE.DirectionalLight(0xc9ddff, 2.6);
    rim.position.set(-3, 4, 4);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xe0d4cf, 1.1);
    fill.position.set(4, 3, 2);
    this.scene.add(fill);
    // Seeded, seamless fine grain and short fibres on an authored 2 mm ground tile.
    const canvasTex = document.createElement('canvas');
    canvasTex.width = canvasTex.height = 1024;
    const context = canvasTex.getContext('2d'),
      img = context.createImageData(1024, 1024);
    let seed = 47;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < img.data.length; i += 4) {
      const c = 100 + random() * 33;
      img.data[i] = c;
      img.data[i + 1] = c;
      img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
    context.putImageData(img, 0, 0);
    context.lineWidth = 0.7;
    for (let i = 0; i < 6500; i++) {
      const x = random() * 1024,
        y = random() * 1024,
        angle = random() * Math.PI * 2,
        length = 4 + random() * 13,
        dx = Math.cos(angle) * length,
        dy = Math.sin(angle) * length;
      context.strokeStyle = `rgba(${i % 2 ? '190,190,190' : '45,45,45'},.36)`;
      for (const ox of [-1024, 0, 1024])
        for (const oy of [-1024, 0, 1024]) {
          context.beginPath();
          context.moveTo(x + ox, y + oy);
          context.quadraticCurveTo(
            x + ox + dx * 0.4 - dy * 0.3,
            y + oy + dy * 0.4 + dx * 0.3,
            x + ox + dx,
            y + oy + dy,
          );
          context.stroke();
        }
    }
    this.texture = new THREE.CanvasTexture(canvasTex);
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.repeat.set(80, 80);
    this.texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x202832,
      roughness: 0.96,
      bumpMap: this.texture,
      bumpScale: 0.005,
      transparent: true,
    });
    // Fade the distant ground into the display-space backdrop, preserving contact
    // texture and shadows near the specimen. vViewPosition.z is positive depth.
    this.floorFadeStart = { value: 9 };
    floorMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.floorFadeStart = this.floorFadeStart;
      shader.fragmentShader =
        'uniform float floorFadeStart;\n' +
        shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          'diffuseColor.a *= 1.0 - smoothstep(floorFadeStart, floorFadeStart + 15.0, vViewPosition.z);\n#include <opaque_fragment>',
        );
    };
    floorMaterial.customProgramCacheKey = () => 'macro-ground-distance-fade-v1';
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), floorMaterial);
    this.floor.receiveShadow = true;
    this.floor.renderOrder = -1;
    this.floor.position.z = -0.015;
    this.scene.add(this.floor);
    this.fly = new THREE.Group();
    this.fly.rotation.order = 'ZYX';
    this.scene.add(this.fly);
    this.meshes = [];
    this.wingEchoes = [];
    this.materials = new Map();
    this.bristleMaterial = createBristleMaterial();
    this.pose = restPose();
    this.previous = { ...this.pose };
    this.next = { ...this.pose };
    this.arrival = performance.now();
    this.interval = 100;
    this.follow = true;
    this.path = new Float32Array(9000);
    this.pathCount = 0;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.path, 3));
    pg.setDrawRange(0, 0);
    this.trail = new THREE.Line(
      pg,
      new THREE.LineBasicMaterial({
        color: 0x7ee2d5,
        transparent: true,
        opacity: 0.22,
      }),
    );
    this.scene.add(this.trail);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.cssScene = new THREE.Scene();
    this.cssRenderer = new CSS3DRenderer();
    this.cssRenderer.domElement.className = 'tv-layer';
    canvas.parentElement.appendChild(this.cssRenderer.domElement);
    this._buildTV();
    this._buildBand();
    this.resize();
    this.setCamera('side');
    this.render = this.render.bind(this);
    this.frame = requestAnimationFrame(this.render);
  }
  async load() {
    this.model = JSON.parse(
      new TextDecoder().decode(await requestBytes('./body/assets/model.json')),
    );
    this.gait = new Gait(this.model);
    const files = [...new Set(Object.values(this.model.meshes).map((m) => m.file))],
      raw = new Map();
    // Four asset downloads at a time, avoiding a burst of 39 simultaneous requests.
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (cursor < files.length) {
          const name = files[cursor++];
          raw.set(name, parseBinarySTL(await requestBytes('./body/assets/meshes/' + name)));
        }
      }),
    );
    if (this.disposed) return;
    for (const [name, m] of Object.entries(this.model.meshes)) {
      const wing = name.includes('wing'),
        eye = name.endsWith('eye');
      let key = wing
        ? 'wing'
        : eye
          ? 'eye'
          : name.includes('abdomen')
            ? 'abdomen'
            : name.includes('tarsus') || name.includes('arista')
              ? 'dark'
              : 'cuticle';
      if (!this.materials.has(key)) this.materials.set(key, createFlyMaterial(key));
      const mesh = new THREE.Mesh(
        geometryFor(raw.get(m.file), this.model.meshScale, m.mirror),
        this.materials.get(key),
      );
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = !wing;
      mesh.receiveShadow = !wing;
      this.fly.add(mesh);
      this.meshes.push({ name, mesh });
      addFlyBristles(mesh, name, this.bristleMaterial);
      if (name === 'c_head') {
        mesh.geometry.computeBoundingSphere();
        this.focusMesh = mesh;
      }
      if (wing) {
        for (const phaseOffset of [(-Math.PI * 2) / 3, (Math.PI * 2) / 3]) {
          const material = cloneFlyMaterial(mesh.material);
          material.opacity = 0;
          const echo = new THREE.Mesh(mesh.geometry, material);
          echo.matrixAutoUpdate = false;
          echo.visible = false;
          this.fly.add(echo);
          this.wingEchoes.push({ name, mesh: echo, phaseOffset });
        }
      }
    }
    // RAF may have evaluated the resting gait while meshes were downloading.
    this.lastGaitTime = undefined;
    this.applyPose(this.pose);
  }

  _buildTV() {
    const w = TV_SIZE[0],
      h = TV_SIZE[1],
      depth = 0.14;
    const plastic = new THREE.MeshStandardMaterial({
      color: 0x1a1d24,
      roughness: 0.45,
      metalness: 0.25,
    });
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, depth, h + 0.2), plastic);
    bezel.castShadow = true;
    bezel.receiveShadow = true;
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, TV_LIFT), plastic);
    neck.position.z = -(h + TV_LIFT) / 2;
    neck.castShadow = true;
    const stand = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 0.1), plastic);
    stand.position.z = -(h / 2 + TV_LIFT) + 0.05;
    stand.receiveShadow = true;
    this.tv = new THREE.Group();
    this.tv.add(bezel, neck, stand);
    this.tv.position.set(TV_OFFSET[0], TV_OFFSET[1], h / 2 + TV_LIFT);
    this.tv.rotation.z = TV_YAW;
    this.scene.add(this.tv);

    this.tvAnchor = new THREE.Object3D();
    this.tvAnchor.position.set(0, -depth / 2 - 0.01, 0);
    this.tvAnchor.rotation.x = Math.PI / 2;
    this.tv.add(this.tvAnchor);

    const host = document.createElement('div');
    host.style.width = '640px';
    host.style.height = '360px';
    host.style.border = '0';
    host.style.background = '#0b0d12';
    host.style.overflow = 'hidden';
    const mount = document.createElement('div');
    mount.id = 'yt-tv-frame';
    mount.style.width = '640px';
    mount.style.height = '360px';
    host.appendChild(mount);
    this.tvScreen = new CSS3DObject(host);
    host.style.pointerEvents = 'none';
    const s = w / 640;
    this.tvScreen.scale.set(s, s, s);
    this.cssScene.add(this.tvScreen);
    this.tv.visible = false;
    this.tvScreen.visible = false;
  }

  _buildBand() {
    this.band = false;
    this.bandBlend = 0;
    this.bandGroup = new THREE.Group();
    this.bandGroup.visible = false;
    const rimMaterial = new THREE.MeshStandardMaterial({
      color: 0x22262e,
      roughness: 0.5,
      metalness: 0.4,
    });
    this.pads = PAD_COLORS.map((color, i) => {
      const holder = new THREE.Group();
      holder.position.set(...PAD_POSITIONS[i], 0);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.4, 0.12, 40), rimMaterial);
      rim.rotation.x = Math.PI / 2;
      rim.position.z = 0.06;
      rim.castShadow = rim.receiveShadow = true;
      const material = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.1,
        roughness: 0.35,
        metalness: 0.1,
      });
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 40), material);
      top.rotation.x = Math.PI / 2;
      top.position.z = 0.135;
      top.castShadow = top.receiveShadow = true;
      holder.add(rim, top);
      this.bandGroup.add(holder);
      return { top, material, level: 0, target: 0, hitAt: -Infinity };
    });
    // Left front leg plays pads 0-1, right front leg pads 2-3; each hovers between its pair.
    this.taps = [[], []];
    this.feet = [null, null];
    this.footRest = [0, 2].map((i) => [
      (PAD_POSITIONS[i][0] + PAD_POSITIONS[i + 1][0]) / 2,
      (PAD_POSITIONS[i][1] + PAD_POSITIONS[i + 1][1]) / 2,
      FOOT_HOVER_Z,
    ]);
    this.scene.add(this.bandGroup);
  }

  /** Band mode: show the pads and hold the fly in a forward-leaning playing stance. */
  setBand(on) {
    const was = this.band;
    this.band = Boolean(on);
    if (this.band) this.bandGroup.visible = true;
    if (!this.band) for (const pad of this.pads) pad.target = 0;
    if (this.band !== was) this.setCamera(this.band ? 'band' : 'side');
  }

  setPadLevel(i, level) {
    const pad = this.pads?.[i];
    if (pad) pad.target = clamp(level, 0, 1);
  }

  /** A press: the front leg on that side strikes this pad, which dips as the foot lands. */
  hitPad(i) {
    const pad = this.pads?.[i];
    if (!pad) return;
    const now = performance.now();
    const queue = this.taps[i < 2 ? 0 : 1];
    const last = queue[queue.length - 1];
    const at = last ? Math.max(now, last.at + TAP_GAP_MS) : now;
    queue.push({ pad: i, at, from: null });
    pad.hitAt = at;
  }

  /** Foot target for one front leg in the level pad frame: hover, or mid-strike. */
  _footTarget(side, now) {
    const queue = this.taps[side];
    while (queue.length > 1 && queue[1].at <= now) queue.shift();
    const rest = this.footRest[side];
    let target = rest;
    const tap = queue[0];
    if (tap && tap.at <= now) {
      const u = (now - tap.at) / TAP_MS;
      if (u >= 1) queue.shift();
      else {
        // Leave from wherever the foot was, land on the pad mid-tap, return to hover.
        tap.from ??= this.feet[side] ?? rest;
        const base = lerp3(tap.from, rest, u);
        target = lerp3(base, [...PAD_POSITIONS[tap.pad], FOOT_CONTACT_Z], Math.sin(Math.PI * u));
        target[2] += 0.2 * Math.max(0, Math.sin(2 * Math.PI * u));
      }
    }
    this.feet[side] = target;
    return target;
  }

  _bandPose(p, now) {
    const dt = this.lastBandRender ? clamp((now - this.lastBandRender) / 1000, 0, 0.05) : 0;
    this.lastBandRender = now;
    this.bandBlend += ((this.band ? 1 : 0) - this.bandBlend) * (1 - Math.exp(-dt / BAND_TAU));
    for (const pad of this.pads) {
      pad.level += (pad.target - pad.level) * (1 - Math.exp(-dt / 0.06));
      const dip = tapCurve(now - pad.hitAt);
      pad.material.emissiveIntensity = 0.1 + 1.8 * pad.level + 0.8 * dip;
      pad.top.position.z = 0.135 - 0.04 * dip;
    }
    if (!this.band && this.bandBlend < 0.002) {
      this.bandBlend = 0;
      this.bandGroup.visible = false;
      return p;
    }
    this.bandGroup.position.set(p.z, p.x, 0);
    this.bandGroup.rotation.set(0, 0, p.yaw);
    const w = this.bandBlend;
    const pitch = p.pitch + 0.08 * w;
    // The legs are solved in the body frame, which pitches with the fly.
    const c = Math.cos(pitch),
      s = Math.sin(pitch);
    const toBody = ([x, y, z]) => [c * x - s * (z - p.y), y, s * x + c * (z - p.y)];
    return {
      ...p,
      pitch,
      time: now / 1000,
      bandWeight: w,
      bandFeet: [0, 1].map((side) => toBody(this._footTarget(side, now))),
    };
  }

  setTVVideo(videoId) {
    if (!this.tvScreen) return;
    this.tvOn = Boolean(videoId);
    this._showTV();
    if (this.tvOn) return;
    const frame = this.tvScreen.element.querySelector('iframe') || this.tvScreen.element;
    if (frame.src) frame.src = 'about:blank';
  }

  /** The screen is drawn over the scene, so it is only framed clear of the fly in the band view. */
  _showTV() {
    if (!this.tvScreen) return;
    this.tv.visible = this.tvScreen.visible = Boolean(this.tvOn) && this.cameraView === 'band';
  }

  setCamera(view) {
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damping;
    this.cameraView = view;
    this.trackHeading = view === 'follow';
    this.cameraYaw = this.pose.yaw;
    this.fitScale = cameraFit(view, this.camera.aspect);
    this.controls.maxDistance = 24 * this.fitScale;
    this.pullback = cameraPullback(this.pose);
    this.controls.target.fromArray(cameraTarget(this.pose));
    if (view === 'band') this.controls.target.add(new THREE.Vector3(...BAND_FOCUS));
    this.camera.up.set(0, 0, 1);
    this.camera.position
      .copy(this.controls.target)
      .add(
        new THREE.Vector3(...CAMERA_OFFSETS[view])
          .applyAxisAngle(new THREE.Vector3(0, 0, 1), view === 'follow' ? this.pose.yaw : 0)
          .multiplyScalar(this.fitScale * this.pullback),
      );
    this.controls.update();
    this._showTV();
    this.onCameraChange?.(view);
  }
  setDepthOfField(enabled) {
    this.depthOfField = enabled;
    this.dof.enabled = enabled;
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(1.5, devicePixelRatio || 1, Math.sqrt(1200000 / (r.width * r.height)));
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(r.width, r.height, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(r.width, r.height);
    this.camera.aspect = r.width / r.height;
    const surface = this.canvas.closest('.fly-surface'),
      top =
        surface.querySelector('.fly-head').getBoundingClientRect().height +
        surface.querySelector('.response-bar').getBoundingClientRect().height,
      bottom = surface.querySelector('.specimen-line').getBoundingClientRect().height;
    this.camera.setViewOffset(r.width, r.height, 0, -(top - bottom) / 2, r.width, r.height);
    this.camera.updateProjectionMatrix();
    const fit = cameraFit(this.cameraView, this.camera.aspect);
    this.controls.maxDistance = 24 * fit;
    this.camera.position
      .sub(this.controls.target)
      .multiplyScalar(fit / this.fitScale)
      .add(this.controls.target);
    this.fitScale = fit;
    this.controls.update();
    if (this.cssRenderer) {
      this.cssRenderer.setSize(r.width, r.height);
      const layer = this.cssRenderer.domElement;
      layer.style.position = 'absolute';
      layer.style.inset = '0';
      layer.style.pointerEvents = 'none';
    }
  }
  update(pose) {
    const now = performance.now();
    this.previous = { ...this.pose };
    this.next = { ...pose };
    this.interval = clamp(now - this.arrival, 10, 1000);
    this.arrival = now;
  }
  applyPose(p) {
    const target = new THREE.Vector3(...cameraTarget(p)),
      delta = target.sub(new THREE.Vector3(...cameraTarget(this.pose)));
    if (this.follow) {
      this.camera.position.add(delta);
      this.controls.target.add(delta);
    }
    if (this.trackHeading) {
      const dt = Math.max(0, p.time - this.pose.time),
        turn = (p.yaw - this.cameraYaw) * (1 - Math.exp(-dt / 0.16));
      this.camera.position
        .sub(this.controls.target)
        .applyAxisAngle(new THREE.Vector3(0, 0, 1), turn)
        .add(this.controls.target);
      this.cameraYaw += turn;
    }
    const pullback = cameraPullback(p);
    this.camera.position
      .sub(this.controls.target)
      .multiplyScalar(pullback / this.pullback)
      .add(this.controls.target);
    this.pullback = pullback;
    this.pose = { ...p };
    this.fly.position.set(p.z, p.x, p.y);
    this.fly.rotation.set(p.bank || 0, p.pitch || 0, p.yaw, 'ZYX');
    if (this.gait && this.lastGaitTime !== p.time) {
      this.lastGaitTime = p.time;
      const transforms = this.gait.update(p);
      for (const { name, mesh } of this.meshes) {
        mesh.matrix.set(...transforms[name]);
        mesh.matrixWorldNeedsUpdate = true;
      }
    }
    // Wing exposures use interpolated neural time, so pause freezes them.
    // Only wing transforms are repeated; the six-leg IK is solved once per pose.
    if (this.gait) {
      const blur = clamp(((p.wingOpen || 0) - 0.7) / 0.3, 0, 1);
      for (const phaseOffset of [(-Math.PI * 2) / 3, (Math.PI * 2) / 3]) {
        const echoes = this.wingEchoes.filter((e) => e.phaseOffset === phaseOffset);
        const transforms = blur > 0 ? this.gait.wingTransforms(p, phaseOffset) : null;
        for (const { name, mesh } of echoes) {
          mesh.visible = blur > 0;
          if (transforms) {
            mesh.material.opacity = 0.065 * blur;
            mesh.matrix.set(...transforms[name]);
            mesh.matrixWorldNeedsUpdate = true;
          }
        }
      }
    }
    this.floor.position.x = p.z;
    this.floor.position.y = p.x;
    this.tv.position.x = p.z + TV_OFFSET[0];
    this.tv.position.y = p.x + TV_OFFSET[1];
    this.texture.offset.set(p.z / 2, p.x / 2);
    this.key.position.set(p.z + 2, p.x - 4, 7);
    this.key.target.position.set(p.z, p.x, 0);
  }
  render(now) {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.render);
    if (document.hidden) return;
    const t = clamp((now - this.arrival) / this.interval, 0, 1);
    let p = {};
    for (const key of POSE_FIELDS)
      p[key] = this.previous[key] + (this.next[key] - this.previous[key]) * t;
    if (this.band || this.bandBlend > 0) p = this._bandPose(p, now);
    this.applyPose(p);
    if (Math.hypot(p.x - (this.lastPathX ?? 0), p.z - (this.lastPathZ ?? 0)) > 0.08) {
      this.lastPathX = p.x;
      this.lastPathZ = p.z;
      if (this.pathCount === 3000) {
        this.path.copyWithin(0, 3);
        this.pathCount--;
      }
      this.path.set([p.z, p.x, p.y + 0.005], this.pathCount++ * 3);
      this.trail.geometry.attributes.position.needsUpdate = true;
      this.trail.geometry.setDrawRange(0, this.pathCount);
      this.trail.geometry.computeBoundingSphere();
    }
    this.controls.update();
    this.floorFadeStart.value = Math.max(
      9,
      this.camera.position.distanceTo(this.controls.target) + 2,
    );
    const origin = this.controls.target.clone(),
      right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).add(origin);
    const a = origin.project(this.camera),
      b = right.project(this.camera);
    const pixels = (Math.abs(b.x - a.x) * this.canvas.clientWidth) / 2,
      unit = pixels > 180 ? 0.5 : 1;
    document.getElementById('scale-bar').style.width = pixels * unit + 'px';
    document.getElementById('scale-value').textContent = unit + ' mm';
    if (this.depthOfField) {
      this.fly.updateMatrixWorld(true);
      this.camera.updateMatrixWorld();
      if (this.focusMesh)
        this.focusPoint
          .copy(this.focusMesh.geometry.boundingSphere.center)
          .applyMatrix4(this.focusMesh.matrixWorld);
      else this.focusPoint.copy(this.controls.target);
      this.focusPoint.applyMatrix4(this.camera.matrixWorldInverse);
      this.dof.uniforms.focus.value = Math.max(this.camera.near, -this.focusPoint.z);
    }
    this.composer.render();
    if (this.cssRenderer && this.tvAnchor && this.tvScreen) {
      this.tvAnchor.updateWorldMatrix(true, false);
      this.tvScreen.position.setFromMatrixPosition(this.tvAnchor.matrixWorld);
      this.tvScreen.quaternion.setFromRotationMatrix(this.tvAnchor.matrixWorld);
      this.cssRenderer.render(this.cssScene, this.camera);
    }
  }
  reset() {
    const zero = restPose();
    this.gait = new Gait(this.model);
    this.lastGaitTime = undefined;
    this.applyPose(zero);
    if (this.trackHeading) this.setCamera('follow');
    this.previous = { ...zero };
    this.next = { ...zero };
    this.pathCount = 0;
    this.lastPathX = this.lastPathZ = 0;
    this.trail.geometry.setDrawRange(0, 0);
    this.arrival = performance.now();
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.controls.removeEventListener('start', this.orbitStart);
    this.controls.dispose();
    const geometries = new Set(),
      materials = new Set();
    this.scene.traverse((o) => {
      if (o.geometry) geometries.add(o.geometry);
      if (o.material) materials.add(o.material);
    });
    materials.add(this.bristleMaterial);
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    this.texture.dispose();
    this.key.shadow.dispose();
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.cssRenderer?.domElement.remove();
    const host = this.tvScreen?.element;
    const frame = host?.querySelector?.('iframe') || host;
    if (frame?.src) frame.src = 'about:blank';
  }
}
