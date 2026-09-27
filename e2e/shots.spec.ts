import { test } from '@playwright/test';

/** Not a test: stages showcase scenes and writes docs/shots/*.jpg for the README. Run with SHOTS=1. */
test.skip(!process.env.SHOTS, 'set SHOTS=1 to capture screenshots');
test.use({ viewport: { width: 1600, height: 900 } });

const stage = async (page: any, fn: string) => page.evaluate(`(async () => { const g = window.__halogen; window.__noLockPrompt = true;
  const aim = (c, p = g.player) => { const e = p.eye; const dx = c.x - e.x, dy = c.y - e.y, dz = c.z - e.z; p.yaw = Math.atan2(-dx, -dz); p.pitch = Math.atan2(dy, Math.hypot(dx, dz)); };
  ${fn}
  document.querySelectorAll('.splash').forEach(e => e.remove()); })()`);

test('capture', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?seed=42');
  await page.waitForFunction(() => (window as any).__halogen, null, { timeout: 60_000 });
  await page.evaluate(() => (window as any).__halogen.renderer.setQuality('ultra'));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'docs/shots/title.jpg', quality: 85, type: 'jpeg' });

  // combat: grunts mid-fight, one being thrown
  await stage(page, `g.menus.hide(); g.newRun(42); g.advance(3);
    for (const t of ['grunt','charger','skitter','grunt']) g.spawnEnemy(t, g.room.worldSpawn(Math.floor(Math.random()*8)), true);
    g.advance(1.5); const a = g.enemies[0]; const c = a.center; const p = g.player;
    const d = Math.hypot(c.x - p.pos.x, c.z - p.pos.z); p.teleport(new c.constructor(p.pos.x + (c.x - p.pos.x) * (1 - 7 / d), 0, p.pos.z + (c.z - p.pos.z) * (1 - 7 / d)));
    g.advance(0.2); aim(c); g.advance(0.02, { fire: true }); g.advance(0.25, { fire: true }); aim(c); g.advance(0.05, { fire: true });`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'docs/shots/combat.jpg', quality: 85, type: 'jpeg' });

  // ragdolls + explosion
  await stage(page, `const b = g.room.props.find(p => p.spec.kind === 'barrel' && !p.dead);
    for (const e of g.enemies) if (e.alive && b) { e.body.position.set(b.position.x + (Math.random()-0.5)*3, 0, b.position.z + (Math.random()-0.5)*3); }
    g.advance(0.3); if (b) { const bp = b.position; g.player.teleport(new bp.constructor(bp.x + 6, 0, bp.z + 6)); g.advance(0.1); aim(bp.clone().setY(1.2)); b.destroy(); g.advance(0.2); }`);
  await page.waitForTimeout(300);
  // (explosion framing is layout-dependent; not used in the README)

  for (const [sector, name] of [[1, 'switchboard'], [2, 'filament']] as const) {
    await stage(page, `g.run.hp = 999; g.run.sector = ${sector}; g.enterNode(g.maps[${sector}].nodes.find(n => n.type === 'boss')); g.advance(3.5);
      const b = g.boss; const bp = b.pos ?? b.a.center; g.player.teleport(new bp.constructor(3, 0, 14)); g.advance(0.3); aim(bp.clone().setY(bp.y - 1)); g.advance(0.02);`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `docs/shots/${name}.jpg`, quality: 85, type: 'jpeg' });
  }
  // foreman
  await stage(page, `g.run.sector = 0; g.enterNode(g.maps[0].nodes.find(n => n.type === 'boss')); g.advance(2.5);
    const a = g.boss.a; const c = a.position.clone(); g.player.teleport(new c.constructor(c.x + 2, 0, c.z + 12)); g.advance(0.3); aim(a.center.clone().setY(a.center.y + 1)); g.advance(0.02);`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'docs/shots/foreman.jpg', quality: 85, type: 'jpeg' });

  // cards
  await stage(page, `g.enterNode(g.maps[0].nodes[0]); g.advance(0.5); g.rewardPick('rare');`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'docs/shots/cards.jpg', quality: 85, type: 'jpeg' });

  // dev overlay
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(800);
  await stage(page, `g.dev.visible = true; g.dev.el.style.display = ''; g.dev.physics = true; g.dev.lines.visible = true; g.dev.ai = true; g.advance(2); for (const t of ['grunt','grunt','skitter']) g.spawnEnemy(t, g.room.worldSpawn(Math.floor(Math.random()*8)), false); g.advance(1); const e = g.enemies[0]; if (e) aim(e.center); g.advance(0.02); g.dev.update(0.016);`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'docs/shots/devoverlay.jpg', quality: 85, type: 'jpeg' });
});
