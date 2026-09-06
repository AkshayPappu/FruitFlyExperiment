import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
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
  cameraFit,
  cameraPullback,
  cameraTarget,
} from './camera-config.js';
const clamp = THREE.MathUtils.clamp;
const POSE_FIELDS = Object.keys(restPose()).filter((key) => key !== 'behavior');
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
      new THREE.LineBasicMaterial({ color: 0x7ee2d5, transparent: true, opacity: 0.22 }),
    );
    this.scene.add(this.trail);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
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
  setCamera(view) {
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damping;
    this.cameraView = view;
    this.trackHeading = view === 'follow';
    this.cameraYaw = this.pose.yaw;
    this.fitScale = cameraFit(view, this.camera.aspect);
    this.pullback = cameraPullback(this.pose);
    this.controls.target.fromArray(cameraTarget(this.pose));
    this.camera.up.set(0, 0, 1);
    this.camera.position
      .copy(this.controls.target)
      .add(
        new THREE.Vector3(...CAMERA_OFFSETS[view])
          .applyAxisAngle(new THREE.Vector3(0, 0, 1), view === 'follow' ? this.pose.yaw : 0)
          .multiplyScalar(this.fitScale * this.pullback),
      );
    this.controls.update();
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
    this.texture.offset.set(p.z / 2, p.x / 2);
    this.key.position.set(p.z + 2, p.x - 4, 7);
    this.key.target.position.set(p.z, p.x, 0);
  }
  render(now) {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.render);
    if (document.hidden) return;
    const t = clamp((now - this.arrival) / this.interval, 0, 1),
      p = {};
    for (const key of POSE_FIELDS)
      p[key] = this.previous[key] + (this.next[key] - this.previous[key]) * t;
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
  }
}
