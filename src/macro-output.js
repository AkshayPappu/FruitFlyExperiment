import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Finish the linear, premultiplied scene and composite it over an authored
 * display-space backdrop. Keep this pass last, including when DOF is disabled.
 */
export class MacroOutputPass extends OutputPass {
  constructor() {
    super();
    this.material.name = 'MacroOutputShader';
    // Plain arrays deliberately retain the authored sRGB values: THREE.Color
    // would convert these CSS colors to linear before the output transform.
    this.uniforms.backdropEdge = { value: [16 / 255, 23 / 255, 29 / 255] };
    this.uniforms.backdropCenter = { value: [32 / 255, 42 / 255, 53 / 255] };
    this.uniforms.backdropAspect = { value: 1 };
    const sample = 'gl_FragColor = texture2D( tDiffuse, vUv );';
    if (!this.material.fragmentShader.includes(sample))
      throw new Error('MacroOutputPass: unsupported OutputShader sampling statement');
    this.material.fragmentShader = this.material.fragmentShader
      .replace(
        'uniform sampler2D tDiffuse;',
        `uniform sampler2D tDiffuse;
    uniform vec3 backdropEdge;
    uniform vec3 backdropCenter;
    uniform float backdropAspect;`,
      )
      .replace(
        sample,
        `${sample}
    float sceneAlpha = clamp( gl_FragColor.a, 0.0, 1.0 );
    // Normal blending into transparent black and the DOF filter both leave
    // premultiplied linear RGB. Nonlinear transforms require straight RGB.
    gl_FragColor.rgb = sceneAlpha > 0.000001
     ? gl_FragColor.rgb / sceneAlpha : vec3( 0.0 );`,
      )
      .replace(
        /\}\s*$/,
        `
    // Backdrop gradient in display-space sRGB.
    vec2 backdropPosition = vUv - vec2( 0.54, 0.48 );
    backdropPosition.x *= mix( 1.0, clamp( backdropAspect, 0.65, 2.0 ), 0.35 );
    backdropPosition.y *= 1.10;
    float backdropLight = 1.0 - smoothstep( 0.04, 0.75, length( backdropPosition ) );
    vec3 backdrop = mix( backdropEdge, backdropCenter, backdropLight );
    #ifndef SRGB_TRANSFER
     backdrop = sRGBTransferEOTF( vec4( backdrop, 1.0 ) ).rgb;
    #endif
    gl_FragColor = vec4( mix( backdrop, gl_FragColor.rgb, sceneAlpha ), 1.0 );
   }`,
      );
    this.material.needsUpdate = true;
  }

  setSize(width, height) {
    this.uniforms.backdropAspect.value = width / Math.max(height, 1);
  }
}
