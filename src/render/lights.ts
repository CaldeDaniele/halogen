import * as THREE from 'three';
import { binLights, ClusterGrid, DEFAULT_GRID, LightSphere } from './clustered';

export const enum LightType { Point = 0, Tube = 1, Spot = 2 }

export interface DynLight {
  type: LightType;
  /** world position (tube: start) */
  pos: THREE.Vector3;
  /** tube: end point (world). spot: direction (world, normalized) */
  pos2: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  radius: number;
  /** spot: cos of outer cone angle */
  spotCos: number;
  enabled: boolean;
  /** seconds to live; <0 = permanent. Intensity fades with remaining life when fade=true */
  ttl: number;
  life0: number;
  fade: boolean;
  /** 0..1 flicker amount */
  flicker: number;
  /** runtime multiplier (flicker, breaking animations etc.) */
  mul: number;
  seed: number;
}

const MAX_LIGHTS = 128;

/**
 * Clustered forward light manager. Owns the light list, bins it per frame and uploads
 * two float textures consumed by every patched MeshStandardMaterial.
 */
export class LightManager {
  readonly lights: DynLight[] = [];
  readonly grid: ClusterGrid = DEFAULT_GRID;
  readonly lightTex: THREE.DataTexture;
  readonly clusterTex: THREE.DataTexture;
  private lightData: Float32Array;
  private spheres: LightSphere[] = [];
  private active: DynLight[] = [];
  readonly uniforms: Record<string, THREE.IUniform>;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private t = 0;
  /** exposed for dev overlay */
  stats = { active: 0, maxCluster: 0 };

  constructor() {
    const g = this.grid;
    this.lightData = new Float32Array(MAX_LIGHTS * 3 * 4);
    this.lightTex = new THREE.DataTexture(this.lightData, MAX_LIGHTS, 3, THREE.RGBAFormat, THREE.FloatType);
    this.lightTex.needsUpdate = true;
    const rows = g.nx * g.ny * g.nz;
    const cdata = new Float32Array(rows * (g.maxPerCluster + 1));
    this.clusterTex = new THREE.DataTexture(cdata, g.maxPerCluster + 1, rows, THREE.RedFormat, THREE.FloatType);
    this.clusterTex.needsUpdate = true;
    this.uniforms = {
      uClusterTex: { value: this.clusterTex },
      uLightTex: { value: this.lightTex },
      uClusterDims: { value: new THREE.Vector3(g.nx, g.ny, g.nz) },
      uClusterCam: { value: new THREE.Vector4(0.1, 200, Math.log(2000), 0) },
      uResolution: { value: new THREE.Vector2(1, 1) },
    };
  }

  add(opts: Partial<DynLight> & { pos: THREE.Vector3 }): DynLight {
    const l: DynLight = {
      type: LightType.Point, pos2: new THREE.Vector3(), color: new THREE.Color(1, 1, 1), intensity: 5, radius: 8,
      spotCos: 0.8, enabled: true, ttl: -1, life0: 1, fade: true, flicker: 0, mul: 1, seed: Math.random() * 100,
      ...opts,
    } as DynLight;
    l.pos = opts.pos.clone();
    if (opts.pos2) l.pos2 = opts.pos2.clone();
    if (opts.color) l.color = opts.color.clone();
    if (l.ttl > 0) l.life0 = l.ttl;
    this.lights.push(l);
    return l;
  }

  /** Short-lived light (muzzle flash, explosion, spark burst). */
  flash(pos: THREE.Vector3, color: THREE.ColorRepresentation, intensity: number, radius: number, ttl: number) {
    return this.add({ pos, color: new THREE.Color(color), intensity, radius, ttl });
  }

  remove(l: DynLight) {
    const i = this.lights.indexOf(l);
    if (i >= 0) this.lights.splice(i, 1);
  }
  clear() { this.lights.length = 0; }

