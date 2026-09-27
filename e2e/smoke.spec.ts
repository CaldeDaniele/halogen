import { test, expect } from '@playwright/test';

/**
 * Boots the game with a fixed seed, runs a scripted bot for 10 s of simulation
 * (aim at nearest android, fire, strafe, dash), then uses an auto-kill cheat until the
 * room clears. Fails on any console error or uncaught exception.
 */
test('boot, fight, clear a room without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error' && !/pointer lock|PointerLock|WrongDocument/i.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('/?seed=1234');
  await page.waitForFunction(() => (window as any).__halogen, null, { timeout: 60_000 });

  const result = await page.evaluate(async () => {
    const g = (window as any).__halogen;
    (window as any).__noLockPrompt = true;
    g.renderer.setQuality('low');
    g.menus.hide();
    g.newRun(1234);
    let cleared = false;
    let hits = 0;
    g.events.on('enemyHit', (e: any) => { if (e.hit.source === 'player') hits++; });
    g.events.on('roomCleared', () => { cleared = true; });
    const aimAt = (c: any) => { const p = g.player, e = p.eye; const dx = c.x - e.x, dy = c.y - e.y, dz = c.z - e.z; p.yaw = Math.atan2(-dx, -dz); p.pitch = Math.atan2(dy, Math.hypot(dx, dz)); };
    const frames: number[] = [];
    let shots = 0;
    for (let i = 0; i < 100; i++) { // 10 s of play in 0.1 s chunks
      const eye = g.player.eye;
      const visible = (e: any) => { const c = e.center; const d = c.clone().sub(eye); const len = d.length(); d.divideScalar(len); return !g.phys.ray(eye.x, eye.y, eye.z, d.x, d.y, d.z, len - 0.6, (0xffff << 16) | 1); };
      const alive = g.enemies.filter((e: any) => e.alive && visible(e));
      const target = alive.sort((a: any, b: any) => a.center.distanceTo(g.player.pos) - b.center.distanceTo(g.player.pos))[0];
      if (target) aimAt(target.center);
      const keys = [i % 20 < 10 ? 'KeyA' : 'KeyD', 'KeyW'];
      if (i % 25 === 0) { g.input.pressedQ.add('ShiftLeft'); }
      g.run.hp = g.run.maxHp; // god mode: this test is about systems, not bot skill
      const t0 = performance.now();
      g.advance(0.1, { keys, fire: !!target });
      frames.push(performance.now() - t0);
      if (target) shots++;
    }
    const kills = g.run.kills;
    // cheat: kill everything until the director runs dry
    for (let i = 0; i < 120 && !cleared; i++) {
      for (const e of [...g.enemies]) if (e.alive) e.hit({ point: e.center, normal: e.center.clone(), dir: e.center.clone().set(0, 0.3, 1).normalize(), damage: 9999, impulse: 8, source: 'player', weapon: 'arc' }, e.body.root);
      g.advance(0.25);
    }
    frames.sort((a, b) => a - b);
    return { cleared, kills, hits, shots, mode: g.mode, p50: frames[50], hp: g.run.hp };
  });
  console.log('smoke', JSON.stringify(result));
  expect(errors, errors.join('\n')).toEqual([]);
  expect(result.cleared).toBe(true);
  expect(result.shots).toBeGreaterThan(0);
  expect(result.hits, 'scripted bot should land hits in 10 s').toBeGreaterThan(5);
  // 0.1 s of sim (12 steps) + 1 render at Low should stay well under 250 ms even on software GL
  expect(result.p50).toBeLessThan(250);
});

test('title screen renders and settings persist', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.t-logo', { timeout: 60_000 });
  await page.getByText('SETTINGS').click();
  await page.locator('.seg button[data-q="medium"]').click();
  await page.reload();
  await page.waitForFunction(() => (window as any).__halogen);
  const q = await page.evaluate(() => (window as any).__halogen.renderer.quality);
  expect(q).toBe('medium');
});

