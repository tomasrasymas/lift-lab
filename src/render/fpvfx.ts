import * as THREE from 'three';

export interface FpvParams {
  analog: boolean;     // analog 5.8 GHz look vs HD digital
  lq: number;          // video link quality 0..1
  time: number;
  distortion: number;  // barrel distortion strength (fisheye)
  lens: boolean;       // false = rectilinear gimbal camera (DJI-style)
}

/**
 * Renders the scene into an offscreen target and applies an FPV camera look:
 * wide-angle barrel distortion, chromatic aberration, vignette, and either
 * analog interference (noise, snow, line jitter, breakup) or digital artefacts
 * (macroblocking, frozen frames) driven by the video link quality.
 */
export class FpvEffect {
  private rt: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  private frozenFor = 0;

  constructor(samples: number) {
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples });
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        uTime: { value: 0 }, uAnalog: { value: 0 }, uLQ: { value: 1 }, uK: { value: 0.3 },
        uAspect: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) }, uLens: { value: 1 },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uTime, uAnalog, uLQ, uK, uAspect, uLens;
        uniform vec2 uRes;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          p.x *= uAspect;
          float R2 = 1.0 + uAspect * uAspect;
          float r2 = dot(p, p);
          // barrel distortion: centre magnified, edges compressed (wide-angle FPV lens)
          float k = uK * uLens;
          vec2 q = p * (1.0 + k * r2) / (1.0 + k * R2);
          q.x /= uAspect;
          vec2 uv = q * 0.5 + 0.5;
          float bad = 1.0 - uLQ;
          if (uAnalog > 0.5) {
            float line = floor(vUv.y * 260.0);
            float tear = (hash(vec2(line, floor(uTime * 40.0))) - 0.5) * 0.03 * bad * bad * 3.0;
            float hsync = step(0.985 - bad * 0.25, hash(vec2(floor(uTime * 12.0), 7.0))) * (hash(vec2(line * 0.1, uTime)) - 0.5) * 0.05;
            uv.x += tear + hsync;
          } else if (uLQ < 0.35) {
            float blocks = mix(28.0, 160.0, smoothstep(0.05, 0.35, uLQ));
            vec2 bs = vec2(blocks * uAspect, blocks);
            uv = (floor(uv * bs) + 0.5) / bs;
          }
          vec2 dir = uv - 0.5;
          float ca = (uAnalog > 0.5 ? 0.007 : 0.0035) * r2 * uLens;
          vec3 col;
          col.r = texture2D(tDiffuse, uv + dir * ca).r;
          col.g = texture2D(tDiffuse, uv).g;
          col.b = texture2D(tDiffuse, uv - dir * ca).b;
          if (uAnalog > 0.5) {
            vec3 c2 = texture2D(tDiffuse, uv + vec2(2.5 / uRes.x, 0.0)).rgb;
            vec3 c3 = texture2D(tDiffuse, uv - vec2(1.5 / uRes.x, 0.0)).rgb;
            col = col * 0.5 + c2 * 0.3 + c3 * 0.2;               // soft, smeared analog picture
            float luma = dot(col, vec3(0.299, 0.587, 0.114));
            col = mix(vec3(luma), col, 0.8) * 1.05;
            float n = hash(floor(vUv * uRes * 0.5) + fract(uTime * 7.13) * 91.0);
            float snow = 0.07 + bad * bad * 1.5;
            col = mix(col, vec3(n * 1.1), clamp(snow, 0.0, 0.92) * 0.55);
            col *= 0.9 + 0.1 * sin(vUv.y * uRes.y * 1.5708);
            float bar = fract(vUv.y * 0.7 + uTime * 0.23);
            col *= 1.0 - 0.07 * smoothstep(0.92, 1.0, bar);
            if (uLQ < 0.14) col = vec3(dot(col, vec3(0.33)) * 1.1);
          } else {
            col *= 1.02;
          }
          // lens vignette
          float vig = smoothstep(uLens > 0.5 ? 1.75 : 2.3, 0.55, length(p));
          col *= mix(uAnalog > 0.5 ? 0.15 : 0.35, 1.0, vig);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat));
  }

  setSize(w: number, h: number) {
    this.rt.setSize(w, h);
    this.mat.uniforms.uAspect.value = w / h;
    this.mat.uniforms.uRes.value.set(w, h);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, p: FpvParams, dt: number) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (size.x !== this.rt.width || size.y !== this.rt.height) this.setSize(size.x, size.y);
    // digital links freeze the last frame when the signal drops out
    if (!p.analog && p.lq < 0.08) this.frozenFor += dt; else this.frozenFor = 0;
    const freeze = !p.analog && this.frozenFor > 0 && this.frozenFor < 4 && Math.random() > 0.1;
    if (!freeze) {
      renderer.setRenderTarget(this.rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
    }
    const u = this.mat.uniforms;
    u.uTime.value = p.time;
    u.uAnalog.value = p.analog ? 1 : 0;
    u.uLQ.value = p.lq;
    u.uK.value = p.distortion;
    u.uLens.value = p.lens ? 1 : 0;
    renderer.render(this.scene, this.cam);
  }

  get frozen() { return this.frozenFor > 0; }
}
