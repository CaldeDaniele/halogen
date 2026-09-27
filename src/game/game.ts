import * as THREE from 'three';
import { Renderer } from '../render/renderer';
import { PhysicsWorld, RAPIER, G, groups } from '../physics/world';
import { Materials } from '../render/materials';
import { Input } from '../core/input';
import { Time } from '../core/time';
import { Events } from '../core/events';
import { Rng } from '../core/rng';
import { Budget } from '../core/budget';
import { createLoop } from '../core/loop';
import { PlayerController } from './player/controller';
import { CameraRig } from './player/camera';
import { WeaponSystem, WEAPONS } from './player/weapons';
import { KineticHand } from './player/kinetic';
import { Particles } from '../render/particles';
import { Decals } from '../render/decals';
import { Sfx } from '../audio/synth';
import { Music } from '../audio/music';
import { buildNeonEnvironment } from '../render/envmap';
import { LightType } from '../render/lights';
import type { Ctx, GameEvents, HitInfo, Owner } from './types';
import { RunState } from './run/state';
import { offerCards, applyCard, cardById, LOCKED_AT_START, unlockFor, Milestone } from './run/cards';
import { buildSectorMap, SectorMap, MapNode } from './level/runmap';
import { generateRoom, PALETTES } from './level/generator';
import { Room, Door } from './level/builder';
import { Fixture } from './level/fixtures';
import { DebrisSystem, Prop } from './level/props';
import { Android } from './enemies/android';
import { AndroidAI } from './enemies/ai';
import { Director } from './enemies/director';
import type { EnemyType } from './enemies/defs';
import { Bolts } from './bolts';
import { Pickups } from './pickups';
import { Hud } from '../ui/hud';
import { CombatText } from '../ui/combattext';
import { pickCard } from '../ui/cards';
import { explode } from './combat';
import { palette, Palette, CvdMode } from './palette';
import type { Seg } from '../physics/ragdoll';
import { Menus } from '../ui/menus';
import { DevOverlay } from '../ui/devoverlay';
import { Boss, createBoss } from './enemies/bosses';

const STEP = 1 / 120;
type Mode = 'title' | 'play' | 'cards' | 'transition' | 'dead' | 'paused' | 'victory';

const REWARD_LABEL: Record<string, string> = { card: 'UPGRADE', rare: 'RARE UPGRADE', heal: 'REPAIR', weapon: 'ARMORY', lumen: 'LUMEN CACHE', none: '' };
const ROOM_LABEL: Record<string, string> = { arena: 'ARENA', gauntlet: 'GAUNTLET', shaft: 'SHAFT', dark: 'DARK ZONE', boss: 'OVERSEER', rest: 'SANCTUM', elite: 'ELITE' };
const SECTOR_NAMES = ['FOUNDRY', 'GRID', 'FILAMENT'];
const SECTOR_TAGS = ['Where the androids were cast. The racks are no longer empty.', "The arcology's power plant. Someone is still flipping switches.", 'Light grew here until it learned to want.'];
const GRADES = [
  { hue: -0.02, sat: 0.05, contrast: 0.1, bright: 0, fog: 0x010204, ext: 0.008, dens: 0.7 },
  { hue: 0.02, sat: 0.08, contrast: 0.12, bright: 0.01, fog: 0x040201, ext: 0.01, dens: 0.85 },
  { hue: -0.03, sat: 0.12, contrast: 0.14, bright: -0.01, fog: 0x020103, ext: 0.008, dens: 0.6 },
];

export class Game {
  renderer!: Renderer;
  phys!: PhysicsWorld;
  mats!: Materials;
  input!: Input;
  time = new Time();
  events = new Events<GameEvents>();
  sfx!: Sfx;
  music!: Music;
  player!: PlayerController;
  rig = new CameraRig();
  weapons!: WeaponSystem;
  kinetic!: KineticHand;
  particles!: Particles;
  decals!: Decals;
  debris!: DebrisSystem;
  bolts!: Bolts;
  pickups!: Pickups;
  hud!: Hud;
  palette: Palette = palette('default');
  combatText!: CombatText;
  menus!: Menus;
  dev!: DevOverlay;
  ctx!: Ctx;
  run!: RunState;
  rng!: Rng;
  maps: SectorMap[] = [];
  node!: MapNode;
  room: Room | null = null;
  director: Director | null = null;
  boss: Boss | null = null;
  enemies: Android[] = [];
  corpses!: Budget<Android>;
  mode: Mode = 'title';
  inLight = 0;
  private laterQ: { t: number; fn: () => void }[] = [];
  private killTimes: number[] = [];
  private lastKillKinds: string[] = [];
  private roomDepth = 0;
  private hurtCd = 0;
  private dashIFrames = 0;
  private meteorFalling = false;
  private afterglowPts: THREE.Vector3[] = [];
  private beams: { mesh: THREE.Mesh; life: number }[] = [];
  private pins: { seg: Seg; wall: THREE.Vector3; t: number; body?: RAPIER.RigidBody }[] = [];
  private doorLabels: THREE.Sprite[] = [];
  private contactCd = new Map<number, number>();
  private thudCd = 0;
  private heartbeatT = 0;
  private phaseHit = new Set<number>();
  private ui!: HTMLElement;
  private started = false;
  frameMs = 0;
  simMs = 0;

  static async create(canvas: HTMLCanvasElement, ui: HTMLElement, progress: (p: number, m: string) => void) {
    const g = new Game();
    g.ui = ui;
    progress(0.1, 'renderer');
    g.renderer = new Renderer(canvas);
    progress(0.3, 'physics');
    g.phys = await PhysicsWorld.create();
    progress(0.45, 'materials');
    g.mats = new Materials(g.renderer.lights, g.renderer.renderer);
    g.input = new Input(canvas);
    g.sfx = new Sfx();
    g.music = new Music(g.sfx);
    g.particles = new Particles(g.renderer.scene);
    g.decals = new Decals(g.renderer.scene);
    g.hud = new Hud(ui);
    g.combatText = new CombatText(ui);
    g.hud.show(false);
    progress(0.6, 'systems');
    g.player = new PlayerController(g.phys, new THREE.Vector3(0, 0, 0));
    g.run = new RunState(1);
    g.ctx = {
      renderer: g.renderer, scene: g.renderer.scene, camera: g.renderer.camera, phys: g.phys, lights: g.renderer.lights, mats: g.mats,
      particles: g.particles, decals: g.decals, sfx: g.sfx, events: g.events, time: g.time, player: g.player, rig: g.rig,
      hud: {
        hitmarker: k => g.hud.hitmarker(k),
        damage: from => g.hud.damage(from ? Hud.angleTo(g.renderer.camera, from) : null),
        toast: (m, c, t) => g.hud.toast(m, c, t),
        feedMsg: (m, p, c) => g.hud.feedMsg(m, p, c),
      },
      run: g.run, game: g,
    };
    g.debris = new DebrisSystem(g.ctx, 200);
    g.weapons = new WeaponSystem(g.ctx, g.run.weapons);
    g.kinetic = new KineticHand(g.ctx);
    g.bolts = new Bolts(g.ctx, () => g.enemies);
    g.pickups = new Pickups(g.ctx);
    g.corpses = new Budget<Android>(40, a => g.disposeAndroid(a));
    g.dev = new DevOverlay(ui, g);
    g.wireEvents();
    g.registerContacts();
    g.input.onLockChange = locked => { if (!locked && g.mode === 'play') g.pause(true); };
    canvas.addEventListener('click', () => { if (g.mode === 'play' && !g.input.locked) g.input.requestLock(); });
    progress(0.8, 'environment');
    g.applySector(0);
    g.music.preload(['title', 's1_ambient', 's1_combat']);
    g.menus = new Menus(ui, g);
    g.renderer.onAutoDowngrade = q => { g.hud.toast(`QUALITY → ${q.toUpperCase()} (AUTO)`, '#7d8b93', 1.6); g.menus.settings.quality = q; };
    progress(0.9, 'title');
    g.startTitleScene();
    progress(1, 'ready');
    g.start();
    return g;
  }

