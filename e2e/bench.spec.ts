import { test } from '@playwright/test';

/** Worst-case perf harness (spec: 40 ragdolls, 200 debris, 128 lights). Run with BENCH=1. */
test.skip(!process.env.BENCH, 'set BENCH=1 to run the benchmark');
for (const [w, h] of [[1280, 720], [1920, 1080]] as const) {
  test(`bench ${w}x${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/?bench');
    await page.waitForFunction(() => (window as any).__bench, null, { timeout: 90_000 });
    console.log(await page.evaluate(() => (window as any).__bench));
  });
}
