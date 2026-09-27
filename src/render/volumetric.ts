import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { CLUSTER_PARS, LightManager } from './lights';

/**
 * Raymarched volumetric in-scattering that reuses the clustered light lists:
 * each march sample looks up the cluster for (pixel tile, sample depth) and only
 * integrates lights binned there. Rendered at half res, then composited with a
 * depth-based extinction for the brutalist haze.
 */
const MARCH_FRAG = /* glsl */`
#include <common>
#include <packing>
${CLUSTER_PARS}
uniform sampler2D depthBuffer;
uniform mat4 projInv;
uniform float cameraNear;
uniform float cameraFar;
uniform float time;
uniform float density;
uniform float maxDist;
uniform vec2 fullRes;
uniform int steps;
in vec2 vUv;
out vec4 fragColor;

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}

void main() {
  float d = texture(depthBuffer, vUv).r;
  vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 vp = projInv * clip; vp /= vp.w;
  float dist = min(length(vp.xyz), maxDist);
  vec3 dir = normalize(vp.xyz);
  float stepLen = dist / float(steps);
  float jitter = ign(gl_FragCoord.xy + fract(time * 7.13) * 91.0);
  vec2 fragXY = vUv * fullRes;
  vec3 acc = vec3(0.0);
  for (int s = 0; s < 64; s++) {
    if (s >= steps) break;
    float t = (float(s) + jitter) * stepLen;
    vec3 p = dir * t;
    int crow = clusterRow(fragXY, -p.z);
    int ccount = int(texelFetch(uClusterTex, ivec2(0, crow), 0).r);
    // drifting dust density
    float n = vnoise(p * 0.6 + vec3(0.0, time * 0.15, time * 0.07));
    float dens = density * (0.8 + 0.4 * n);
    vec3 scat = vec3(0.0);
    for (int ci = 0; ci < 32; ci++) {
      if (ci >= ccount) break;
      int li = int(texelFetch(uClusterTex, ivec2(ci + 1, crow), 0).r);
      vec4 la = texelFetch(uLightTex, ivec2(li, 0), 0);
      vec4 lb = texelFetch(uLightTex, ivec2(li, 1), 0);
      vec4 lc = texelFetch(uLightTex, ivec2(li, 2), 0);
      vec3 lp = la.xyz;
      if (lb.w > 0.5 && lb.w < 1.5) {
        vec3 Ld = lc.xyz - la.xyz;
        lp = la.xyz + Ld * clamp(dot(p - la.xyz, Ld) / max(dot(Ld, Ld), 1e-4), 0.0, 1.0);
      }
      vec3 lv = lp - p;
      float ld = length(lv);
      if (ld < la.w) {
        vec3 c = lb.rgb * clusterAtten(ld, la.w);
        if (lb.w > 1.5) c *= smoothstep(lc.w, mix(lc.w, 1.0, 0.25), dot(-lv / ld, lc.xyz)) * 2.5;
        // Henyey-Greenstein, g = 0.35 (forward scattering)
        float cosT = dot(dir, -lv / max(ld, 1e-4));
        float g = 0.35;
        float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5);
        scat += c * hg;
      }
    }
    acc += scat * dens * stepLen;
  }
  // soft-clip so a point-blank explosion can't white out the whole haze
  vec3 v = acc * 0.08;
  fragColor = vec4(v / (1.0 + max(max(v.r, v.g), v.b) * 0.6), 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */`
