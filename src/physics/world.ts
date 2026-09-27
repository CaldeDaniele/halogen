import RAPIER from '@dimforge/rapier3d-compat';

export type R = typeof RAPIER;
export { RAPIER };

/** Collision membership bits. */
export const G = {
  STATIC: 1 << 0,
  PLAYER: 1 << 1,
  ENEMY: 1 << 2,     // live android segments (kinematic)
  RAGDOLL: 1 << 3,
  DEBRIS: 1 << 4,
  PROP: 1 << 5,
  TRIGGER: 1 << 6,
  HELD: 1 << 7,      // object currently held by kinetic hand
  FIXTURE: 1 << 8,
} as const;
export const ALL = 0xffff;

export function groups(member: number, filter: number) {
  return ((member & 0xffff) << 16) | (filter & 0xffff);
}

export interface ContactForce {
  h1: number; h2: number; magnitude: number;
  dirX: number; dirY: number; dirZ: number;
}

/** Thin wrapper over the Rapier world: init, stepping, event draining, handle → user-data lookup. */
export class PhysicsWorld {
  world!: RAPIER.World;
  events!: RAPIER.EventQueue;
  readonly userData = new Map<number, any>(); // collider handle -> owner
  private forceListeners: ((c: ContactForce) => void)[] = [];
  private collisionListeners: ((h1: number, h2: number, started: boolean) => void)[] = [];

  static async create() {
    await RAPIER.init();
    const p = new PhysicsWorld();
    p.world = new RAPIER.World({ x: 0, y: -18, z: 0 });
    p.world.integrationParameters.numSolverIterations = 6;
    p.events = new RAPIER.EventQueue(true);
    return p;
  }

  step(dt: number) {
    if (dt <= 1e-6) return;
    this.world.timestep = dt;
    this.world.step(this.events);
    this.events.drainContactForceEvents(e => {
      const d = e.maxForceDirection();
      const c: ContactForce = { h1: e.collider1(), h2: e.collider2(), magnitude: e.maxForceMagnitude(), dirX: d.x, dirY: d.y, dirZ: d.z };
      for (const f of this.forceListeners) f(c);
    });
    this.events.drainCollisionEvents((h1, h2, started) => {
      for (const f of this.collisionListeners) f(h1, h2, started);
    });
  }

  onContactForce(fn: (c: ContactForce) => void) { this.forceListeners.push(fn); }
  onCollision(fn: (h1: number, h2: number, started: boolean) => void) { this.collisionListeners.push(fn); }

  tag(collider: RAPIER.Collider, owner: any) { this.userData.set(collider.handle, owner); }
  ownerOf(handle: number) { return this.userData.get(handle); }

  removeBody(body: RAPIER.RigidBody) {
    for (let i = 0; i < body.numColliders(); i++) this.userData.delete(body.collider(i).handle);
    this.world.removeRigidBody(body);
  }

  fixedBox(x: number, y: number, z: number, hx: number, hy: number, hz: number, owner?: any, rotY = 0) {
    const bd = RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
    if (rotY) bd.setRotation({ x: 0, y: Math.sin(rotY / 2), z: 0, w: Math.cos(rotY / 2) });
    const body = this.world.createRigidBody(bd);
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setCollisionGroups(groups(G.STATIC, ALL)).setFriction(0.8), body);
    if (owner) this.tag(col, owner);
    return { body, col };
  }

  /**
   * Colliders overlapping a sphere. Collected first on purpose: Rapier forbids mutating bodies
   * inside an intersectionsWithShape callback (the call throws and is silently swallowed).
   */
  overlapBall(pos: { x: number; y: number; z: number }, radius: number, filter?: number): RAPIER.Collider[] {
    const out: RAPIER.Collider[] = [];
    this.world.intersectionsWithShape(pos, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Ball(radius), c => { out.push(c); return true; }, undefined, filter);
    return out;
  }

  /** False once a body has been removed; touching a removed body traps the wasm and wedges the world. */
  bodyAlive(b: RAPIER.RigidBody | null | undefined) {
    return !!b && this.world.bodies.contains(b.handle) && this.world.getRigidBody(b.handle) === b;
  }

  /** Ray cast returning hit point, normal and collider. */
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxToi: number, filter: number, exclude?: RAPIER.Collider | RAPIER.RigidBody) {
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const isBody = exclude && 'numColliders' in exclude;
    const hit = this.world.castRayAndGetNormal(ray, maxToi, true, undefined, filter,
      isBody ? undefined : (exclude as RAPIER.Collider | undefined), isBody ? (exclude as RAPIER.RigidBody) : undefined);
    if (!hit) return null;
    return {
      toi: hit.timeOfImpact,
      x: ox + dx * hit.timeOfImpact, y: oy + dy * hit.timeOfImpact, z: oz + dz * hit.timeOfImpact,
      nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z,
      collider: hit.collider,
    };
  }
}
