/**
 * Data-driven android bodies. Positions are in body space with the origin between the feet,
 * +Y up, facing -Z. Every segment becomes one Rapier rigid body; joints become impulse joints.
 */
export type Shape = 'capsule' | 'box' | 'ball';
export interface JointDef { anchor: [number, number, number]; type: 'ball' | 'hinge'; axis?: [number, number, number]; limits?: [number, number] }
export interface SegDef {
  name: string;
  shape: Shape;
  /** capsule: [halfHeight, radius]; box: half extents; ball: [radius] */
  size: number[];
  pos: [number, number, number];
  mass: number;
  parent?: string;
  joint?: JointDef;
  /** visual style: which material + decoration */
  look: 'armor' | 'joint' | 'head' | 'core' | 'visor';
  /** severable when the android dies (or on massive damage) */
  severable?: boolean;
  head?: boolean;
}
export interface BodyDef { id: string; segs: SegDef[]; scale: number }

const L = (x: number) => x; // readability

export const BIPED: SegDef[] = [
  { name: 'pelvis', shape: 'box', size: [0.16, 0.09, 0.11], pos: [0, 0.98, 0], mass: 12, look: 'joint' },
  { name: 'torso', shape: 'box', size: [0.21, 0.2, 0.13], pos: [0, 1.3, 0], mass: 18, parent: 'pelvis', joint: { anchor: [0, 1.08, 0], type: 'hinge', axis: [1, 0, 0], limits: [-0.5, 0.9] }, look: 'core' },
  { name: 'head', shape: 'box', size: [0.11, 0.12, 0.12], pos: [0, 1.7, 0], mass: 5, parent: 'torso', joint: { anchor: [0, 1.55, 0], type: 'hinge', axis: [1, 0, 0], limits: [-0.7, 0.7] }, look: 'head', head: true, severable: true },
  { name: 'uarmL', shape: 'capsule', size: [0.12, 0.055], pos: [-0.29, 1.32, 0], mass: 3, parent: 'torso', joint: { anchor: [-0.27, 1.46, 0], type: 'ball' }, look: 'armor', severable: true },
  { name: 'farmL', shape: 'capsule', size: [0.12, 0.05], pos: [-0.29, 1.0, 0], mass: 2.5, parent: 'uarmL', joint: { anchor: [-0.29, 1.15, 0], type: 'hinge', axis: [1, 0, 0], limits: [0, 2.3] }, look: 'joint' },
  { name: 'uarmR', shape: 'capsule', size: [0.12, 0.055], pos: [0.29, 1.32, 0], mass: 3, parent: 'torso', joint: { anchor: [0.27, 1.46, 0], type: 'ball' }, look: 'armor', severable: true },
  { name: 'farmR', shape: 'capsule', size: [0.12, 0.05], pos: [0.29, 1.0, 0], mass: 2.5, parent: 'uarmR', joint: { anchor: [0.29, 1.15, 0], type: 'hinge', axis: [1, 0, 0], limits: [0, 2.3] }, look: 'joint' },
  { name: 'thighL', shape: 'capsule', size: [0.15, 0.07], pos: [-0.11, 0.72, 0], mass: 7, parent: 'pelvis', joint: { anchor: [-0.11, 0.92, 0], type: 'ball' }, look: 'armor', severable: true },
  { name: 'shinL', shape: 'capsule', size: [0.16, 0.06], pos: [-0.11, 0.29, 0], mass: 5, parent: 'thighL', joint: { anchor: [-0.11, 0.5, 0], type: 'hinge', axis: [1, 0, 0], limits: [-2.4, 0] }, look: 'joint' },
  { name: 'thighR', shape: 'capsule', size: [0.15, 0.07], pos: [0.11, 0.72, 0], mass: 7, parent: 'pelvis', joint: { anchor: [0.11, 0.92, 0], type: 'ball' }, look: 'armor', severable: true },
  { name: 'shinR', shape: 'capsule', size: [0.16, 0.06], pos: [0.11, 0.29, 0], mass: 5, parent: 'thighR', joint: { anchor: [0.11, 0.5, 0], type: 'hinge', axis: [1, 0, 0], limits: [-2.4, 0] }, look: 'joint' },
];

