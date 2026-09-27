import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/world';
import type { LightManager } from '../render/lights';
import type { Materials } from '../render/materials';
import type { Particles } from '../render/particles';
import type { Decals } from '../render/decals';
import type { Sfx } from '../audio/synth';
import type { Events } from '../core/events';
import type { Time } from '../core/time';
import type { Renderer } from '../render/renderer';
import type { PlayerController } from './player/controller';
import type { CameraRig } from './player/camera';

export type DamageSource = 'player' | 'enemy' | 'kinetic' | 'explosion' | 'environment';

export interface HitInfo {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  dir: THREE.Vector3;
  damage: number;
  /** impulse magnitude applied along dir at point */
  impulse: number;
  source: DamageSource;
  weapon?: string;
  collider?: RAPIER.Collider;
  /** set by the receiver */
  headshot?: boolean;
  /** damage actually applied after armor/shield/multipliers (set by the receiver) */
  dealt?: number;
  pin?: boolean;
  /** hit came during bullet time */
  bulletTime?: boolean;
  /** extra flags from cards (e.g. chain lightning shouldn't chain again) */
  tags?: Set<string>;
}

/** Anything registered in PhysicsWorld.userData that reacts to hits. */
export interface Owner {
  kind: 'player' | 'android' | 'prop' | 'fixture' | 'static' | 'debris' | 'limb' | 'boss';
  surface?: 'concrete' | 'metal' | 'glass' | 'android';
  hit?(h: HitInfo): void;
  [k: string]: any;
}

export interface GameEvents {
  shot: { weapon: string };
  enemyHit: { hit: HitInfo; enemy: any };
  enemyKilled: { hit: HitInfo; enemy: any; headshot: boolean; kinetic: boolean; bulletTime: boolean; pos: THREE.Vector3 };
  lightBroken: { fixture: any; byPlayer: boolean };
  lightRestored: { fixture: any };
  roomCleared: { room: any };
  roomEntered: { room: any };
  playerDamaged: { amount: number; from?: THREE.Vector3 };
  playerDied: void;
  focusTriggered: void;
  cardPicked: { id: string };
  explosion: { pos: THREE.Vector3; radius: number };
  kineticThrow: { mass: number };
  limbSevered: { pos: THREE.Vector3 };
  bossPhase: { phase: number };
}

export interface Ctx {
  renderer: Renderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  phys: PhysicsWorld;
  lights: LightManager;
  mats: Materials;
  particles: Particles;
  decals: Decals;
  sfx: Sfx;
  events: Events<GameEvents>;
  time: Time;
  player: PlayerController;
  rig: CameraRig;
  /** set by Game each frame */
  hud: { hitmarker(kind: 'hit' | 'kill' | 'head'): void; damage(from?: THREE.Vector3): void; toast(msg: string, color?: string, t?: number): void; feedMsg(text: string, pts: number, color?: string): void };
  run: any;
  game: any;
}
