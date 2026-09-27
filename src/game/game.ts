import * as THREE from 'three';
import { Renderer } from '../render/renderer';
import { PhysicsWorld, RAPIER, G, groups, ALL } from '../physics/world';
import { Materials, worldBox } from '../render/materials';
import { Input } from '../core/input';
import { Time } from '../core/time';
import { createLoop } from '../core/loop';
import { PlayerController } from './player/controller';
import { CameraRig } from './player/camera';
import { LightType } from '../render/lights';
import { buildNeonEnvironment } from '../render/envmap';

const STEP = 1 / 120;

export class Game {
  renderer!: Renderer;
  phys!: PhysicsWorld;
  mats!: Materials;
  input!: Input;
  time = new Time();
  player!: PlayerController;
  rig = new CameraRig();
  private props: { mesh: THREE.Mesh; body: RAPIER.RigidBody }[] = [];

  static async create(canvas: HTMLCanvasElement, ui: HTMLElement, progress: (p: number, m: string) => void) {
    const g = new Game();
    progress(0.1, 'renderer');
    g.renderer = new Renderer(canvas);
    progress(0.3, 'physics');
    g.phys = await PhysicsWorld.create();
    progress(0.5, 'materials');
    g.mats = new Materials(g.renderer.lights, g.renderer.renderer);
    g.input = new Input(canvas);
    canvas.addEventListener('click', () => { if (!g.input.locked) g.input.requestLock(); });
    progress(0.7, 'level');
    g.buildTestRoom();
    g.player = new PlayerController(g.phys, new THREE.Vector3(0, 0, 8));
    progress(1, 'ready');
    g.start();
    return g;
  }

