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