  // ---------------------------------------------------------------- flow
  private startTitleScene() {
    this.mode = 'title';
    // a live idle room behind the title
    this.rng = new Rng(Rng.hash('title'));
    this.loadRoomLayout(generateRoom(777, 'arena', 0), 0);
    this.player.teleport(new THREE.Vector3(0, 0, 6), 0);
    this.player.frozen = true;
    for (let i = 0; i < 3; i++) this.spawnEnemy('grunt', this.room!.worldSpawn(i), false);
    this.menus.showTitle();
    this.music.single('title', 0.8);
  }

  /** Called by the title menu. */
  newRun(seed?: number) {
    this.sfx.resume();
    const s = seed ?? ((Math.random() * 2 ** 31) | 0);
    this.time.reset();
    this.run = new RunState(s);
    this.ctx.run = this.run;
    this.rng = new Rng(s);
    this.maps = [0, 1, 2].map(i => buildSectorMap(s, i));
    this.weapons.setSlots(this.run.weapons);
    this.applyMods();
    this.roomDepth = 0;
    this.mode = 'transition';
    this.player.frozen = false;
    this.hud.show(true);
    this.enterNode(this.maps[0].nodes[this.maps[0].start]);
    this.input.requestLock();
    history.replaceState(null, '', `?seed=${s}`);
  }

  private enterNode(node: MapNode) {
    this.node = node;
    const sector = this.maps.findIndex(m => m.nodes.includes(node));
    this.run.sector = sector;
    const layout = generateRoom(node.seed, node.type, sector, Math.max(1, node.next.length));
    this.loadRoomLayout(layout, sector);
    this.director = new Director(this.rng.fork('dir' + node.id + sector), sector, node.layer, node.type);
    this.player.teleport(this.room!.entryPoint.add(new THREE.Vector3(0, 0, -1.5)), 0);
    this.weapons.refill();
    this.mode = 'play';
    this.events.emit('roomEntered', { room: this.room });
    this.hud.toast(`${SECTOR_NAMES[sector]} · ${ROOM_LABEL[node.type]}`, '#' + PALETTES[sector][0].toString(16).padStart(6, '0'), 2.2);
    if (node.type === 'boss') { this.boss = createBoss(this.ctx, sector, this.room!, (t, p) => this.spawnEnemy(t, p, true)); this.music.single(`s${sector + 1}_boss`, 0.95); }
    else { this.boss = null; this.music.sector(sector); }
    if (node.type === 'rest') this.later(0.8, () => this.restRoom());
    if (node.layer === 0) this.menus.sectorSplash(sector, SECTOR_NAMES[sector], SECTOR_TAGS[sector]);
    this.room!.entryDoor.target = 0;
  }

  private loadRoomLayout(layout: ReturnType<typeof generateRoom>, sector: number) {
    this.clearRoom();
    this.applySector(sector);
    this.room = new Room(this.ctx, layout, this.debris, (f, by) => this.onFixtureBroken(f, by), p => this.onPropDestroyed(p));
    this.room.nav.lightAt = p => this.renderer.lights.sample(p);
    this.renderer.volumetric.setFog(new THREE.Color(GRADES[sector].fog), GRADES[sector].ext, GRADES[sector].dens * (layout.type === 'dark' ? 1.3 : 1));
    this.labelDoors();
  }

  private clearRoom() {
    this.kinetic.drop(); // release everything before any body it references is removed
    for (const a of this.enemies) this.disposeAndroid(a);
    for (const a of [...this.corpses.items]) this.disposeAndroid(a);
    this.corpses.clear();
    this.enemies = [];
    this.boss?.dispose(); this.boss = null;
    this.bolts.clear(); this.pickups.clear(); this.debris.clear(); this.weapons.clear(); this.kinetic.drop(); this.combatText.clear();
    for (const p of this.pins) if (p.body) this.phys.removeBody(p.body);
    this.pins = [];
    for (const b of this.beams) b.mesh.removeFromParent();
    this.beams = [];
    for (const l of this.doorLabels) l.removeFromParent();
    this.doorLabels = [];
    this.room?.dispose(); this.room = null;
    this.decals.clear(); this.particles.clear();
    this.laterQ = [];
    // clear transient lights (flashes); room lights are owned by the room
    this.renderer.lights.lights.filter(l => l.ttl >= 0).forEach(l => this.renderer.lights.remove(l));
  }

  private applySector(i: number) {
    const gr = GRADES[i % 3];
    this.renderer.grade = { hue: gr.hue, sat: gr.sat, contrast: gr.contrast, bright: gr.bright };
    const scene = this.renderer.scene;
    scene.environment?.dispose();
    scene.environment = buildNeonEnvironment(this.renderer.renderer, PALETTES[i % 3]);
    scene.environmentIntensity = 0.22;
    let hemi = scene.getObjectByName('hemi') as THREE.HemisphereLight | undefined;
    if (!hemi) { hemi = new THREE.HemisphereLight(0x223244, 0x07080a, 0.2); hemi.name = 'hemi'; scene.add(hemi); }
    hemi.color.set(new THREE.Color(PALETTES[i % 3][0]).multiplyScalar(0.25).add(new THREE.Color(0x151a20)));
  }

