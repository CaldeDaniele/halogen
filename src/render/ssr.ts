import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { LightManager } from './lights';

/**
 * Screen-space reflections restricted to upward-facing surfaces (floors), with a
 * world-space puddle mask. No G-buffer: normals are reconstructed from depth.
 * Neon tubes + muzzle flashes streak across the wet concrete — cheap and very on-style.
 */
const FRAG = /* glsl */`
#include <common>
#include <packing>
uniform sampler2D inputBuffer;
uniform sampler2D depthBuffer;
uniform mat4 proj;
uniform mat4 projInv;
uniform mat4 viewInv;
uniform float cameraNear;
uniform float cameraFar;
uniform vec2 texel;
uniform float wetness;
uniform float time;
in vec2 vUv;
out vec4 fragColor;

vec3 viewPosAt(vec2 uv) {
  float d = texture(depthBuffer, uv).r;
  vec4 p = projInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h2(i), h2(i+vec2(1,0)), f.x), mix(h2(i+vec2(0,1)), h2(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * n2(p); p *= 2.03; a *= 0.5; } return s; }

void main() {
  vec4 base = texture(inputBuffer, vUv);
  float d0 = texture(depthBuffer, vUv).r;
  if (d0 >= 0.9999) { fragColor = base; return; }
  vec3 P = viewPosAt(vUv);
  if (-P.z < 0.8) { fragColor = base; return; } // viewmodel / very near
  vec3 px = viewPosAt(vUv + vec2(texel.x, 0.0)) - P;
  vec3 nx = P - viewPosAt(vUv - vec2(texel.x, 0.0));
  vec3 py = viewPosAt(vUv + vec2(0.0, texel.y)) - P;
  vec3 ny = P - viewPosAt(vUv - vec2(0.0, texel.y));
  vec3 dx = abs(px.z) < abs(nx.z) ? px : nx;
  vec3 dy = abs(py.z) < abs(ny.z) ? py : ny;
  vec3 N = normalize(cross(dx, dy));
  vec3 Nw = normalize((viewInv * vec4(N, 0.0)).xyz);
  if (Nw.y < 0.92) { fragColor = base; return; }
  vec3 W = (viewInv * vec4(P, 1.0)).xyz;
  float puddle = smoothstep(0.52, 0.62, fbm(W.xz * 0.28 + 3.1));
  float wet = mix(0.22, 1.0, puddle) * wetness;
  // ripple the puddles slightly
  vec2 rip = vec2(n2(W.xz * 6.0 + time * 1.3), n2(W.xz * 6.0 - time * 1.1)) - 0.5;
  vec3 Nr = normalize(N + (viewInv[0].xyz * 0.0) + vec3(rip.x, 0.0, rip.y) * 0.04 * puddle);
  vec3 V = normalize(P);
  vec3 R = normalize(reflect(V, Nr));
  vec3 refl = vec3(0.0);
  float hitMask = 0.0;
  float t = 0.12;
  vec3 prev = P;
  for (int i = 0; i < 40; i++) {
    vec3 q = P + R * t;
    vec4 c = proj * vec4(q, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || q.z > -cameraNear) break;
    float sz = -perspectiveDepthToViewZ(texture(depthBuffer, uv).r, cameraNear, cameraFar);
    float qz = -q.z;
    if (qz > sz && qz - sz < 0.5 + t * 0.08) {
      // refine
      vec3 a = prev, b = q;
      for (int k = 0; k < 5; k++) {
        vec3 m = (a + b) * 0.5;
        vec4 mc = proj * vec4(m, 1.0);
        vec2 muv = mc.xy / mc.w * 0.5 + 0.5;
        float msz = -perspectiveDepthToViewZ(texture(depthBuffer, muv).r, cameraNear, cameraFar);
        if (-m.z > msz) b = m; else a = m;
        uv = muv;
      }
      vec2 e = smoothstep(vec2(0.0), vec2(0.08), uv) * (1.0 - smoothstep(vec2(0.92), vec2(1.0), uv));
      hitMask = e.x * e.y * (1.0 - smoothstep(10.0, 28.0, t));
      refl = texture(inputBuffer, uv).rgb;
      break;
    }
    prev = q;
    t *= 1.16;
  }
  float fres = 0.12 + 0.88 * pow(1.0 - clamp(dot(-V, N), 0.0, 1.0), 4.0);
  vec3 col = base.rgb * mix(1.0, 0.72, puddle * wetness) + refl * hitMask * fres * wet * 1.25;
  fragColor = vec4(col, base.a);
}
`;
const VERT = /* glsl */`
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;

export class WetFloorPass extends Pass {
  private mat: THREE.ShaderMaterial;
  time = 0;
  constructor(private cam: THREE.PerspectiveCamera, _lights: LightManager) {
    super('WetFloorPass');
    this.needsDepthTexture = true;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        inputBuffer: { value: null }, depthBuffer: { value: null },
        proj: { value: new THREE.Matrix4() }, projInv: { value: new THREE.Matrix4() }, viewInv: { value: new THREE.Matrix4() },
        cameraNear: { value: 0.1 }, cameraFar: { value: 200 }, texel: { value: new THREE.Vector2() },
        wetness: { value: 1 }, time: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
    });
    this.fullscreenMaterial = this.mat;
  }
  set wetness(v: number) { this.mat.uniforms.wetness.value = v; }
  override setDepthTexture(tex: THREE.Texture) { this.mat.uniforms.depthBuffer.value = tex; }
  override setSize(w: number, h: number) { (this.mat.uniforms.texel.value as THREE.Vector2).set(1 / w, 1 / h); }
  override render(renderer: THREE.WebGLRenderer, input: THREE.WebGLRenderTarget, output: THREE.WebGLRenderTarget, dt?: number) {
    const u = this.mat.uniforms;
    u.inputBuffer.value = input.texture;
    (u.proj.value as THREE.Matrix4).copy(this.cam.projectionMatrix);
    (u.projInv.value as THREE.Matrix4).copy(this.cam.projectionMatrixInverse);
    (u.viewInv.value as THREE.Matrix4).copy(this.cam.matrixWorld);
    u.cameraNear.value = this.cam.near; u.cameraFar.value = this.cam.far;
    this.time += dt ?? 0.016; u.time.value = this.time;
    renderer.setRenderTarget(this.renderToScreen ? null : output);
    renderer.render(this.scene, this.camera);
  }
}