#include <common>
#include <packing>
uniform sampler2D inputBuffer;
uniform sampler2D volBuffer;
uniform sampler2D depthBuffer;
uniform float cameraNear;
uniform float cameraFar;
uniform float extinction;
uniform vec3 fogColor;
uniform vec2 volTexel;
uniform float strength;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 c = texture(inputBuffer, vUv);
  // 5-tap blur to hide the half-res + jitter
  vec3 v = texture(volBuffer, vUv).rgb * 0.4;
  v += texture(volBuffer, vUv + vec2(volTexel.x, 0.0) * 1.5).rgb * 0.15;
  v += texture(volBuffer, vUv - vec2(volTexel.x, 0.0) * 1.5).rgb * 0.15;
  v += texture(volBuffer, vUv + vec2(0.0, volTexel.y) * 1.5).rgb * 0.15;
  v += texture(volBuffer, vUv - vec2(0.0, volTexel.y) * 1.5).rgb * 0.15;
  float d = texture(depthBuffer, vUv).r;
  float vz = -perspectiveDepthToViewZ(d, cameraNear, cameraFar);
  float T = exp(-extinction * vz);
  fragColor = vec4(c.rgb * T + fogColor * (1.0 - T) + v * strength, c.a);
}
`;

const VERT = /* glsl */`
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;

export class VolumetricPass extends Pass {
  time = 0;
  private rt: THREE.WebGLRenderTarget;
  private march: THREE.ShaderMaterial;
  private comp: THREE.ShaderMaterial;
  strength = 0.16;

  constructor(private cam: THREE.PerspectiveCamera, lights: LightManager, steps: number, private half: boolean) {
    super('VolumetricPass');
    this.needsDepthTexture = true;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.march = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...lights.uniforms,
        depthBuffer: { value: null }, projInv: { value: new THREE.Matrix4() },
        cameraNear: { value: 0.1 }, cameraFar: { value: 200 }, time: { value: 0 }, density: { value: 0.9 },
        maxDist: { value: 45 }, fullRes: { value: new THREE.Vector2(1, 1) }, steps: { value: Math.max(1, steps) },
      },
      vertexShader: VERT, fragmentShader: MARCH_FRAG, depthWrite: false, depthTest: false,
    });
    this.comp = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        inputBuffer: { value: null }, volBuffer: { value: this.rt.texture }, depthBuffer: { value: null },
        cameraNear: { value: 0.1 }, cameraFar: { value: 200 }, extinction: { value: 0.018 },
        fogColor: { value: new THREE.Color(0.004, 0.006, 0.01) }, volTexel: { value: new THREE.Vector2() }, strength: { value: 1 },
      },
      vertexShader: VERT, fragmentShader: COMPOSITE_FRAG, depthWrite: false, depthTest: false,
    });
    this.fullscreenMaterial = this.march;
  }

  setFog(color: THREE.Color, extinction: number, density: number) {
    (this.comp.uniforms.fogColor.value as THREE.Color).copy(color);
    this.comp.uniforms.extinction.value = extinction;
    this.march.uniforms.density.value = density;
  }

  override setDepthTexture(tex: THREE.Texture) {
    this.march.uniforms.depthBuffer.value = tex;
    this.comp.uniforms.depthBuffer.value = tex;
  }

  override setSize(w: number, h: number) {
    const s = this.half ? 0.5 : 1;
    this.rt.setSize(Math.max(1, Math.floor(w * s)), Math.max(1, Math.floor(h * s)));
    (this.march.uniforms.fullRes.value as THREE.Vector2).set(w, h);
    (this.comp.uniforms.volTexel.value as THREE.Vector2).set(1 / (w * s), 1 / (h * s));
  }

  override render(renderer: THREE.WebGLRenderer, input: THREE.WebGLRenderTarget, output: THREE.WebGLRenderTarget) {
    const m = this.march.uniforms, c = this.comp.uniforms;
    (m.projInv.value as THREE.Matrix4).copy(this.cam.projectionMatrixInverse);
    m.cameraNear.value = c.cameraNear.value = this.cam.near;
    m.cameraFar.value = c.cameraFar.value = this.cam.far;
    m.time.value = this.time;
    c.strength.value = this.strength;
    this.fullscreenMaterial = this.march;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.camera);
    c.inputBuffer.value = input.texture;
    this.fullscreenMaterial = this.comp;
    renderer.setRenderTarget(this.renderToScreen ? null : output);
    renderer.render(this.scene, this.camera);
  }
}