  private labelDoors() {
    if (!this.room) return;
    const next = this.node && this.mode !== 'title' ? this.node.next : [];
    this.room.doors.forEach((d, i) => {
      const target = next[i] !== undefined ? this.maps[this.run.sector]?.nodes[next[i]] : undefined;
      d.reward = target ? target.type : undefined;
      if (!target) return;
      const text = `${ROOM_LABEL[target.type]}\n${REWARD_LABEL[target.reward]}`;
      const c = document.createElement('canvas'); c.width = 512; c.height = 160;
      const g = c.getContext('2d')!;
      g.font = '700 54px "Chakra Petch", sans-serif'; g.textAlign = 'center';
      g.fillStyle = '#' + PALETTES[this.run.sector][0].toString(16).padStart(6, '0');
      g.shadowColor = g.fillStyle; g.shadowBlur = 18;
      const [l1, l2] = text.split('\n');
      g.fillText(l1, 256, 64); g.font = '600 34px "Chakra Petch", sans-serif'; g.fillStyle = '#e8f4f8'; g.fillText(l2, 256, 124);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, color: new THREE.Color(1.6, 1.6, 1.6) }));
      sp.scale.set(3.2, 1, 1);
      sp.position.copy(d.world).add(new THREE.Vector3(0, 4.4, 1.2));
      sp.visible = false;
      this.renderer.scene.add(sp);
      this.doorLabels.push(sp);
    });
  }

  pause(on: boolean) {
    if (on && this.mode === 'play') { this.mode = 'paused'; this.menus.showPause(); }
    else if (!on && this.mode === 'paused') { this.mode = 'play'; this.menus.hide(); this.input.requestLock(); }
  }

  // ---------------------------------------------------------------- spawning
  spawnEnemy(type: EnemyType, pos: THREE.Vector3, withFx = true) {
    const yaw = Math.atan2(-(this.player.pos.x - pos.x), -(this.player.pos.z - pos.z));
    const a = new Android(this.ctx, type, pos, yaw);
    if (this.room) new AndroidAI(this.ctx, a, this.room.nav, () => this.enemies);
    a.ai.alert = this.mode === 'play';
    a.ai.cooldown = 1.2 + Math.random();
    this.enemies.push(a);
    if (withFx) {
      const top = pos.clone().add(new THREE.Vector3(0, 6, 0));
      this.renderer.lights.add({ type: LightType.Tube, pos: pos.clone().add(new THREE.Vector3(0, 0.2, 0)), pos2: top, color: new THREE.Color(a.stats.color), intensity: 24, radius: 5, ttl: 0.7 });
      this.particles.sparksAt(pos.clone().add(new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, 1, 0), 30, a.stats.color, 7, 1.2, 0.7);
      this.particles.glowAt(pos.clone().add(new THREE.Vector3(0, 1, 0)), a.stats.color, 3, 0.4);
      this.sfx.play('servo', { pos });
    }
    return a;
  }

  private disposeAndroid(a: Android) {
    this.kinetic.forget(a);
    a.dispose();
  }

  // ---------------------------------------------------------------- services used by systems
  later(t: number, fn: () => void) { this.laterQ.push({ t, fn }); }

  damagePlayer(amount: number, from?: THREE.Vector3) {
    if (this.mode !== 'play' || amount <= 0) return;
    if (this.dashIFrames > 0) { this.hud.toast('EVADED', '#19f0ff', 0.6); return; }
    let a = amount;
    if (this.run.mods.momentum && this.player.horizSpeed > 11) a *= 0.6;
    const dealt = this.run.damage(a);
    this.director?.onPlayerHit(dealt);
    this.run.style = Math.max(0, this.run.style - 0.7);
    this.ctx.hud.damage(from);
    this.rig.addTrauma(Math.min(0.5, 0.12 + a / 60));
    this.renderer.caPulse = Math.min(1, this.renderer.caPulse + 0.35);
    if (this.hurtCd <= 0) { this.sfx.play('hurt'); this.hurtCd = 0.12; }
    this.events.emit('playerDamaged', { amount: dealt, from });
    if (this.run.hp <= 0) this.die();
  }
  knockPlayer(v: THREE.Vector3) { this.player.vel.add(v); this.player.grounded = false; }
  selfBlast(dir: THREE.Vector3, imp: number) { this.player.vel.addScaledVector(dir, imp * 0.6); this.player.vel.y += imp * 0.35; }
  enemyFire(origin: THREE.Vector3, dir: THREE.Vector3, dmg: number, color: number, speed: number, friendly = false) { this.bolts.fire(origin, dir, dmg, color, speed, friendly); }
  nearestBrokenFixture(p: THREE.Vector3, r: number) {
    let best: Fixture | null = null, bd = r;
    for (const f of this.room?.fixtures ?? []) if (f.broken) { const d = f.pos.distanceTo(p); if (d < bd) { bd = d; best = f; } }
    return best;
  }
  repairFixture(f: Fixture) { f.repair(); this.events.emit('lightRestored', { fixture: f }); }
  drawBeam(a: THREE.Vector3, b: THREE.Vector3, color: number, life = 0.05) {
    const len = a.distanceTo(b);
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, len), this.mats.neon(color, 4));
    m.position.copy(a).add(b).multiplyScalar(0.5); m.lookAt(b);
    this.renderer.scene.add(m);
    this.beams.push({ mesh: m, life });
  }
  lightning(a: THREE.Vector3, b: THREE.Vector3, color = 0x9ff6ff) {
    const n = 7; let prev = a.clone();
    for (let i = 1; i <= n; i++) {
      const p = a.clone().lerp(b, i / n);
      if (i < n) p.add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6));
      this.drawBeam(prev, p, color, 0.12); prev = p;
    }
    this.renderer.lights.add({ type: LightType.Tube, pos: a, pos2: b, color: new THREE.Color(color), intensity: 14, radius: 4, ttl: 0.15 });
  }
  spawnFlare(p: THREE.Vector3) {
    const l = this.renderer.lights.add({ pos: p, color: new THREE.Color(0xff4a2a), intensity: 14, radius: 9, ttl: 7, flicker: 0.3 });
    l.fade = false;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), this.mats.neon(0xff4a2a, 10));
    m.position.copy(p); this.renderer.scene.add(m);
    this.later(7, () => m.removeFromParent());
    this.sfx.play('buzz', { pos: p });
  }
  spawnDebrisPiece(pos: THREE.Vector3, geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], vel: THREE.Vector3) {
    geo.computeBoundingBox();
    const s = new THREE.Vector3(); geo.boundingBox!.getSize(s);
    this.debris.spawn(new THREE.Mesh(geo, mat), pos, new THREE.Quaternion(), [s.x / 2, s.y / 2, s.z / 2], vel, 400);
  }
  pinSegment(seg: Seg, h: HitInfo) {
    const hit = this.phys.ray(h.point.x, h.point.y, h.point.z, h.dir.x, h.dir.y, h.dir.z, 14, groups(0xffff, G.STATIC));
    if (!hit) return;
    this.pins.push({ seg, wall: new THREE.Vector3(hit.x, hit.y, hit.z).addScaledVector(new THREE.Vector3(hit.nx, hit.ny, hit.nz), 0.15), t: 0 });
    seg.body.applyImpulse({ x: h.dir.x * 30, y: h.dir.y * 30, z: h.dir.z * 30 }, true);
  }

  // ---------------------------------------------------------------- events
  private wireEvents() {
    const ev = this.events;
    ev.on('enemyHit', ({ hit, enemy }) => {
      if (hit.source === 'player' || hit.source === 'kinetic') {
        const dealt = hit.dealt ?? hit.damage;
        this.hud.hitmarker(hit.headshot ? 'head' : 'hit');
        this.sfx.play(hit.headshot ? 'headshot' : 'hit', { gain: 0.6 + dealt / 40 });
        if (hit.weapon !== 'thermite') this.combatText.hit(enemy, dealt, !!hit.headshot, hit.point, performance.now() / 1000);
      }
      // arc chain
      if (this.run.mods.chain > 0 && hit.source === 'player' && hit.weapon !== 'explosion' && !hit.tags?.has('chain')) {
        const others = this.enemies.filter(e => e !== enemy && e.alive && e.center.distanceTo(hit.point) < 9)
          .sort((a, b) => a.center.distanceTo(hit.point) - b.center.distanceTo(hit.point)).slice(0, this.run.mods.chain);
        for (const o of others) {
          this.lightning(hit.point, o.center);
          o.hit({ point: o.center, normal: new THREE.Vector3(0, 1, 0), dir: o.center.clone().sub(hit.point).normalize(), damage: hit.damage * 0.4, impulse: 3, source: 'player', weapon: 'chain', tags: new Set(['chain']) }, o.body.root);
        }
      }
    });
    ev.on('enemyKilled', ({ hit, enemy, headshot, kinetic, bulletTime, pos }) => {
      const run = this.run;
      run.kills++;
      this.menus.meta.totalKills++;
      if (headshot) run.headshots++;
      if (kinetic) run.kineticKills++;
      this.hud.hitmarker(headshot ? 'head' : 'kill');
      this.sfx.play('kill');
      this.combatText.kill(enemy, performance.now() / 1000);
      this.director?.onKill();
      const now = this.time.realTime;
      this.killTimes.push(now);
      this.killTimes = this.killTimes.filter(t => now - t < 1.4);
      const multi = this.killTimes.length >= 3;
      // style: variety matters
      const kind = kinetic ? 'kinetic' : hit.weapon === 'explosion' ? 'explosion' : headshot ? 'headshot' : hit.weapon ?? 'kill';
      const repeat = this.lastKillKinds.filter(k => k === kind).length;
      this.lastKillKinds.push(kind); if (this.lastKillKinds.length > 5) this.lastKillKinds.shift();
      let st = 0.3;
      if (headshot) st += 0.25;
      if (kinetic) st += 0.5;
      if (kind === 'explosion') st += 0.3;
      if (!this.player.grounded) st += 0.25;
      if (this.player.sliding) st += 0.25;
      if (bulletTime) st += 0.2;
      if (multi) st += 0.4;
      st *= Math.max(0.35, 1 - repeat * 0.2);
      run.style = Math.min(6.99, run.style + st);
      run.bestStyle = Math.max(run.bestStyle, run.style);
      const rank = Math.floor(run.style);
      const pts = Math.round(enemy.stats.score * (1 + rank * 0.5));
      run.score += pts;
      const label = kinetic ? 'KINETIC KILL' : headshot ? 'HEADSHOT' : kind === 'explosion' ? 'DETONATED' : !this.player.grounded ? 'AIRBORNE' : this.player.sliding ? 'SLIDE KILL' : 'TERMINATED';
      this.hud.feedMsg(multi ? `MULTI · ${label}` : label, pts, kinetic ? '#19f0ff' : headshot ? '#ffb02e' : '#e8f4f8');
      // focus
      run.addFocus(headshot ? 0.3 : kinetic ? 0.38 : multi ? 0.45 : 0.1);
      if (bulletTime && run.mods.killchain) this.time.extendSlowmo(0.35);
      // card effects
      if (headshot && run.mods.headhunter) { this.weapons.refill(); run.addFocus(0.15); }
      if (kinetic && run.mods.siphon) run.heal(run.mods.siphon);
      if (run.mods.adrenal) run.shield = Math.min(50, run.shield + 10);
      if (run.mods.volatile && enemy instanceof Android) this.later(0.55, () => explode(this.ctx, enemy.center, 4.2, 60, 22, 'player', 0xff5a1a, new Set(['volatile'])));
      if (Math.random() < (run.mods.scavenger ? 0.4 : 0.25) || run.hp < run.maxHp * 0.3 && Math.random() < 0.4) this.pickups.spawn(pos, 'health');
      if (Math.random() < 0.15) this.pickups.spawn(pos, 'lumen');
      // hit-stop + juice scale with kill quality
      this.time.hitstop(headshot || kinetic ? 55 : 30);
      if (headshot || kinetic || multi) { this.hud.impactFlash(); this.renderer.caPulse = Math.min(1, this.renderer.caPulse + 0.4); }
      this.rig.addTrauma(0.12);
      // move to corpse budget
      this.enemies = this.enemies.filter(e => e !== enemy);
      if (enemy instanceof Android) this.corpses.add(enemy);
    });
    ev.on('limbSevered', ({ pos }) => { if (this.run.mods.graverobber) this.pickups.spawn(pos, 'lumen'); this.run.style = Math.min(6.99, this.run.style + 0.1); });
    ev.on('explosion', () => { this.music.intensity = Math.min(1, this.music.intensity + 0.2); });
  }

  onFixtureBrokenPublic(f: Fixture, byPlayer: boolean) { this.onFixtureBroken(f, byPlayer); }
  private onFixtureBroken(f: Fixture, byPlayer: boolean) {
    this.run.lightsBroken++;
    if (byPlayer) {
      this.run.addLumen(28);
      this.sfx.play('lumenBurst');
      this.hud.feedMsg('LIGHT BROKEN · +LUMEN', 25, '#19f0ff');
      this.run.score += 25;
      this.run.style = Math.min(6.99, this.run.style + 0.15);
    }
    if (this.run.mods.blackout) for (const e of this.enemies) if (e.alive && e.center.distanceTo(f.pos) < 7) e.stagger(undefined, undefined, 1.6);
    this.events.emit('lightBroken', { fixture: f, byPlayer });
  }
  private onPropDestroyed(_p: Prop) { this.run.score += 10; }

  // ---------------------------------------------------------------- rooms
  private onRoomCleared() {
    const room = this.room!;
    if (room.cleared) return;
    room.cleared = true;
    this.run.roomsCleared++;
    if (this.run.mods.nanites) this.run.heal(this.run.mods.nanites);
    this.sfx.play('clear');
    this.hud.toast('ROOM CLEAR', '#e8f4f8', 1.8);
    this.events.emit('roomCleared', { room });
    this.music.intensity = 0;
    this.unlock({ totalKills: this.menus.meta.totalKills });
    if (this.node.type === 'boss') {
      this.unlock({ bossSector: this.run.sector });
      this.music.sting('victory');
      if (this.run.sector >= 2) { this.later(2.5, () => this.victory()); return; }
    }
    // sim-time delay: pauses with the game, so pausing here can't skip the reward/doors
    this.later(1.1, () => { if (this.room === room && this.mode === 'play') this.presentReward(room); });
  }

  private async presentReward(room: Room) {
    await this.rewardPick(this.node.reward);
    if (this.room !== room) return;
    room.setDoorsOpen(true);
    for (const l of this.doorLabels) l.visible = true;
    if (this.node.type === 'boss') {
      // next sector: the single exit leads into the next sector's first room
      this.room!.doors.forEach(d => (d.reward = 'next'));
    }
  }

  private async rewardPick(reward: string) {
    const run = this.run;
    if (reward === 'none') return;
    if (reward === 'heal') { run.heal(50); this.hud.toast('+50 INTEGRITY', '#50ff9a'); }
    if (reward === 'lumen') { run.lumen = run.maxLumen; run.focus = Math.max(run.focus, 0.5); }
    const locked = new Set(LOCKED_AT_START.filter(id => !this.menus.meta.unlocked.includes(id)));
    const offers = offerCards(run, this.rng.fork('cards' + run.roomsCleared + run.sector), 3, { rare: reward === 'rare', weaponsOnly: reward === 'weapon', locked });
    const tags = new Set<string>(run.cards.flatMap(id => cardById(id)?.tags ?? []));
    this.mode = 'cards';
    this.input.exitLock();
    const title = reward === 'weapon' ? 'ARMORY · CHOOSE A WEAPON' : reward === 'rare' ? 'RARE UPGRADE · CHOOSE ONE' : 'UPGRADE · CHOOSE ONE';
    const id = await pickCard(this.ui, offers, tags, title, n => this.sfx.play(n));
    applyCard(run, id);
    this.applyMods();
    this.events.emit('cardPicked', { id });
    this.mode = 'play';
    this.input.requestLock();
  }

  private async restRoom() {
    this.hud.toast('SANCTUM · SYSTEMS RESTORED', '#50ff9a', 2);
    this.run.heal(40); this.run.lumen = this.run.maxLumen;
    this.room!.cleared = true;
    await this.rewardPick('rare');
    this.room!.setDoorsOpen(true);
    for (const l of this.doorLabels) l.visible = true;
  }

  private applyMods() {
    const m = this.run.mods;
    this.player.maxAirJumps = 1 + m.extraAirJumps;
    this.player.maxDashCharges = 2 + m.extraDash;
    this.weapons.setSlots(this.run.weapons);
    this.run.hp = Math.min(this.run.hp, this.run.maxHp);
  }

  private goThroughDoor(i: number) {
    if (this.mode !== 'play') return;
    const map = this.maps[this.run.sector];
    let nextNode: MapNode | undefined;
    if (this.node.type === 'boss') {
      const nm = this.maps[this.run.sector + 1];
      if (!nm) return;
      nextNode = nm.nodes[nm.start];
    } else nextNode = map.nodes[this.node.next[i] ?? this.node.next[0]];
    if (!nextNode) return;
    this.mode = 'transition';
    this.roomDepth++;
    this.menus.fade(true);
    this.sfx.play('door');
    setTimeout(() => { this.enterNode(nextNode!); this.menus.fade(false); }, 450);
  }

  private die() {
    if (this.mode === 'dead') return;
    this.mode = 'dead';
    this.time.slowmo(0.15, 2.5);
    this.music.stopAll();
    this.music.sting('death');
    this.kinetic.drop();
    this.events.emit('playerDied', undefined);
    setTimeout(() => { this.input.exitLock(); this.menus.showEnd(false); }, 1400);
  }
  private unlock(m: Milestone) {
    const meta = this.menus.meta;
    const got = unlockFor(m, new Set(meta.unlocked));
    got.forEach((id, i) => this.later(1.5 + i * 1.8, () => this.hud.toast(`UNLOCKED · ${cardById(id)?.name.toUpperCase()}`, '#ff2bd6', 1.8)));
    meta.unlocked.push(...got);
    this.menus.saveMeta();
  }

  private victory() {
    if (this.mode === 'dead' || this.mode === 'title') return;
    this.unlock({ victory: true });
    this.mode = 'victory';
    this.input.exitLock();
    this.menus.showEnd(true);
  }

  toTitle() {
    this.menus.hide();
    this.hud.show(false);
    this.startTitleScene();
  }

  // ---------------------------------------------------------------- loop
  private fpsCap = 0;
  get fpsCapLabel() { return this.fpsCap ? this.fpsCap + 'fps' : 'vsync'; }
  private loop?: ReturnType<typeof createLoop>;
  /** Colorblind telegraph palette: enemy/boss tells read it at the moment they fire; HUD colors are CSS vars. */
  setPalette(mode: CvdMode) {
    this.palette = palette(mode);
    const css = document.documentElement.style, hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
    css.setProperty('--hurt', hex(this.palette.hurt));
    css.setProperty('--kill', hex(this.palette.kill));
    css.setProperty('--head', hex(this.palette.head));
  }

  /** 0 = uncapped (vsync / native refresh). */
  setFpsCap(cap: number) {
    this.fpsCap = cap;
    if (this.loop) this.loop.limiter.cap = cap;
    this.renderer.minFrameMs = cap > 0 ? 1000 / cap : 0;
  }

  private start() {
    const loop = this.loop = createLoop({
      step: STEP,
      onStep: dt => this.step(dt),
      onRender: (alpha, frameDt) => this.frame(alpha, frameDt),
    });
    loop.limiter.cap = this.fpsCap;
    loop.start(() => {
      if (this.mode === 'play' && !this.input.locked && !(window as any).__noLockPrompt) return 0; // never simulate combat the player can't aim in
      return ((this.mode === 'play' || this.mode === 'dead' || this.mode === 'title' || this.mode === 'victory') ? this.time.scale : 0) * this.dev.timescale;
    }, realDt => this.time.update(realDt));
  }

  private step(dt: number) {
    const t0 = performance.now();
    this.time.advanceSim(dt);
    const input = this.input;
    const run = this.run;
    const playing = this.mode === 'play';
    this.hurtCd -= dt;
    this.dashIFrames = Math.max(0, this.dashIFrames - dt);

    // delayed actions
    for (let i = this.laterQ.length - 1; i >= 0; i--) { const q = this.laterQ[i]; q.t -= dt; if (q.t <= 0) { this.laterQ.splice(i, 1); q.fn(); } }

    if (playing) {
      // meteor slam
      if (run.mods.meteor && !this.player.grounded && input.pressed('ControlLeft') && !this.meteorFalling) { this.meteorFalling = true; this.player.vel.y = -34; this.sfx.play('dash'); }
      this.player.update(dt, input);
      for (const e of this.player.events) this.onPlayerEvent(e);
      this.weapons.update(dt, input, dt);
      this.kinetic.update(dt, input);
      if (run.mods.timebank && input.pressed('KeyQ') && run.focus >= 1) this.triggerBulletTime();
      if (input.pressed('Escape')) this.pause(true);
    }
    // AI + bodies
    for (const a of this.enemies) { a.ai?.update(dt); a.step(dt); }
    for (const a of this.corpses.items) a.step(dt);
    this.boss?.update(dt);
    // shade visibility
    for (const a of this.enemies) if (a.type === 'shade' && a.alive) {
      const lvl = this.renderer.lights.sample(a.center, a.core);
      const v = run.mods.umbra ? Math.max(0.65, lvl) : THREE.MathUtils.smoothstep(lvl, 0.12, 0.5);
      a.visibility += (v - a.visibility) * Math.min(1, dt * 6);
      a.setHittable(a.visibility > 0.3);
    }
    this.puppeteer(dt);
    this.movementCards(dt);
    this.phys.step(dt);
    this.pinsUpdate(dt);
    this.bolts.update(dt);
    this.pickups.update(dt);
    this.debris.update(dt);
    this.room?.update(dt);

    if (playing && this.room) {
      // director
      const wave = this.director?.update(dt, this.enemies.filter(e => e.alive).length, run.hp / run.maxHp);
      if (wave) this.spawnWave(wave);
      const alive = this.enemies.filter(e => e.alive).length;
      const combat = alive > 0 || (this.director && !this.director.done);
      this.music.intensity += ((combat ? Math.min(1, 0.55 + alive * 0.08) : 0) - this.music.intensity) * Math.min(1, dt * 0.8);
      if (!wave && !this.room.cleared && this.director?.done && alive === 0 && (!this.boss || this.boss.dead) && this.node.type !== 'rest') this.onRoomCleared();
      // doors
      if (this.room.cleared) this.room.doors.forEach((d, i) => { if (d.open > 0.6 && this.player.pos.distanceTo(d.world.clone().setY(this.player.pos.y)) < 1.6) this.goThroughDoor(i); });
      // light & lumen
      this.inLight = this.renderer.lights.sample(this.player.eye);
      if (this.inLight > 0.25) run.addLumen(9 * Math.min(2, this.inLight) * dt);
      if (run.mods.photovore && this.inLight > 0.3) run.heal(2.5 * dt);
      // focus → bullet time
      if (run.focus >= 1 && !run.mods.timebank && !this.time.isBulletTime) this.triggerBulletTime();
      run.style = Math.max(0, run.style - dt * (0.12 + run.style * 0.03));
      if (run.hp < run.maxHp * 0.3) { this.heartbeatT -= dt; if (this.heartbeatT <= 0) { this.sfx.play('heartbeat'); this.heartbeatT = 0.9; } }
      if (this.player.pos.y < -30) this.damagePlayer(999);
    }
    this.renderer.desat += ((this.time.isBulletTime ? 1 : 0) - this.renderer.desat) * Math.min(1, dt * 12);
    this.sfx.setBulletTime(this.time.isBulletTime);
    input.endStep();
    this.simMs = performance.now() - t0;
  }

  private triggerBulletTime() {
    this.run.focus = 0;
    this.time.slowmo(0.22, 1.25 * this.run.mods.btDurMul);
    this.hud.impactFlash();
    this.renderer.caPulse = 1;
    this.rig.fovKick += 8;
    this.events.emit('focusTriggered', undefined);
  }

  private spawnWave(wave: { type: EnemyType; count: number }[]) {
    const room = this.room!;
    let k = Math.floor(Math.random() * 100);
    for (const w of wave) for (let i = 0; i < w.count; i++) {
      // pick a spawn not too close to the player
      let p = room.worldSpawn(k++);
      for (let tries = 0; tries < 6 && p.distanceTo(this.player.pos) < 9; tries++) p = room.worldSpawn(k++);
      p.x += (Math.random() - 0.5) * 0.8; p.z += (Math.random() - 0.5) * 0.8;
      this.spawnEnemy(w.type, p, true);
    }
  }

  private onPlayerEvent(e: PlayerController['events'][number]) {
    switch (e.type) {
      case 'jump': this.sfx.play('jump'); break;
      case 'airjump': this.sfx.play('jump', { pitch: 1.3 }); this.particles.sparksAt(this.player.pos.clone().setY(this.player.pos.y - 0.9), new THREE.Vector3(0, -1, 0), 8, 0x19f0ff, 4, 1, 0.3); break;
      case 'walljump': this.sfx.play('jump', { pitch: 0.8 }); this.rig.addTrauma(0.05); break;
      case 'dash':
        this.sfx.play('dash'); this.rig.fovKick += 10; this.dashIFrames = 0.14; this.phaseHit.clear();
        this.renderer.caPulse = Math.min(1, this.renderer.caPulse + 0.2);
        if (this.run.mods.afterglow) this.afterglowPts = [this.player.pos.clone()];
        break;
      case 'slide': this.sfx.play('slide'); break;
      case 'land':
        this.sfx.play('land', { gain: Math.min(1.5, e.speed / 12) });
        this.rig.dip.kick(-Math.min(1.8, e.speed * 0.08));
        if (e.speed > 16) this.rig.addTrauma(Math.min(0.4, e.speed / 60));
        if (this.meteorFalling) {
          this.meteorFalling = false;
          const p = this.player.pos.clone().setY(this.player.pos.y - 0.9);
          explode(this.ctx, p, 5.5, 55, 32, 'player', 0x19f0ff);
        }
        break;
      case 'step': this.sfx.play('step'); break;
    }
  }

  private movementCards(dt: number) {
    const run = this.run, p = this.player;
    // slide tackle / phase dash / afterglow
    const dashing = this.dashIFrames > 0;
    for (const a of this.enemies) {
      if (!a.alive || a.state !== 'alive') continue;
      const d = a.center.distanceTo(p.pos);
      if (run.mods.slideTackle && p.sliding && d < 1.4 * a.stats.scale && !a.isBoss) {
        a.hit({ point: a.center, normal: new THREE.Vector3(0, 1, 0), dir: p.vel.clone().normalize().setY(0.4), damage: 15, impulse: 14, source: 'kinetic', weapon: 'slide' }, a.body.root);
        a.stagger(undefined, undefined, 1.2);
        this.sfx.play('thud', { pos: a.center });
      }
      if (run.mods.phaseDash && dashing && d < 1.6 * a.stats.scale && !this.phaseHit.has(a.id)) {
        this.phaseHit.add(a.id);
        a.hit({ point: a.center, normal: new THREE.Vector3(0, 1, 0), dir: p.vel.clone().normalize(), damage: 45, impulse: 10, source: 'player', weapon: 'phase' }, a.body.root);
        this.particles.sparksAt(a.center, new THREE.Vector3(0, 1, 0), 20, 0x19f0ff, 8, 1, 0.4);
      }
    }
    if (run.mods.afterglow && this.afterglowPts.length && dashing) this.afterglowPts.push(p.pos.clone());
    if (run.mods.afterglow && this.afterglowPts.length > 1 && !dashing) {
      const a = this.afterglowPts[0].clone().setY(p.pos.y - 0.6), b = this.afterglowPts[this.afterglowPts.length - 1].clone().setY(p.pos.y - 0.6);
      this.renderer.lights.add({ type: LightType.Tube, pos: a, pos2: b, color: new THREE.Color(0xff2bd6), intensity: 14, radius: 5, ttl: 1.6 });
      this.drawBeam(a, b, 0xff2bd6, 1.6);
      const segA = a, segB = b;
      this.later(0.05, () => {
        for (const e of this.enemies) if (e.alive) {
          const c = e.center; const ab = segB.clone().sub(segA);
          const t = THREE.MathUtils.clamp(c.clone().sub(segA).dot(ab) / Math.max(ab.lengthSq(), 1e-3), 0, 1);
          if (segA.clone().addScaledVector(ab, t).distanceTo(c) < 1.6) e.hit({ point: c, normal: new THREE.Vector3(0, 1, 0), dir: new THREE.Vector3(0, 1, 0), damage: 30, impulse: 4, source: 'player', weapon: 'afterglow', tags: new Set(['thermite']) }, e.body.root);
        }
      });
      this.afterglowPts = [];
    }
  }

  private puppetT = 0;
  private puppeteer(dt: number) {
    if (!this.run.mods.puppeteer) return;
    this.puppetT -= dt;
    if (this.puppetT > 0) return;
    for (const h of this.kinetic.held) {
      const a = h.android;
      if (!a || a.state === 'dead' || (a.type !== 'grunt')) continue;
      const target = this.enemies.filter(e => e !== a && e.alive).sort((x, y) => x.center.distanceTo(a.center) - y.center.distanceTo(a.center))[0];
      if (!target) continue;
      const m = a.muzzle();
      this.enemyFire(m, target.center.clone().sub(m).normalize(), a.stats.dmg, 0x19f0ff, 34, true);
      this.puppetT = 0.35;
    }
  }

  private pinsUpdate(dt: number) {
    for (let i = this.pins.length - 1; i >= 0; i--) {
      const p = this.pins[i];
      if (p.body) continue;
      p.t += dt;
      const t = p.seg.body.translation();
      const d = p.wall.distanceTo(new THREE.Vector3(t.x, t.y, t.z));
      if (d < 0.9 || p.t > 0.35) {
        if (d > 3) { this.pins.splice(i, 1); continue; }
        const body = this.phys.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(t.x, t.y, t.z));
        this.phys.world.createImpulseJoint(RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), body, p.seg.body, true);
        p.body = body;
        this.particles.sparksAt(new THREE.Vector3(t.x, t.y, t.z), new THREE.Vector3(0, 1, 0), 20, 0xd0b8ff, 6, 1, 0.5);
        this.sfx.play('impactMetal', { pos: new THREE.Vector3(t.x, t.y, t.z), gain: 1.8 });
        this.hud.feedMsg('PINNED', 50, '#d0b8ff'); this.run.score += 50;
      }
    }
  }

  /** rendered frames since boot (tests, bench) */
  frameCount = 0;

  private frame(alpha: number, realDt: number) {
    this.frameCount++;
    const t0 = performance.now();
    const p = this.player;
    if (this.mode === 'play' || this.mode === 'dead') {
      const { dx, dy } = this.input.consumeMouse();
      if (this.mode === 'play') { p.yaw -= dx; p.pitch = THREE.MathUtils.clamp(p.pitch - dy, -1.55, 1.55); }
    } else this.input.consumeMouse();
    if (this.mode === 'title') {
      // slow orbiting camera for the title backdrop
      const t = performance.now() / 1000;
      p.yaw = Math.sin(t * 0.08) * 0.6; p.pitch = -0.08 + Math.sin(t * 0.11) * 0.04;
    }
    for (const a of this.enemies) a.sync();
    for (const a of this.corpses.items) a.sync();
    this.boss?.sync();
    const eye = new THREE.Vector3().lerpVectors(p.prevPos, p.pos, alpha); eye.y += p.eyeOffset;
    if (this.mode === 'dead') { eye.y = Math.max(p.pos.y - 0.6, eye.y - 0.9); }
    this.rig.apply(this.renderer.camera, eye, p, realDt, h => this.renderer.setHFov(h));
    const cam = this.renderer.camera;
    cam.updateMatrixWorld();
    this.sfx.setListener(cam.position, new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion));
    const simDt = realDt * this.time.scale;
    this.particles.update(this.mode === 'cards' || this.mode === 'paused' ? 0 : simDt, cam);
    this.decals.update(realDt);
    for (let i = this.beams.length - 1; i >= 0; i--) { const b = this.beams[i]; b.life -= realDt; if (b.life <= 0) { b.mesh.removeFromParent(); b.mesh.geometry.dispose(); this.beams.splice(i, 1); } }
    this.music.update(realDt);
    if (this.mode !== 'title') {
      const w = this.weapons;
      this.hud.update({
        hp: this.run.hp, maxHp: this.run.maxHp, shield: this.run.shield, lumen: this.run.lumen, maxLumen: this.run.maxLumen, focus: this.run.focus,
        weapon: WEAPONS[w.id].name, ammo: w.ammo[w.id], mag: w.magSize(), reload: w.reloadingFrac, charge: w.chargeFrac,
        slots: w.slots.map(s => WEAPONS[s].name.split(' ')[0]), cur: w.cur, dash: p.dashCharges, maxDash: p.maxDashCharges, style: this.run.style,
        enemies: this.enemies.filter(e => e.alive).length, room: this.node ? `${SECTOR_NAMES[this.run.sector]} · ${ROOM_LABEL[this.node.type]}` : '',
        bulletTime: this.time.isBulletTime, inLight: this.inLight, holding: this.kinetic.holding,
      }, realDt);
      this.combatText.update(cam, performance.now() / 1000);
    }
    this.hud.setPrompt(this.mode === 'play' && !this.input.locked && !(window as any).__noLockPrompt ? 'CLICK TO ENGAGE' : null);
    this.hud.boss(this.boss && !this.boss.dead && this.mode !== 'title' ? this.boss.name : null, this.boss ? this.boss.hp / this.boss.maxHp : 0, this.boss?.state ?? '');
    this.renderer.wet.wetness = 1;
    this.renderer.render(realDt, simDt);
    this.dev.update(realDt);
    this.frameMs = performance.now() - t0;
  }

  /** ?bench — worst case from the spec: 40 ragdolls, 200 debris, 128 lights. Reports frame-time percentiles. */
  async bench() {
    this.menus.hide();
    this.newRun(1);
    (window as any).__noLockPrompt = true;
    this.director = null;
    const room = this.room!;
    for (let i = 0; i < 40; i++) {
      const a = this.spawnEnemy(i % 3 ? 'grunt' : 'skitter', room.worldSpawn(i), false);
      a.die({ point: a.center, normal: new THREE.Vector3(0, 1, 0), dir: new THREE.Vector3(Math.random() - 0.5, 0.6, Math.random() - 0.5).normalize(), damage: 999, impulse: 12, source: 'player' });
    }
    const geo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    for (let i = 0; i < 200; i++) {
      const p = new THREE.Vector3((Math.random() - 0.5) * 20, 2 + Math.random() * 6, (Math.random() - 0.5) * 20);
      this.debris.spawn(new THREE.Mesh(geo, this.mats.get('chunk')), p, new THREE.Quaternion(), [0.2, 0.2, 0.2], new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6));
    }
    const L = this.renderer.lights;
    while (L.lights.length < 128) L.add({ pos: new THREE.Vector3((Math.random() - 0.5) * 30, 0.5 + Math.random() * 6, (Math.random() - 0.5) * 30), color: new THREE.Color().setHSL(Math.random(), 1, 0.5), intensity: 6, radius: 6 });
    this.player.teleport(new THREE.Vector3(0, 0, 12), 0);
    this.player.pitch = -0.15;
    const gl = this.renderer.renderer.getContext(); const px = new Uint8Array(4);
    const times: number[] = [];
    for (let i = 0; i < 240; i++) {
      const t0 = performance.now();
      this.advance(1 / 60);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      times.push(performance.now() - t0);
      if (i % 30 === 0) await new Promise(r => setTimeout(r, 0));
    }
    times.sort((a, b) => a - b);
    const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(1);
    const sz = this.renderer.drawSize;
    const res = `BENCH ${sz.x}x${sz.y} ${this.renderer.quality}: p50 ${q(0.5)}ms p95 ${q(0.95)}ms p99 ${q(0.99)}ms · ragdolls ${this.corpses.size} debris ${this.debris.budget.size} lights ${L.lights.length}`;
    this.dev.benchResult = res;
    this.dev.visible = true;
    console.log(res);
    (window as any).__bench = res;
    return res;
  }

  /** Debug/test hook: an ion-grenade-sized blast at p. */
  debugExplode(p: THREE.Vector3, radius = 5, damage = 95, impulse = 34) { explode(this.ctx, p, radius, damage, impulse, 'player', 0xb46bff); }

  /** Debug/test hook: advance the simulation deterministically (independent of rAF) and render once. */
  advance(seconds: number, input?: { keys?: string[]; fire?: boolean; yaw?: number; pitch?: number }) {
    const n = Math.round(seconds * 120);
    if (input?.yaw !== undefined) this.player.yaw = input.yaw;
    if (input?.pitch !== undefined) this.player.pitch = input.pitch;
    for (let i = 0; i < n; i++) {
      // keep the camera (weapon aim) in sync with the player every step
      const eye = this.player.pos.clone(); eye.y += this.player.eyeOffset;
      this.rig.apply(this.renderer.camera, eye, this.player, STEP, h => this.renderer.setHFov(h));
      this.renderer.camera.updateMatrixWorld();
      if (input?.keys) for (const k of input.keys) this.input.down.add(k);
      if (input?.fire) this.input.down.add('Mouse0');
      this.time.update(STEP);
      const scale = (this.mode === 'play' || this.mode === 'dead' || this.mode === 'title') ? this.time.scale : 0;
      this.step(STEP * scale);
      if (i % 2 === 0) { this.particles.update(STEP * 2 * scale, this.renderer.camera); this.decals.update(STEP * 2); }
    }
    if (input?.keys) for (const k of input.keys) this.input.down.delete(k);
    if (input?.fire) this.input.down.delete('Mouse0');
    this.frame(1, 1 / 60);
  }

  /** Register physics callbacks after construction. */
  registerContacts() {
    this.phys.onContactForce(c => {
      const now = this.time.simTime;
      for (const [ha, hb] of [[c.h1, c.h2], [c.h2, c.h1]]) {
        const ca = this.phys.world.getCollider(ha), cb = this.phys.world.getCollider(hb);
        if (!ca || !cb) continue;
        const ba = ca.parent();
        if (!ba) continue;
        const rec = this.kinetic.thrown.get(ba.handle);
        const ownerB = this.phys.ownerOf(hb) as Owner | undefined;
        let v: { x: number; y: number; z: number } = ba.linvel();
        const pre = rec && this.kinetic.preVel.get(ba.handle);
        if (pre && pre.lengthSq() > v.x * v.x + v.y * v.y + v.z * v.z) v = pre; // impact speed, not post-solve speed
        const speed = Math.hypot(v.x, v.y, v.z);
        if (rec && speed > 5) {
          const key = ba.handle * 100000 + hb;
          if ((this.contactCd.get(key) ?? -1) > now) continue;
          this.contactCd.set(key, now + 0.3);
          const target: Android | undefined = ownerB?.android;
          const tp = cb.translation();
          const point = new THREE.Vector3(tp.x, tp.y, tp.z);
          if (target && target !== rec.android && target.state !== 'dead') {
            const dmg = THREE.MathUtils.clamp(0.5 * Math.min(rec.mass, 120) * speed * speed * 0.02, 20, 420);
            target.hit({ point, normal: new THREE.Vector3(0, 1, 0), dir: new THREE.Vector3(v.x, v.y, v.z).normalize(), damage: dmg, impulse: speed * 0.8, source: 'kinetic', weapon: 'kinetic' }, ownerB!.seg);
            if (target.state === 'alive' && !target.isBoss) target.stagger(undefined, undefined, 1.3);
            this.sfx.play('thud', { pos: point, gain: 1.5 });
            if (!(rec as any).slammed) { (rec as any).slammed = true; this.kineticSlam(point, new THREE.Vector3(v.x, v.y, v.z).normalize(), rec.mass, speed, target, rec.android); }
          } else if (ownerB?.kind === 'boss') {
            ownerB.hit?.({ point, normal: new THREE.Vector3(0, 1, 0), dir: new THREE.Vector3(v.x, v.y, v.z).normalize(), damage: THREE.MathUtils.clamp(0.5 * Math.min(rec.mass, 120) * speed * speed * 0.02, 20, 300), impulse: speed * 0.5, source: 'kinetic', weapon: 'kinetic' });
            this.sfx.play('thud', { pos: point, gain: 1.5 }); this.rig.addTrauma(0.15);
          } else if (ownerB?.kind === 'fixture') ownerB.hit?.({ point, normal: new THREE.Vector3(), dir: new THREE.Vector3(), damage: 99, impulse: 0, source: 'kinetic' });
          else if (ownerB?.kind === 'prop' && ownerB.prop !== undefined) ownerB.hit?.({ point, normal: new THREE.Vector3(0, 1, 0), dir: new THREE.Vector3(v.x, v.y, v.z).normalize(), damage: speed * 3, impulse: speed * 0.5, source: 'kinetic' });
          if (rec.android && rec.android.state !== 'dead' && speed > 12) {
            rec.android.hit({ point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), dir: new THREE.Vector3(v.x, v.y, v.z).normalize(), damage: speed * 3.2, impulse: 0, source: 'kinetic', weapon: 'kinetic' }, rec.android.body.root);
          }
          if (this.run.mods.shrapnel && !rec.android?.isBoss && !(rec as any).exploded && speed > 10) {
            (rec as any).exploded = true;
            const bp = ba.translation();
            explode(this.ctx, new THREE.Vector3(bp.x, bp.y, bp.z), 3.5, 45, 16, 'player', 0xffb02e);
          }
          if (this.run.mods.singularity && !(rec as any).vortex && speed > 8) {
            (rec as any).vortex = true;
            const bp = ba.translation();
            this.vortex(new THREE.Vector3(bp.x, bp.y, bp.z));
          }
        } else if (c.magnitude > 400 && this.thudCd <= now) {
          const own = this.phys.ownerOf(ha) as Owner | undefined;
          if (own?.kind === 'android' || own?.kind === 'debris' || own?.kind === 'prop') {
            const t = ca.translation();
            this.thudCd = now + 0.05;
            this.sfx.play(own.kind === 'debris' ? 'impactConcrete' : 'thud', { pos: new THREE.Vector3(t.x, t.y, t.z), gain: Math.min(1.4, c.magnitude / 2500) });
          }
        }
      }
    });
    this.phys.onCollision((h1, h2, started) => {
      if (!started) return;
      for (const [ha, hb] of [[h1, h2], [h2, h1]]) {
        const o = this.phys.ownerOf(ha) as Owner | undefined;
        if (o?.kind !== 'fixture') continue;
        const other = this.phys.world.getCollider(hb)?.parent();
        if (!other || !other.isDynamic()) continue;
        const v = other.linvel();
        if (Math.hypot(v.x, v.y, v.z) > 6) o.hit?.({ point: o.fixture.pos, normal: new THREE.Vector3(), dir: new THREE.Vector3(), damage: 99, impulse: 0, source: 'kinetic' });
      }
    });
  }

  /**
   * A thrown body connecting with an android: the big "that landed" beat. Hit-stop, flash, sparks,
   * and a short-range slam that shoves and staggers anything standing next to the victim.
   */
  private kineticSlam(p: THREE.Vector3, dir: THREE.Vector3, mass: number, speed: number, direct: Android, thrown?: Android) {
    this.time.hitstop(70);
    this.hud.impactFlash();
    this.renderer.caPulse = Math.min(1, this.renderer.caPulse + 0.35);
    this.rig.addTrauma(0.28);
    this.particles.sparksAt(p, dir.clone().negate().setY(0.6).normalize(), 40, 0x9ff6ff, 11, 1.1, 0.6);
    this.particles.glowAt(p, 0x19f0ff, 1.6, 0.14);
    this.renderer.lights.flash(p, 0x19f0ff, 26, 6, 0.18);
    this.sfx.play('impactMetal', { pos: p, gain: 1.8 });
    // collect first, act after (Rapier query rule)
    const near = new Set<Android>();
    for (const col of this.phys.overlapBall(p, 2.6)) {
      const a = (this.phys.ownerOf(col.handle) as Owner | undefined)?.android as Android | undefined;
      if (a && a !== direct && a !== thrown && a.state === 'alive' && !a.isBoss) near.add(a);
    }
    const dmg = THREE.MathUtils.clamp(mass * speed * 0.25, 15, 80);
    for (const a of near) {
      const d = a.center.sub(p).setY(0.4).normalize();
      a.hit({ point: a.center, normal: d.clone().negate(), dir: d, damage: dmg, impulse: speed * 0.5, source: 'kinetic', weapon: 'kinetic' }, a.body.root);
      if (a.state === 'alive') a.stagger(undefined, undefined, 1.1);
    }
  }

  private vortex(p: THREE.Vector3) {
    let t = 0;
    const l = this.renderer.lights.add({ pos: p, color: new THREE.Color(0x8a5cff), intensity: 20, radius: 8, ttl: 1.6 });
    void l;
    this.sfx.play('btIn', { pos: p });
    const tick = () => {
      t += 0.05;
      for (const col of this.phys.overlapBall(p, 7)) {
        const b = col.parent();
        if (b && b.isDynamic()) {
          const bt = b.translation();
          const d = new THREE.Vector3(p.x - bt.x, p.y - bt.y, p.z - bt.z);
          const len = Math.max(0.5, d.length());
          b.applyImpulse(d.normalize().multiplyScalar(b.mass() * 0.9 / len * 3), true);
        }
        const o = this.phys.ownerOf(col.handle) as Owner | undefined;
        if (o?.android?.state === 'alive') o.android.stagger(undefined, undefined, 1.5);
      }
      this.particles.sparksAt(p, new THREE.Vector3(0, 1, 0), 6, 0x8a5cff, 5, 1.5, 0.4);
      if (t < 1.4) this.later(0.05, tick);
      else explode(this.ctx, p, 5, 70, 30, 'player', 0x8a5cff);
    };
    tick();
  }
}
