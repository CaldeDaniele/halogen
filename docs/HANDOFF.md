# HALOGEN — Handoff & Roadmap (round 2)

You are picking up **HALOGEN**, a browser roguelike FPS built as a résumé showreel ("show what an
incredible game designer and developer you are"). Round 1 (milestones M0–M6) is complete and
playable end to end. This document gives you the context, the rules of the codebase, and a
prioritized backlog. Read it fully before changing code.

- Design spec (binding): [`docs/superpowers/specs/2026-09-27-halogen-design.md`](superpowers/specs/2026-09-27-halogen-design.md)
- Round-1 plan (history): [`docs/superpowers/plans/2026-09-27-halogen.md`](superpowers/plans/2026-09-27-halogen.md)
- Public-facing overview: [`README.md`](../README.md)
- Branch: `halogen` (base `main`, not merged). Remote `origin` = <https://github.com/CaldeDaniele/halogen> (public, default branch `halogen`)
- Live build: <https://caldedaniele.github.io/halogen/>. `.github/workflows/pages.yml` runs unit tests + build and deploys on every push to `halogen`.
  Pushing workflow files needs the `workflow` scope: the machine's stored git PAT lacks it, so push with
  `git -c credential.helper= -c "credential.helper=!gh auth git-credential" push origin HEAD:halogen` (gh's token has it).

---

## 1. State of play

**Works today:** 3 sectors × branching 6-layer route, 7 room types, 5 android enemy types, 3 bosses
(Foreman / Switchboard / Filament), 4 weapons, kinetic hand, light-as-resource, bullet-time, 45 cards +
6 meta unlocks, procedural SFX, generated music/art, menus/settings (quality, FOV, sensitivity, volumes,
FPS cap), dev overlay (F1–F4), `?seed=` and `?bench`.

**Quality gates (all green at handoff):**
- `npm test` → 131 unit tests (vitest)
- `npm run test:e2e` → 9 Playwright tests (system Edge channel, no browser download)
- `npx tsc --noEmit` clean, `npm run build` OK

**Measured performance:** typical combat Ultra 1600×900 ≈ 127 fps (headless Edge, GPU); worst case
`?bench` (40 ragdolls, 200 debris, 128 lights) p50 16.4 ms at 1080p — **CPU-bound** (draw calls + physics).

**Playtest status (round 2):** owner feedback was: hit feedback "strange, almost nonexistent", Skitters
hard to hit, kinetic hand not impactful, overall too hard. Round 2 shipped a first pass for all four
(see README "Difficulty curve" / "Game feel"): damage numbers + HP bars (toggle in Settings), layered hit
SFX, bigger popping hitmarker, stronger flinch/knockback/punch, micro hit-stop on scatter/rail, Skitter
sensor hurtbox (`EnemyStats.hurtbox`) + slower + longer tells, kinetic yank/aim-assist/impact slam,
enemy damage −20–30%, director budget `10 + 2·depth + 7·sector`. **Awaiting the owner's re-playtest** before
further tuning.

---

## 2. Run it

```bash
npm install
npm run dev                  # http://localhost:5173 (vite.config.ts pins 5173, strictPort)
npm test                     # unit
npm run test:e2e             # e2e (spawns vite on 5175)
BENCH=1 npx playwright test e2e/bench.spec.ts   # perf numbers
SHOTS=1 npx playwright test e2e/shots.spec.ts   # regenerates docs/shots/*.jpg for the README
```

Pointer lock is required to play; embedded/preview browsers usually can't grant it. For automated or
agent-driven testing use the deterministic harness (§4.3) instead of real input.

---

## 3. Architecture map

~8k lines of TypeScript. Plain ECS-ish objects, no framework. Systems talk through a typed event bus.

| Area | Files | Notes |
|---|---|---|
| Core | `src/core/{loop,time,rng,events,input,budget}.ts` | fixed 120 Hz sim, interpolated render, `FrameLimiter` (FPS cap), timescale (slowmo/hitstop), seeded `Rng` with `fork(label)`, FIFO `Budget` |
| Orchestrator | `src/game/game.ts` | modes `title/play/cards/transition/dead/paused/victory`, room lifecycle, event wiring, contact-force damage, debug hooks. Biggest file; split if you add much |
| Shared types | `src/game/types.ts` | `Ctx` (services bag passed to every system), `HitInfo`, `Owner`, `GameEvents` |
| Combat | `src/game/combat.ts`, `src/game/bolts.ts`, `src/game/pickups.ts` | hit routing via collider owners, `surfaceImpact`, `explode`, enemy projectiles |
| Player | `src/game/player/{controller,camera,weapons,kinetic}.ts` | Rapier KCC movement kit; camera juice springs; 4 weapons + procedural viewmodels; kinetic hand |
| Enemies | `src/game/enemies/{defs,android,ai,director,bosses}.ts` | data-driven bodies; `Android` = articulated body + procedural IK anim + damage model; utility AI; wave director; 3 bosses |
| Physics | `src/physics/{world,ragdoll,fracture}.ts` | `PhysicsWorld` wrapper (groups, owners, `overlapBall`, `bodyAlive`), `ArticulatedBody` (kinematic FK ↔ dynamic ragdoll, sever), box fracture |
| Level | `src/game/level/{generator,builder,fixtures,props,navgrid,runmap}.ts` | pure seeded layout → built room; breakable light fixtures; props/debris; A*; sector route graph |
| Run | `src/game/run/{state,cards}.ts` | `RunState` + `Mods`; card defs, synergy-weighted offers, unlocks |
| Render | `src/render/{renderer,lights,clustered,volumetric,ssr,materials,particles,decals,envmap}.ts` | post stack (N8AO, wet-floor SSR, volumetric, bloom, AgX…), clustered lights injected via `onBeforeCompile`, quality tiers + auto governor |
| Audio | `src/audio/{synth,music}.ts` | layered WebAudio recipes; music director (ambient/combat crossfade, boss singles, stings) |
| UI | `src/ui/{hud,cards,menus,devoverlay}.ts`, `style.css` | DOM over canvas; settings + meta persisted in `localStorage` (keys `halogen.settings.v1`, `halogen.meta.v1`) |
| Assets | `public/assets/**`, `tools/{gen-assets,texproc}.mjs`, `tools/asset-manifest.json` | generated via OpenRouter (see §6) |

---

## 4. Rules of this codebase (read before editing)

### 4.1 Rapier gotchas — each of these caused a real bug in round 1

1. **Never mutate bodies/colliders inside a Rapier query callback** (`intersectionsWithShape` etc.).
   The call throws and Rapier *silently swallows it*. Use `phys.overlapBall(pos, r)` (collect first,
   act after). Covered by `tests/physics.test.ts`.
2. **Never touch a removed body.** Any call on it traps the WASM (`RuntimeError: unreachable`) and
   every later `world.step()` fails — the game freezes permanently. Before removing a body that the
   kinetic hand could hold, call `ctx.game.kinetic.forgetBody(body)`; check `phys.bodyAlive(b)` when in
   doubt. `KineticHand.prune()` is the safety net, not an excuse.
3. Collision groups are `groups(member, filter)` from `src/physics/world.ts` (`G.*` bits). Live android
   segments = `ENEMY`, ragdolls = `RAGDOLL`, shades in darkness become `TRIGGER` (bullets pass).
4. Hitboxes are intentionally larger than visuals (capsule radius ×1.35, boxes ×1.1 in `ragdoll.ts`).
5. Contact-force events fire **after** the solve: a body that hit a kinematic android already reads ~0
   velocity. Impact speed of thrown bodies comes from `KineticHand.preVel` (recorded before `phys.step`).
6. Ray casts and shape queries include **sensors** unless `QueryFilterFlags.EXCLUDE_SENSORS` is passed.
   The Skitter hurtbox (`ArticulatedBody.addHurtbox`) relies on this; both KCCs pass the flag so it never
   blocks movement. Hitscan pierce is counted per android, so a hurtbox + segment can't double-hit.

### 4.2 Game-flow rules

- Delays that belong to gameplay use **sim time**: `ctx.game.later(seconds, fn)` (paused with the game,
  cleared on room change). Never `setTimeout` for gameplay — a real-time timeout caused a softlock.
- A room clears only when `director.done && alive === 0 && !waveSpawnedThisStep` (see `Game.step`).
- Real `Android` bosses go into the corpse `Budget` when they die; pseudo-boss "enemies" emitted by
  Switchboard/Filament are plain objects flagged `isBoss: true` — guard with `enemy instanceof Android`.
- The sim runs only in `play` **with pointer lock** (or when `window.__noLockPrompt = true` for tests).
- Explosion impulse is mass-proportional (≤60 kg × 0.22) — tune there, not per call site.

### 4.3 Deterministic test harness (use this, not real input)

In the browser console / Playwright `page.evaluate`, the game is `window.__halogen` (`g`):
- `window.__noLockPrompt = true` — allow sim without pointer lock.
- `g.menus.hide(); g.newRun(seed)` — start a run. `g.enterNode(g.maps[s].nodes.find(n => n.type === 'boss'))` jumps to a boss.
- `g.advance(seconds, { keys: ['KeyW'], fire: true, yaw, pitch })` — steps the sim at 120 Hz with the
  camera synced every step, then renders one frame. Works even when the tab is hidden/throttled.
- `g.debugExplode(pos)`, `g.bench()`, `g.frameCount`, `g.dev` (overlay state).
- Note: kills fill Focus → bullet-time slows sim time; loop `advance` until a condition, don't assume
  fixed durations (see e2e `softlock` test).

### 4.4 Engineering conventions

- TypeScript strict; match surrounding style (comment density: short "why" comments, no noise).
- **TDD**: write the failing test first, watch it fail, then fix. Pure logic → vitest in `tests/`;
  flows/regressions → Playwright in `e2e/smoke.spec.ts`. Keep both suites green before every commit.
- Commit per coherent change; message body ends with the attribution line the repo already uses.
- Don't add runtime network calls (the build must work offline/static).
- Every new asset needs a procedural fallback (see `tex()` in `materials.ts`, drone fallback in `music.ts`).

---

## 5. Backlog (prioritized)

Legend: **P1** do first · **P2** next · **P3** nice to have. Each item lists where to look and what
"done" means. Items marked *(spec gap)* are things the design spec promised that round 1 didn't deliver.

### A — Spec gaps

| ID | Pri | Item | Where | Done when |
|---|---|---|---|---|
| A1 | P1 | *(spec gap)* **Colorblind-safe telegraph palette** setting | `menus.ts` (Settings), `ENEMIES[*].attackColor` in `defs.ts`, `android.ts` flare, `bosses.ts` telegraphs | Settings toggle (Default / Deuteranopia / Protanopia / Tritanopia); all attack tells + HUD damage colors remap; persisted; e2e checks toggle persists |
| A2 | P1 | *(spec gap)* **Temporal accumulation for volumetrics** (currently half-res + 5-tap blur → visible noise) | `src/render/volumetric.ts` | history buffer with reprojection via previous view-proj matrix, neighborhood clamp to avoid ghosting; noise visibly reduced in `docs/shots`; no ghost trails on fast camera turns; bench not worse than +1 ms |
| A3 | P2 | *(spec gap)* **Active-ragdoll hit reactions with joint motors** (now: kinematic flinch springs; heavy hits → full ragdoll + blend recovery) | `src/physics/ragdoll.ts`, `android.ts` `hit`/`stagger` | medium hits make the struck limb chain go dynamic with motors pulling back to pose (Rapier revolute `configureMotorPosition`; spherical joints need a workaround), android stays standing; light hits keep springs; no jitter/explosions (see Unity-style ragdoll pitfalls) |
| A4 | P2 | *(spec gap)* **Real 3D LUT per sector** (now Hue/Sat + Brightness/Contrast) | `renderer.ts` post stack (`LUT3DEffect` from postprocessing) | 3 authored LUTs (generate procedurally or bake from a grading pass), switched in `Game.applySector` |
| A5 | P3 | *(spec gap)* GPU particles / depth-buffer spark collision (now CPU sim, instanced; floor-plane bounce only) | `src/render/particles.ts` | sparks bounce off walls/props using the depth buffer or ray samples; ≥3000 particles without CPU cost regression |
| A6 | P3 | *(spec gap)* Voronoi fracture (now recursive box split) | `src/physics/fracture.ts` (+ convex hull colliders) | shards with irregular silhouettes; determinism + volume tests still pass |
| A7 | P3 | *(spec gap)* Music stems in sync (ambient/combat are separate Lyria tracks, not key/BPM-locked) | `src/audio/music.ts`, `tools/asset-manifest.json` | either regenerate matched stems or crossfade on bar boundaries; no audible clash |

### B — Gameplay & feel

| ID | Pri | Item | Where | Done when |
|---|---|---|---|---|
| B1 | P1 | ~~Balance pass from playtest~~ **first pass done (round 2)**; re-tune after the owner's next playtest | `defs.ts` (hp/dmg/fireRate), `director.ts` (budgets), `bosses.ts` (hp/timers), `cards.ts` (weights) | owner confirms; add a "difficulty curve" note in README. Known data point: a standing player dies in ~5 s to 9 mixed enemies |
| B2 | P2 | **Onboarding room** (kinetic hand + light-as-resource + dash) before sector 1 | `runmap.ts` (layer −1 node), `generator.ts` new `tutorial` type, HUD prompts | first-run only (meta flag), skippable, teaches RMB grab/throw, shooting a light for Lumen, Shade in darkness |
| B3 | P2 | **Elite affixes** (e.g. *Shielded*, *Volatile*, *Blinking*, *Magnetic*) | `android.ts`, `director.ts`, `ai.ts` | elites appear from room depth ≥3, visible affix tell (emissive pattern + HUD tag), unit tests for affix assignment determinism |
| B4 | P2 | **More room modules / layout variety** (catwalks, two-level arenas, destructible walls) | `generator.ts`, `builder.ts` | reachability tests still cover every new type; 40-seed test extended |
| B5 | P3 | Gamepad support (spec stretch goal) | `src/core/input.ts` (Gamepad API), aim assist in `weapons.ts` | full playthrough possible on a pad; menus navigable |
| B6 | P3 | Daily seeded run + local leaderboard (runtime must stay offline → local only, or add an opt-in backend later) | `menus.ts`, `RunState` | same seed for everyone on a date; best scores per date stored locally |
| B7 | P3 | More weapons (e.g. arc-beam, sawblade launcher) + weapon mods UI | `weapons.ts`, `cards.ts`, `tools/asset-manifest.json` for card art | each weapon has viewmodel, SFX recipe, card, and at least one synergy |

### C — Tech debt (from the round-1 final review, deferred as minor)

| ID | Pri | Item | Where | Done when |
|---|---|---|---|---|
| C1 | P1 | **CPU draw-call cost** in heavy scenes (≈1,300 meshes with 40 ragdolls) | `android.ts` visuals, `props.ts` debris, `particles.ts` | instanced/merged meshes for android parts + debris; `?bench` 1080p p50 ≤ 12 ms (from 16.4) |
| C2 | P2 | GPU resources not disposed on room change: door-label `CanvasTexture`/`SpriteMaterial`, boss `LineStrike`/`Shockwave` materials+geometries | `game.ts` `labelDoors`/`clearRoom`, `bosses.ts` | a test/bench that cycles 20 rooms shows flat `renderer.info.memory` |
| C3 | P2 | `contactCd` map never cleared; fixed pin bodies outlive evicted corpses until room clear | `game.ts` (`registerContacts`, `pinsUpdate`) | map pruned by time; pins removed with their corpse (hook in `corpses` eviction) |
| C4 | P3 | Shared module geometries (`barrelGeo`, `bandGeo`, `tubeGeo`, `housingGeo`) disposed and re-uploaded every room by `Room.dispose` traversal | `builder.ts` `dispose`, `props.ts`, `fixtures.ts` | shared geometries excluded from disposal |
| C5 | P3 | Cluster index texture is 33×3456 — exceeds WebGL2's guaranteed 2048 `MAX_TEXTURE_SIZE` (fine on desktop GPUs) | `src/render/lights.ts` | repack into ≤2048-tall layout (wrap rows) + shader lookup update; `tests/clustered.test.ts` extended |
| C6 | P3 | `game.ts` is large (orchestrator + event wiring + contacts + debug hooks) | `src/game/game.ts` | extract `contacts.ts`, `flow.ts` (room lifecycle), `debug.ts` without behavior change; suites green |

### D — Showreel & distribution

| ID | Pri | Item | Where | Done when |
|---|---|---|---|---|
| D1 | P1 | ~~Public deploy~~ **done**: <https://caldedaniele.github.io/halogen/> (GitHub Pages via Actions) | needs a git remote — **ask the owner** which host/account; `vite.config.ts` already uses `base: './'` | live URL loads, music lazy-loads, `?seed=` links work; URL added to README |
| D2 | P1 | **Trailer (30–60 s)** | a video-generation tool (Motion) may be available in the owner's session; otherwise capture via Playwright + ffmpeg (`C:\ffmpeg\bin\ffmpeg` exists on the owner's machine) | trailer showing: dash → kinetic yank → ragdoll through a light → bullet-time → boss; linked in README |
| D3 | P2 | GIFs in README (spec asked for GIFs, round 1 has stills) | `e2e/shots.spec.ts` (extend to record frames) + ffmpeg | 3–4 short loops: kinetic throw, light break → Shade reveal, Filament tendril tear, dev overlay |
| D4 | P3 | itch.io page (HTML5 upload of `dist/`) | `npm run build` | page live with screenshots + controls |

### Suggested order for round 2
1. **B1** (ask owner for playtest notes) in parallel with **D1** (ask for hosting choice) — both need owner input, start by asking.
2. **A1** colorblind palette, **C1** draw calls, **A2** temporal volumetrics.
3. **D2** trailer + **D3** GIFs once visuals are final.
4. Then A3 / B2 / B3 / B4, then P3 items.

---

## 6. Assets & external services

- Generated with OpenRouter in round 1 (Gemini 3.1 Flash Image / Gemini 3 Pro Image / Lyria 3), total
  spend **$4.16**, logged in `tools/spend-log.json`. `tools/gen-assets.mjs` is idempotent and hard-stops
  at a budget; it reads `OPENROUTER_API_KEY` from **`.env.local` (gitignored)**.
- **The round-1 key expired / should be revoked.** Do not reuse it and never commit a key. If new assets
  are needed, ask the owner for a fresh key and a budget, then put it only in `.env.local`.
- Content filter note: the `tex/carbon` prompt was refused twice by Google's filter — carbon is procedural.
- Card art prompts must say "full-bleed black background, no border" (two early cards came back framed).
- Music is ~21 MB total, lazy-loaded per sector; keep new tracks ≤150 s, 112 kbps (see `doMusic`).

---

## 7. Decisions already made (don't relitigate without the owner)

- Web (Three.js + Rapier) over Unity; neon brutalist look; room chain + cards; all four signature
  mechanics (kinetic hand, bullet-time, light as resource, destructible cover); procedural segmented androids.
- Rooms connect via door + fade transition, not walkable corridors.
- Bosses: Foreman (limb phases), Switchboard (pylon shield), Filament (physical tendrils, tearable).
- Meta-progression = unlocks only (6 cards), no stat grind.
- FPS cap defaults to VSYNC; auto-quality governor on by default and ignores cap-imposed frame time.
- Tools are `.mjs` (no TS runner); e2e uses the system Edge channel (`PW_CHANNEL` env to override).
