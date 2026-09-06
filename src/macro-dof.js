import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { BokehShader } from 'three/addons/shaders/BokehShader.js';

/** Reuse the beauty pass's depth. Transparent wings must not become opaque
 * depth sheets, and focusing must not require a second geometry render. */
export class MacroDOFPass extends ShaderPass {
  constructor(camera) {
    super(BokehShader, 'tColor');
    this.camera = camera;
    // Preserve the filtered coverage for the final backdrop composite.
    this.material.fragmentShader = this.material.fragmentShader.replace(
      'gl_FragColor.a = 1.0;',
      '',
    );
    this.material.defines.DEPTH_PACKING = 0;
    this.uniforms.aperture.value = 0.0012;
    this.uniforms.maxblur.value = 0.004;
  }
  setSize(width, height) {
    this.uniforms.aspect.value = width / height;
  }
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    this.uniforms.nearClip.value = this.camera.near;
    this.uniforms.farClip.value = this.camera.far;
    super.render(renderer, writeBuffer, readBuffer);
  }
}

export function attachDepthBuffers(composer, renderer) {
  for (const target of [composer.renderTarget1, composer.renderTarget2]) {
    target.depthTexture = new THREE.DepthTexture(
      target.width,
      target.height,
      THREE.UnsignedIntType,
    );
    target.samples = Math.min(2, renderer.capabilities.maxSamples);
  }
}
