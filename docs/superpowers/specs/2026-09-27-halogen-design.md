# HALOGEN — Design Spec

**Date:** 2026-09-27
**Status:** Approved in conversation, pending written-spec review
**Purpose:** Browser-playable roguelike FPS that serves as a résumé showreel for game design + engineering. Success = within 30 seconds a player dashes, yanks an android into a neon tube, watches it ragdoll through shattering concrete in slow-mo, and asks "this runs in a browser?"

## 0. Constraints & assumptions

- Platform: web, desktop only (keyboard + mouse), Chrome/Edge/Firefox, WebGL2 + WASM.
- Performance target: 60 fps on mid-range GPU (GTX 1660 / Apple M1 class) at "High"; quality tiers Low/Med/High/Ultra.
- Run length: ~15–20 min. 3 sectors × (4 combat rooms + 1 elite/shop/event room + 1 boss).
- Delivery: static build (`dist/`), deployable to GitHub Pages / Netlify. No runtime network calls.
- Asset budget: $10 OpenRouter credit, key expires ~24h from 2026-09-27 → asset generation runs first. Key stored only in `.env.local` (gitignored). Hard stop at $9 spend.
- Stack: TypeScript (strict), Vite, Three.js (WebGL2), `@dimforge/rapier3d-compat`, `postprocessing` (pmndrs), `n8ao`, Vitest, Playwright.

## 1. Game design

**Fiction:** Salvage unit dropped into *The Stack*, a dead brutalist arcology overrun by rogue androids. The grid feeds on light — so do you.

**Pillars**
1. Momentum is armor — fast movement, forgiving air control, standing still is death.
2. Physics is a weapon — every android, crate, slab, and limb is a projectile.
3. Light is contested — light reveals enemies and powers you, and you can destroy it.

**Movement kit:** sprint (default run), slide (preserves speed, accelerates on slopes), dash (2 charges, recharge), double jump, wall-kick, bhop-lite air strafing, coyote time, jump buffering.

**Weapons** (carry 2; swap via room rewards)
| Weapon | Behavior |
|---|---|
| Arc Pistol | Hitscan, fast fire, headshot ×2.5 |
| Scattergun | Close range, heavy knockback launching ragdolls |
| Rail Lance | Charge shot, pierces, pins ragdolls to walls |
| Ion Launcher | Arcing grenade, radial impulse + dynamic light flash |

**Kinetic hand** (RMB hold = grab, release = launch): grabs androids (alive → staggered into ragdoll), props, debris chunks, severed limbs. Costs **Lumen**. Lumen regenerates while standing in lit zones; shattering a light fixture gives an instant Lumen burst but darkens that zone. Thrown objects deal impact damage from kinetic energy.

**Light as resource:** rooms contain breakable neon fixtures (tube, panel, spot). Enemies interact:
- **Shade** — invisible and unhittable outside light.
- **Lamplighter** — drone that repairs broken fixtures and shields allies.

**Bullet-time:** headshot kill, 3+ multikill, or kinetic-throw kill fills Focus. Full Focus → automatic 1.2 s slow-mo at 20% timescale with desaturation + chromatic pulse. Cards can modify triggers/duration.

**Enemies**
| Enemy | Body | Role |
|---|---|---|
| Grunt | Biped | Rifle, strafes, uses cover |
| Charger | Heavy biped | Rushes; armor plates can be shot off |
| Skitter | Quadruped | Swarm, leap attack |
| Shade | Biped (thin) | Stealth, visible only in light |
| Lamplighter | Drone | Support: repair lights, shield allies |

**Bosses**
- *Foreman* (Sector 1) — huge biped; detachable limbs define phases.
- *Switchboard* (Sector 2) — room-wide light-puzzle fight; its vulnerability depends on which grid zones are lit.
- *The Filament* (Sector 3, final) — core with tendrils of light; tendrils are light sources that can be severed.

**Run structure:** branching run map per sector (simplified Slay-the-Spire graph, reward icon shown per node). Room types: arena, gauntlet corridor, vertical shaft, dark room, elite, shop, event. Doors lock during combat.

**Upgrade cards:** after each clear pick 1 of 3. ~40 cards with rarity (common/rare/legendary) and synergy tags (`weapon`, `kinetic`, `movement`, `light`, `focus`). Examples: ricochet rounds, chain lightning, explosive ragdolls, multi-grab, magnetic vortex, dash light-trail that damages, "thrown bodies become light sources".

**Meta-progression:** unlocks only (new cards/weapons enter the pool). No stat grind.

**Scoring:** style meter (variety-based), end-of-run stats, seedable runs (`?seed=`).

## 2. Engine architecture

**Main loop:** fixed-step simulation at 120 Hz with accumulator; rendering interpolated at display rate. Bullet-time scales simulation dt, not render or mouse look. Camera look applied at render rate from raw mouse deltas.

**Structure:** lightweight ECS-style — entities are plain objects with components; systems iterate typed pools. No external ECS framework.

