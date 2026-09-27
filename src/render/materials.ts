import * as THREE from 'three';
import { LightManager } from './lights';

const loader = new THREE.TextureLoader();
const cache = new Map<string, THREE.Texture>();
let maxAniso = 8;

/** Procedural stand-in so a missing/failed asset never breaks the look. */
function fallbackTexture(kind: 'albedo' | 'normal' | 'rough', seed: number) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const img = g.createImageData(128, 128);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 128 * 128; i++) {
    const v = kind === 'normal' ? 0 : 90 + rnd() * 40;
    img.data[i * 4] = kind === 'normal' ? 128 : v; img.data[i * 4 + 1] = kind === 'normal' ? 128 : v;
    img.data[i * 4 + 2] = kind === 'normal' ? 255 : v; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

export function tex(path: string, kind: 'albedo' | 'normal' | 'rough' = 'albedo') {
  const key = path + kind;
  const hit = cache.get(key); if (hit) return hit;
  const t = loader.load(path, undefined, undefined, () => {
    const f = fallbackTexture(kind, path.length);
    (t as any).image = f.image; t.needsUpdate = true;
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  t.colorSpace = kind === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  cache.set(key, t);
  return t;
}

export interface SurfaceOpts { tint?: THREE.ColorRepresentation; roughness?: number; metalness?: number; normalScale?: number; envInt?: number; dark?: number }

export class Materials {
  readonly surfaces = new Map<string, THREE.MeshStandardMaterial>();
  private neonCache = new Map<string, THREE.MeshBasicMaterial>();

  constructor(private lights: LightManager, renderer: THREE.WebGLRenderer) {
    maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const S = (name: string, file: string, o: SurfaceOpts = {}) => this.surface(name, file, o);
    S('wall', 'concrete_formwork', { roughness: 0.95 });
    S('floor', 'concrete_smooth', { roughness: 0.75 });
    S('stained', 'concrete_stained', { roughness: 0.8, tint: 0xbfc4c8 });
    S('metal', 'metal_brushed', { roughness: 0.55, metalness: 0.85, dark: 1 });
    S('diamond', 'metal_diamond', { roughness: 0.5, metalness: 0.8, dark: 0.8 });
    S('panel', 'metal_rusted', { roughness: 0.7, metalness: 0.5 });
    S('hazard', 'hazard', { roughness: 0.8 });
    S('tiles', 'floor_tiles', { roughness: 0.6 });
    S('ceiling', 'ceiling_panels', { roughness: 0.8, metalness: 0.3 });
    S('pipes', 'pipes_wall', { roughness: 0.6, metalness: 0.7 });
    S('armor', 'armor_ceramic', { roughness: 0.42, metalness: 0.05, normalScale: 0.6, dark: 1 });
    const joint = lights.patch(new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.35, metalness: 0.9 }));
    this.surfaces.set('joint', joint);
    const chunk = lights.patch(new THREE.MeshStandardMaterial({ color: 0x77797c, roughness: 0.95, map: tex('assets/tex/concrete_formwork.webp') }));
    this.surfaces.set('chunk', chunk);
  }

  surface(name: string, file: string, o: SurfaceOpts) {
    const m = new THREE.MeshStandardMaterial({
      map: tex(`assets/tex/${file}.webp`),
      normalMap: tex(`assets/tex/${file}_n.webp`, 'normal'),
      roughnessMap: tex(`assets/tex/${file}_r.webp`, 'rough'),
      roughness: o.roughness ?? 0.8,
      metalness: o.metalness ?? 0,
      color: new THREE.Color(o.tint ?? 0xffffff).multiplyScalar(o.dark ?? 0.45),
    });
    m.normalScale.setScalar(o.normalScale ?? 1);
    this.lights.patch(m);
    this.surfaces.set(name, m);
    return m;
  }

  get(name: string) { return this.surfaces.get(name)!; }

  /** Unlit HDR emissive (bloom picks it up). */
  neon(color: THREE.ColorRepresentation, intensity = 6) {
    const key = new THREE.Color(color).getHexString() + intensity;
    let m = this.neonCache.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) });
      this.neonCache.set(key, m);
    }
    return m;
  }
}

/** Box geometry with UVs in world units (tileSize meters per texture repeat) so textures never stretch. */
export function worldBox(w: number, h: number, d: number, tile = 2.5) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i));
    let su: number, sv: number;
    if (nx > 0.5) { su = d; sv = h; } else if (ny > 0.5) { su = w; sv = d; } else { su = w; sv = h; }
    uv.setXY(i, uv.getX(i) * su / tile, uv.getY(i) * sv / tile);
  }
  return g;
}