test('pausing right after a clear does not softlock; room never clears with enemies alive', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('/?seed=77');
  await page.waitForFunction(() => (window as any).__halogen, null, { timeout: 60_000 });
  const r = await page.evaluate(async () => {
    const g = (window as any).__halogen;
    (window as any).__noLockPrompt = true;
    g.renderer.setQuality('low'); g.menus.hide(); g.newRun(77);
    let aliveAtClear = -1;
    g.events.on('roomCleared', () => { aliveAtClear = g.enemies.filter((e: any) => e.alive).length; });
    const killAll = () => { for (const e of [...g.enemies]) if (e.alive) e.hit({ point: e.center, normal: e.center.clone(), dir: e.center.clone().set(0, 0.3, 1).normalize(), damage: 9999, impulse: 8, source: 'player', weapon: 'arc' }, e.body.root); };
    for (let i = 0; i < 200 && !g.room.cleared; i++) { g.run.hp = g.run.maxHp; killAll(); g.advance(0.1); }
    g.pause(true);                                   // pause inside the reward delay
    await new Promise(res => setTimeout(res, 1500)); // real time passes while paused
    g.pause(false);
    g.advance(1.5);                                  // sim time resumes → reward shows
    await new Promise(res => setTimeout(res, 300));
    const cards = !!document.querySelector('.cardpick');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
    await new Promise(res => setTimeout(res, 900));
    g.advance(1);
    return { aliveAtClear, cards, doorsOpen: g.room.doors.every((d: any) => d.target === 1), mode: g.mode };
  });
  expect(errors).toEqual([]);
  expect(r.aliveAtClear).toBe(0);
  expect(r.cards).toBe(true);
  expect(r.doorsOpen).toBe(true);
});

test('explosions kill androids, push bodies and chain barrels', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('/?seed=5');
  await page.waitForFunction(() => (window as any).__halogen, null, { timeout: 60_000 });
  const r = await page.evaluate(() => {
    const g = (window as any).__halogen;
    (window as any).__noLockPrompt = true;
    g.renderer.setQuality('low'); g.menus.hide(); g.newRun(5); g.director = null; g.advance(0.2);
    const V = g.player.pos.constructor;
    for (const e of [...g.enemies]) g.disposeAndroid(e);
    g.enemies = [];
    [0, 1, 2].forEach(i => g.spawnEnemy('grunt', new V(i * 1.2 - 1.2, 0, -4), false));
    const crate = g.room.props.find((p: any) => p.spec.kind === 'crate' && !p.dead);
    crate?.body.setTranslation({ x: 2.2, y: 0.6, z: -4 }, true);
    g.advance(0.3);
    const c0 = crate?.position.clone();
    const kills0 = g.run.kills;
    g.debugExplode(new V(0, 0.8, -4));
    g.advance(0.6);
    const moved = crate && !crate.dead ? crate.position.distanceTo(c0) : 99;
    return { kills: g.run.kills - kills0, corpses: g.corpses.size, alive: g.enemies.filter((a: any) => a.alive).length, moved };
  });
  expect(errors).toEqual([]);
  expect(r.kills).toBe(3);
  expect(r.alive).toBe(0);
  expect(r.corpses).toBe(3);
  expect(r.moved).toBeGreaterThan(1);
});

test('walking through a door while holding a severed limb does not wedge the world', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('/?seed=8');
  await page.waitForFunction(() => (window as any).__halogen, null, { timeout: 60_000 });
  const r = await page.evaluate(async () => {
    const g = (window as any).__halogen;
    (window as any).__noLockPrompt = true;
    g.renderer.setQuality('low'); g.menus.hide(); g.newRun(8); g.advance(0.2);
    const V = g.player.pos.constructor;
    const a = g.spawnEnemy('grunt', new V(0, 0, -3), false);
    g.advance(0.2);
    a.die({ point: a.center, normal: new V(0, 1, 0), dir: new V(0, 0.5, -1).normalize(), damage: 999, impulse: 5, source: 'player' });
    const arm = a.body.seg('uarmR'); a.severSeg(arm);
    g.kinetic.held.push({ body: arm.body, mass: 3, prevGroups: [], offset: 0 });
    // clear the room by cheat, pick a card, walk into the first door
    for (let i = 0; i < 200 && !g.room.cleared; i++) { g.run.hp = g.run.maxHp; for (const e of [...g.enemies]) if (e.alive) e.hit({ point: e.center, normal: e.center.clone(), dir: new V(0, 0.3, 1), damage: 9999, impulse: 8, source: 'player', weapon: 'arc' }, e.body.root); g.advance(0.1); }
    for (let i = 0; i < 40 && !document.querySelector('.cardpick'); i++) g.advance(0.25); // sim time (bullet-time may be active)
    await new Promise(res => setTimeout(res, 300));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
    await new Promise(res => setTimeout(res, 900));
    g.advance(1.5);
    g.kinetic.held.push({ body: arm.body, mass: 3, prevGroups: [], offset: 0 }); // still holding at the door
    const node0 = g.node.id;
    const d = g.room.doors[0];
    g.player.teleport(d.world.clone().setZ(d.world.z + 3), 0);
    g.advance(0.1); g.advance(0.7, { keys: ['KeyW'] });
    await new Promise(res => setTimeout(res, 800));
    g.advance(0.5);
    return { moved: g.node.id !== node0, mode: g.mode, held: g.kinetic.held.length };
  });
  expect(errors).toEqual([]);
  expect(r.moved).toBe(true);
  expect(r.mode).toBe('play');
  expect(r.held).toBe(0);
});