  update(dt: number, camera: THREE.PerspectiveCamera, width: number, height: number) {
    this.t += dt;
    // expire
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const l = this.lights[i];
      if (l.ttl >= 0) { l.ttl -= dt; if (l.ttl <= 0) this.lights.splice(i, 1); }
    }
    const view = camera.matrixWorldInverse;
    const active = this.active; active.length = 0;
    const spheres = this.spheres; spheres.length = 0;
    const camPos = camera.position;
    // prioritize nearest lights if over budget
    let list = this.lights.filter(l => l.enabled && l.intensity * l.mul > 0.001);
    if (list.length > MAX_LIGHTS) {
      list = list.sort((a, b) => a.pos.distanceToSquared(camPos) - b.pos.distanceToSquared(camPos)).slice(0, MAX_LIGHTS);
    }
    const d = this.lightData;
    for (const l of list) {
      const i = active.length;
      let k = 1;
      if (l.ttl >= 0 && l.fade) { const f = Math.max(0, l.ttl / l.life0); k *= f * f; }
      if (l.flicker > 0) {
        const n = Math.sin(this.t * 23 + l.seed) * Math.sin(this.t * 7.3 + l.seed * 3) * Math.sin(this.t * 51 + l.seed);
        k *= 1 - l.flicker * (n > 0.2 ? 1 : 0.15 * Math.abs(n));
      }
      k *= l.mul;
      const p = this.tmp.copy(l.pos).applyMatrix4(view);
      let cx = p.x, cy = p.y, cz = p.z, r = l.radius;
      d[i * 4 + 0] = p.x; d[i * 4 + 1] = p.y; d[i * 4 + 2] = p.z; d[i * 4 + 3] = l.radius;
      const row1 = (MAX_LIGHTS + i) * 4;
      d[row1 + 0] = l.color.r * l.intensity * k; d[row1 + 1] = l.color.g * l.intensity * k; d[row1 + 2] = l.color.b * l.intensity * k;
      d[row1 + 3] = l.type;
      const row2 = (MAX_LIGHTS * 2 + i) * 4;
      if (l.type === LightType.Tube) {
        const p2 = this.tmp2.copy(l.pos2).applyMatrix4(view);
        d[row2] = p2.x; d[row2 + 1] = p2.y; d[row2 + 2] = p2.z; d[row2 + 3] = 0;
        cx = (p.x + p2.x) / 2; cy = (p.y + p2.y) / 2; cz = (p.z + p2.z) / 2;
        r += 0.5 * Math.hypot(p2.x - p.x, p2.y - p.y, p2.z - p.z);
      } else if (l.type === LightType.Spot) {
        const dir = this.tmp2.copy(l.pos2).transformDirection(view);
        d[row2] = dir.x; d[row2 + 1] = dir.y; d[row2 + 2] = dir.z; d[row2 + 3] = l.spotCos;
      }
      spheres.push({ x: cx, y: cy, z: cz, r });
      active.push(l);
    }
    this.lightTex.needsUpdate = true;
    const u = this.uniforms;
    (u.uClusterCam.value as THREE.Vector4).set(camera.near, camera.far, Math.log(camera.far / camera.near), 0);
    (u.uResolution.value as THREE.Vector2).set(width, height);
    const buf = this.clusterTex.image.data as Float32Array;
    binLights(spheres, { fovY: THREE.MathUtils.degToRad(camera.fov), aspect: camera.aspect, near: camera.near, far: camera.far }, this.grid, buf);
    this.clusterTex.needsUpdate = true;
    this.stats.active = active.length;
  }

  /** Inject clustered lighting into a standard/physical material. */
  patch<M extends THREE.MeshStandardMaterial>(mat: M): M {
    const uniforms = this.uniforms;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      prev?.call(mat, shader, r);
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = CLUSTER_PARS + shader.fragmentShader.replace(
        '#include <lights_fragment_begin>', '#include <lights_fragment_begin>\n' + CLUSTER_LOOP);
    };
    const prevKey = mat.customProgramCacheKey?.bind(mat);
    mat.customProgramCacheKey = () => 'clustered|' + (prevKey ? prevKey() : '');
    mat.needsUpdate = true;
    return mat;
  }
}

export const CLUSTER_PARS = /* glsl */`
uniform highp sampler2D uClusterTex;
uniform highp sampler2D uLightTex;
uniform vec3 uClusterDims;
uniform vec4 uClusterCam;
uniform vec2 uResolution;
float clusterAtten(float d, float r) {
  float x = d / r; x = x * x; x = clamp(1.0 - x * x, 0.0, 1.0);
  return x * x / (d * d + 1.0);
}
int clusterRow(vec2 fragXY, float depth) {
  int cx = int(clamp(fragXY.x / uResolution.x * uClusterDims.x, 0.0, uClusterDims.x - 1.0));
  int cy = int(clamp(fragXY.y / uResolution.y * uClusterDims.y, 0.0, uClusterDims.y - 1.0));
  int cz = int(clamp(floor(log(max(depth, uClusterCam.x) / uClusterCam.x) / uClusterCam.z * uClusterDims.z), 0.0, uClusterDims.z - 1.0));
  return (cz * int(uClusterDims.y) + cy) * int(uClusterDims.x) + cx;
}
`;

const CLUSTER_LOOP = /* glsl */`
{
  int crow = clusterRow(gl_FragCoord.xy, vViewPosition.z);
  int ccount = int(texelFetch(uClusterTex, ivec2(0, crow), 0).r);
  vec3 rdir = reflect(-geometryViewDir, geometryNormal);
  for (int ci = 0; ci < 32; ci++) {
    if (ci >= ccount) break;
    int li = int(texelFetch(uClusterTex, ivec2(ci + 1, crow), 0).r);
    vec4 la = texelFetch(uLightTex, ivec2(li, 0), 0);
    vec4 lb = texelFetch(uLightTex, ivec2(li, 1), 0);
    vec4 lc = texelFetch(uLightTex, ivec2(li, 2), 0);
    vec3 lp = la.xyz;
    if (lb.w > 0.5 && lb.w < 1.5) {
      // tube light: representative point. Smooth surfaces use the point closest to the
      // reflection ray (elongated highlight), rough ones the point closest to the surface.
      vec3 L0 = la.xyz - geometryPosition;
      vec3 Ld = lc.xyz - la.xyz;
      float tClose = clamp(-dot(L0, Ld) / max(dot(Ld, Ld), 1e-4), 0.0, 1.0);
      float rl = dot(rdir, Ld);
      float tRefl = clamp((dot(rdir, L0) * rl - dot(L0, Ld)) / max(dot(Ld, Ld) - rl * rl, 1e-4), 0.0, 1.0);
      lp = la.xyz + Ld * mix(tRefl, tClose, clamp(material.roughness * 1.4, 0.0, 1.0));
    }
    vec3 lv = lp - geometryPosition;
    float ld = length(lv);
    if (ld < la.w) {
      IncidentLight cl;
      cl.direction = lv / max(ld, 1e-4);
      cl.color = lb.rgb * clusterAtten(ld, la.w);
      cl.visible = true;
      if (lb.w > 1.5) cl.color *= smoothstep(lc.w, mix(lc.w, 1.0, 0.25), dot(-cl.direction, lc.xyz));
      RE_Direct(cl, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
    }
  }
}
`;