/** Quadruped "Skitter": low body, 4 two-segment legs splayed outward. */
export const QUAD: SegDef[] = [
  { name: 'body', shape: 'box', size: [0.2, 0.09, 0.3], pos: [0, 0.5, 0], mass: 10, look: 'core' },
  { name: 'head', shape: 'box', size: [0.1, 0.07, 0.1], pos: [0, 0.56, -0.38], mass: 2, parent: 'body', joint: { anchor: [0, 0.54, -0.3], type: 'hinge', axis: [1, 0, 0], limits: [-0.6, 0.6] }, look: 'head', head: true, severable: true },
  ...(['FL', 'FR', 'BL', 'BR'] as const).flatMap(k => {
    const sx = k.endsWith('L') ? -1 : 1, sz = k.startsWith('F') ? -1 : 1;
    return [
      { name: 'u' + k, shape: 'capsule', size: [0.1, 0.035], pos: [sx * 0.34, 0.56, sz * 0.22], mass: 1.2, parent: 'body', joint: { anchor: [sx * 0.2, 0.52, sz * 0.22], type: 'ball' }, look: 'armor', severable: true } as SegDef,
      { name: 'l' + k, shape: 'capsule', size: [0.18, 0.03], pos: [sx * 0.46, 0.26, sz * 0.22], mass: 1, parent: 'u' + k, joint: { anchor: [sx * 0.44, 0.5, sz * 0.22], type: 'ball' }, look: 'joint' } as SegDef,
    ];
  }),
];

/** Drone "Lamplighter": core + fins. */
export const DRONE: SegDef[] = [
  { name: 'core', shape: 'ball', size: [0.22], pos: [0, 0, 0], mass: 6, look: 'core' },
  { name: 'eye', shape: 'box', size: [0.08, 0.08, 0.06], pos: [0, 0, -0.24], mass: 1, parent: 'core', joint: { anchor: [0, 0, -0.2], type: 'hinge', axis: [1, 0, 0], limits: [-0.1, 0.1] }, look: 'visor', head: true },
  { name: 'finL', shape: 'box', size: [0.2, 0.02, 0.12], pos: [-0.38, 0, 0], mass: 1, parent: 'core', joint: { anchor: [-0.2, 0, 0], type: 'hinge', axis: [0, 0, 1], limits: [-0.8, 0.8] }, look: 'armor', severable: true },
  { name: 'finR', shape: 'box', size: [0.2, 0.02, 0.12], pos: [0.38, 0, 0], mass: 1, parent: 'core', joint: { anchor: [0.2, 0, 0], type: 'hinge', axis: [0, 0, 1], limits: [-0.8, 0.8] }, look: 'armor', severable: true },
];

export type EnemyType = 'grunt' | 'charger' | 'skitter' | 'shade' | 'lamplighter' | 'foreman';

export interface EnemyStats {
  type: EnemyType; body: SegDef[]; scale: number; hp: number; speed: number; color: number; attackColor: number;
  /** damage per shot / melee */
  dmg: number; range: number; fireRate: number; stagger: number; score: number; flying?: boolean; quad?: boolean;
  /** radius (body units) of a forgiving sensor hurtbox on the root, for small fast bodies */
  hurtbox?: number;
}

export const ENEMIES: Record<EnemyType, EnemyStats> = {
  grunt: { type: 'grunt', body: BIPED, scale: 1, hp: 70, speed: 4.2, color: 0x19f0ff, attackColor: 0xff3b3b, dmg: 5, range: 30, fireRate: 1.5, stagger: 60, score: 100 },
  charger: { type: 'charger', body: BIPED, scale: 1.32, hp: 240, speed: 3.3, color: 0xffb02e, attackColor: 0xff5a1a, dmg: 20, range: 3, fireRate: 2.5, stagger: 160, score: 300 },
  skitter: { type: 'skitter', body: QUAD, scale: 0.9, hp: 28, speed: 7.2, color: 0xff2bd6, attackColor: 0xff2bd6, dmg: 7, range: 2.2, fireRate: 1.1, stagger: 10, score: 60, quad: true, hurtbox: 0.55 },
  shade: { type: 'shade', body: BIPED, scale: 1.05, hp: 55, speed: 6.5, color: 0x8a5cff, attackColor: 0xb46bff, dmg: 12, range: 2.4, fireRate: 1.3, stagger: 50, score: 180 },
  lamplighter: { type: 'lamplighter', body: DRONE, scale: 1, hp: 45, speed: 5, color: 0xfff1b0, attackColor: 0xfff1b0, dmg: 0, range: 14, fireRate: 3, stagger: 20, score: 150, flying: true },
  foreman: { type: 'foreman', body: BIPED, scale: 2.6, hp: 2600, speed: 3.2, color: 0x19f0ff, attackColor: 0xff3b3b, dmg: 22, range: 40, fireRate: 1.2, stagger: 99999, score: 3000 },
};

void L;