  private buildTestRoom() {
    const scene = this.renderer.scene;
    const m = this.mats;
    const add = (w: number, h: number, d: number, x: number, y: number, z: number, mat: string, tile = 3) => {
      const mesh = new THREE.Mesh(worldBox(w, h, d, tile), m.get(mat));
      mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
      scene.add(mesh);
      this.phys.fixedBox(x, y, z, w / 2, h / 2, d / 2);
      return mesh;
    };
    add(40, 1, 40, 0, -0.5, 0, 'floor', 4);
    add(40, 1, 40, 0, 9.5, 0, 'ceiling', 4);
    add(40, 9, 1, 0, 4.5, -20, 'wall', 3.5);
    add(40, 9, 1, 0, 4.5, 20, 'wall', 3.5);
    add(1, 9, 40, -20, 4.5, 0, 'wall', 3.5);
    add(1, 9, 40, 20, 4.5, 0, 'wall', 3.5);
    for (const [x, z] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) add(1.6, 9, 1.6, x, 4.5, z, 'wall', 2);
    add(6, 1.2, 1, 0, 0.6, -3, 'hazard', 1.5);
    add(4, 2.5, 4, -13, 1.25, -13, 'panel', 2);
    add(3, 0.4, 8, 13, 2.5, 0, 'diamond', 2);
    // ramp
    const ramp = new THREE.Mesh(worldBox(4, 0.4, 8, 2), m.get('diamond'));
    ramp.position.set(13, 1.2, 7.8); ramp.rotation.x = 0.32; ramp.receiveShadow = true; scene.add(ramp);
    const rb = this.phys.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(13, 1.2, 7.8).setRotation({ x: Math.sin(0.16), y: 0, z: 0, w: Math.cos(0.16) }));
    this.phys.world.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.2, 4).setCollisionGroups(groups(G.STATIC, ALL)), rb);

    // neon tubes: visible emissive mesh + clustered tube light
    const tube = (a: THREE.Vector3, b: THREE.Vector3, color: number, intensity = 14, radius = 12) => {
      const len = a.distanceTo(b);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, len, 8), m.neon(color, 7));
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      scene.add(mesh);
      this.renderer.lights.add({ type: LightType.Tube, pos: a, pos2: b, color: new THREE.Color(color), intensity, radius });
    };
    tube(new THREE.Vector3(-18, 7.5, -19.3), new THREE.Vector3(18, 7.5, -19.3), 0x19f0ff);
    tube(new THREE.Vector3(-19.3, 7.5, -18), new THREE.Vector3(-19.3, 7.5, 18), 0xff2bd6);
    tube(new THREE.Vector3(19.3, 0.3, -18), new THREE.Vector3(19.3, 0.3, 18), 0xff2bd6, 8, 7);
    tube(new THREE.Vector3(-6.1, 1, -7), new THREE.Vector3(-6.1, 8, -7), 0x19f0ff, 10, 8);
    tube(new THREE.Vector3(6.1, 1, 7), new THREE.Vector3(6.1, 8, 7), 0xffb02e, 10, 8);
    for (let i = 0; i < 5; i++) tube(new THREE.Vector3(-12 + i * 6, 9, 12), new THREE.Vector3(-12 + i * 6, 9, 16), 0xe8f4ff, 9, 10);
    this.renderer.lights.add({ type: LightType.Point, pos: new THREE.Vector3(-13, 3.2, -13), color: new THREE.Color(0xff3b3b), intensity: 12, radius: 9, flicker: 0.6 });
    this.renderer.lights.add({ type: LightType.Spot, pos: new THREE.Vector3(0, 8.9, 0), pos2: new THREE.Vector3(0, -1, 0), spotCos: Math.cos(0.45), color: new THREE.Color(0xdff6ff), intensity: 40, radius: 16 });

    const hemi = new THREE.HemisphereLight(0x223244, 0x07080a, 0.6);
    scene.environment = buildNeonEnvironment(this.renderer.renderer, [0x19f0ff, 0xff2bd6, 0x19f0ff, 0xffb02e]);
    scene.environmentIntensity = 0.35;
    scene.add(hemi);
    const key = new THREE.SpotLight(0xcfe8ff, 60, 30, 0.5, 0.6, 1.6);
    key.position.set(0, 8.8, 0); key.target.position.set(0, 0, 0);
    key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
    scene.add(key, key.target);

    // dynamic crates
    for (let i = 0; i < 8; i++) {
      const s = 0.7 + Math.random() * 0.6;
      const mesh = new THREE.Mesh(worldBox(s, s, s, 1), m.get(i % 2 ? 'panel' : 'metal'));
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      const body = this.phys.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-4 + (i % 4) * 2.5, 1 + Math.floor(i / 4) * 1.5, 3));
      this.phys.world.createCollider(RAPIER.ColliderDesc.cuboid(s / 2, s / 2, s / 2).setDensity(300).setCollisionGroups(groups(G.PROP, ALL)), body);
      this.props.push({ mesh, body });
    }
  }

  private start() {
    const loop = createLoop({
      step: STEP,
      onStep: dt => this.step(dt),
      onRender: (alpha, frameDt) => this.frame(alpha, frameDt),
    });
    loop.start(() => this.time.scale, realDt => this.time.update(realDt));
  }

  private step(dt: number) {
    this.player.update(dt, this.input);
    this.phys.step(dt);
    this.input.endStep();
  }

  private frame(alpha: number, realDt: number) {
    const { dx, dy } = this.input.consumeMouse();
    const p = this.player;
    p.yaw -= dx; p.pitch = THREE.MathUtils.clamp(p.pitch - dy, -1.55, 1.55);
    for (const pr of this.props) {
      const t = pr.body.translation(), r = pr.body.rotation();
      pr.mesh.position.set(t.x, t.y, t.z); pr.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
    const eye = new THREE.Vector3().lerpVectors(p.prevPos, p.pos, alpha); eye.y += p.eyeOffset;
    this.rig.apply(this.renderer.camera, eye, p, realDt, h => this.renderer.setHFov(h));
    this.renderer.render(realDt, realDt * this.time.scale);
  }
}