```
src/
  core/        loop, time (timescale tweens), input, events (typed bus), rng (seeded), pool
  render/      renderer, postfx pipeline, clustered lights, materials, decals, gpu particles
  physics/     world, ragdoll builder, fracture, queries, collision groups
  audio/       synth engine, sfx recipes, spatial/reverb, music director
  game/
    player/    controller (movement kit), camera (juice), weapons, kinetic hand
    enemies/   body builder, locomotion (IK), AI (utility + FSM), types/
    level/     room generator, modules, props, light fixtures, run graph, navgrid
    run/       cards, pools, synergies, meta unlocks, scoring
  ui/          HUD, card picker, menus, run map, dev overlay (F1)
  assets/      generated textures, music, card art, manifest
tools/         OpenRouter asset generation (Node/TS), texture post-processing
tests/         vitest unit tests, playwright smoke
```

**Key interfaces**
- `Time`: `dt`, `scaledDt`, `timescale`, `time.slowmo(scale, duration)`, `time.hitstop(ms)`.
- `Events`: typed bus — `enemyKilled`, `enemyHit`, `lightBroken`, `lightRestored`, `roomCleared`, `cardPicked`, `playerDamaged`, `focusTriggered`, etc. Style meter, audio, cards, director subscribe; no direct coupling.
- `Damageable`: `{ hp, armor, onHit(hit: HitInfo) }`; `HitInfo = { point, normal, impulse, bodyPart, source, damage, kind }`. A single `HitInfo` drives damage, ragdoll impulse, decals, sparks, sound.
- Collision groups: `player`, `enemyLive`, `ragdoll`, `debris`, `props`, `static`, `trigger`. Debris–debris collisions disabled after 2 s.

**Budgets (High tier):** ≤40 active ragdolls (oldest → kinematic → dissolve), ≤200 debris bodies (sleeping enabled), ≤128 dynamic lights, instanced level geometry and debris.

**Error handling**
- No WebGL2 / WASM → fallback screen with explanation.
- Asset load failure → procedural stand-in (every generated texture/track has a code-generated fallback).
- Pointer-lock lost → auto-pause.
- WebGL context loss → attempt restore, else reload prompt.

## 3. Rendering & light

- HDR half-float pipeline, AgX tonemapping, per-sector color-grade LUT (S1 cold cyan, S2 sodium orange, S3 magenta).
- PBR via `MeshStandardMaterial` with shader injection (`onBeforeCompile`).

**Clustered forward lighting:** frustum split 16×9×24 clusters. CPU bins lights per frame; light data + cluster index lists packed into `DataTexture`s; injected fragment shader loops only over its cluster's lights. Light types: tube (capsule/line light with representative-point specular), point, spot. Up to 128 dynamic lights. Every muzzle flash, explosion, spark burst, dash trail, glowing thrown body is a real light.

**Shadows:** 1–2 shadow-casting key spots per room; neon lights unshadowed; SSAO provides contact shadowing.

**Volumetrics:** half-resolution raymarched in-scatter in post, sampling cluster lights along view rays, blue-noise jitter + temporal accumulation. Visible beams, muzzle cones, dust; zones go dark when fixtures break.

**Post stack (tiered):** N8AO, SSR (half-res, roughness-gated, wet-floor puddle masks), mip-chain bloom, camera motion blur, chromatic aberration + vignette (damage / bullet-time), film grain, impact frames (1–2 frame flash on big hits).

**Materials:** AI-generated tileable albedos (concrete, metal, grating, hazard stripes, etc.) → offline Node script derives normal/roughness/AO; triplanar mapping on procedural geometry. Neon: emissive + flicker shader.

**VFX:** GPU particles (velocity-stretched sparks with depth-buffer collision, embers, dust, glass shards); pooled projected decals (scorch, bullet holes, oil); fixture break sequence (flicker → pop → sparks → glass → dark); android death = core emissive fades over 2 s.

**Camera juice:** FOV kick (dash/sprint), landing dip, strafe tilt, trauma-based Perlin shake (trauma²), recoil springs, weapon sway + bob, hit-stop 30–60 ms.

## 4. Physics, ragdolls, destruction, AI, levels

**Player:** Rapier `KinematicCharacterController` capsule, custom velocity integration for movement kit, step-up and slope handling, mass-scaled prop pushing.

**Android body builder:** data-driven segment definitions `{ name, shape: capsule|box, size, mass, parent, joint: { type: spherical|revolute, limits }, armor?, emissive?, breakThreshold? }`. Biped 11 segments, quadruped 13, drone core + detachable fins.
- Alive: kinematic-driven procedural pose (2-bone IK foot planting, bob, lean, aim IK).
- Hit reaction: partial active ragdoll — hit segment becomes dynamic with joint motors returning to pose; stagger scales motor stiffness; big hits cause fall + get-up.
- Death: full ragdoll, motors off, lethal impulse applied at hit point.
- Dismemberment: joint breaks past threshold → severed limb is an independent grabbable body with socket sparks.
- Rail Lance pin: fixed joint between segment and static geometry at hit point.

**Kinetic hand:** spring-damper constraint to a hold point with mass-aware max force (heavy objects lag/swing). Launch velocity = aim × power × (1/√mass). Impact damage = ½·m·Δv² above threshold, from Rapier contact-force events (body→enemy, prop→enemy, body→light fixture).

**Destruction:** seeded Voronoi pre-fracture generated at load per destructible archetype (pillar, crate, wall panel, barrier), cached, instanced. Intact = single body; on break swap to chunks inheriting velocity + hit impulse, plus dust and light flicker. Chunks sleep then freeze/despawn after 5 s or by budget. Only tagged props are destructible.

**AI:** utility scoring at 5 Hz (take cover, flank, rush, suppress, repair light, retreat to darkness) → small FSM executes. Per-room grid navmesh built at generation time; A* + steering + separation. **Director** tracks player stress (hp, kill rate, time since last hit) to pace spawn waves/composition. Every attack telegraphed by emissive core flare in the attack color.

**Level generation:** seeded generator assembles rooms from hand-authored modules (floor tiles, wall kits, pillars, catwalks, stairs, ramps) per room type with constraints (sightlines, cover density, fixture placement, spawn points, reachability). Corridors with lockable doors connect rooms. Run graph is a branching map per sector.

## 5. Audio, asset pipeline, UI

**Procedural SFX (WebAudio):** layered recipe synth (transient + body + tail: noise bursts, FM oscillators, pitch sweeps, filtered noise, waveshaping), randomized per play. Recipes for weapons (shot/reload/empty), material impacts (concrete/metal/glass/android), force-keyed ragdoll thuds, limb snap, fixture pop + glass, dash, kinetic hum (pitch follows held mass), bullet-time downshift (global lowpass + pitch-down), UI. HRTF spatialization, generated convolution reverb per room size, raycast occlusion lowpass.

**Music (Lyria 3 via OpenRouter):** per sector ambient bed + combat stem (matched key/BPM), boss track per sector, title theme, death + victory stings (~12 clips). Music director crossfades by combat intensity and ducks in bullet-time.

**Images (Gemini via OpenRouter):**
- ~12 tileable material albedos (`google/gemini-3.1-flash-image`) → seamless pass + normal/roughness/AO derivation.
- ~40 card illustrations, locked style prompt (`google/gemini-3.1-flash-lite-image` or flash).
- Title key art, 3 sector splashes, 3 boss portraits (`google/gemini-3-pro-image`).
- Neon signage / graffiti decals with alpha.

**Pipeline & budget:** `tools/gen-assets.ts` reads `tools/asset-manifest.json`, skips existing outputs (idempotent), logs per-call cost from OpenRouter usage data to `tools/spend-log.json`, hard-stops at $9. Order: music → textures → card art → key art. Generated assets are committed; runtime never calls the API.

**UI (DOM/CSS over canvas):**
- HUD: minimal corners, Lumen ring around crosshair, Focus meter, dash pips, damage direction indicators, hit markers, kill feed with style ranks.
- Card picker: 3 cards, hover tilt, rarity glow, synergy highlights.
- Menus: title (live 3D idle room background), settings (sensitivity, FOV, quality tier, volumes, colorblind-safe telegraph palette), run map, end-of-run stats + seed.
- Dev overlay (F1): frame-time graph, draw calls, light-cluster heatmap, physics debug render, floating AI utility scores, timescale slider.

## 6. Testing & delivery

**Unit (Vitest):** seeded RNG + room generator (determinism, connectivity, spawn reachability); card pool + synergy resolution; damage/impact math; cluster light binning; timescale tweening; fracture determinism.

**Smoke (Playwright):** boot with debug seed, 10 s scripted input bot; assert zero console errors, fps above floor at Low tier, `roomCleared` fires with auto-kill cheat.

**Visual review:** fixed debug camera screenshots per milestone via browser pane.

**Perf harness:** `?bench` spawns worst case (40 ragdolls, 200 debris, 128 lights) and logs frame-time percentiles.

**Delivery:** `npm run build` → `dist/`; README with tech breakdown + GIFs; `?seed=` share links.

## 7. Milestones (each playable)

| M | Name | Contents |
|---|---|---|
| M0 | Foundations | Asset generation (first, key expiry), scaffold, loop, input, movement kit in greybox |
| M1 | Feel | Weapons, camera juice, hit-stop, procedural SFX |
| M2 | Physics | Body builder, ragdolls, dismemberment, kinetic hand, fracture |
| M3 | Light | Clustered lighting, volumetrics, post stack, breakable fixtures + Lumen, materials |
| M4 | Game | AI + director, 5 enemies, room generator, run graph, cards, bullet-time |
| M5 | Content | 3 sectors, 3 bosses, music director, UI/menus, meta unlocks |
| M6 | Polish | Quality tiers, bench, dev overlay, balance, README/showreel |

Independent modules (audio synth, card system, level gen, asset gen) may be built by parallel subagents; integration and review stay centralized.

## 8. Out of scope

Mobile/touch, gamepad (possible stretch), multiplayer, save-mid-run, localization, runtime AI calls.
