import { Rng } from '../../core/rng';
import { RunState } from './state';

export type Rarity = 'common' | 'rare' | 'legendary';
export type Tag = 'weapon' | 'kinetic' | 'movement' | 'light' | 'focus' | 'defense';

export interface CardDef {
  id: string; name: string; desc: string; rarity: Rarity; tags: Tag[];
  unique: boolean;
  apply(run: RunState): void;
}

const c = (id: string, name: string, desc: string, rarity: Rarity, tags: Tag[], apply: (r: RunState) => void, unique = true): CardDef => ({ id, name, desc, rarity, tags, unique, apply });

function giveWeapon(r: RunState, w: string, slot?: number) {
  if (r.weapons.includes(w)) return;
  if (r.weapons.length < 2) r.weapons.push(w);
  else r.weapons[slot ?? 1] = w;
}

export const CARDS: CardDef[] = [
  c('w_arc', 'Arc Pistol', 'Fast hitscan sidearm. Headshots ×2.5.', 'common', ['weapon'], r => giveWeapon(r, 'arc'), false),
  c('w_scatter', 'Scattergun', 'Ten pellets of close-range violence. Launches ragdolls.', 'common', ['weapon'], r => giveWeapon(r, 'scatter'), false),
  c('w_rail', 'Rail Lance', 'Hold to charge. Pierces everything. Pins bodies to walls.', 'rare', ['weapon'], r => giveWeapon(r, 'rail'), false),
  c('w_ion', 'Ion Launcher', 'Arcing ion grenades. Big radial impulse.', 'rare', ['weapon'], r => giveWeapon(r, 'ion'), false),
  c('ricochet', 'Ricochet Rounds', 'Shots bounce off walls once.', 'common', ['weapon'], r => { r.mods.ricochet += 1; }),
  c('chain', 'Arc Chain', 'Hits arc lightning to 2 nearby androids.', 'rare', ['weapon', 'light'], r => { r.mods.chain += 2; }),
  c('volatile', 'Volatile Frames', 'Killed androids detonate after a beat.', 'rare', ['weapon', 'kinetic'], r => { r.mods.volatile = true; }),
  c('overpressure', 'Overpressure', '+25% weapon damage.', 'common', ['weapon'], r => { r.mods.dmgMul *= 1.25; }, false),
  c('quickcycle', 'Quick Cycle', '+30% fire rate.', 'common', ['weapon'], r => { r.mods.rateMul *= 1.3; }, false),
  c('deepmag', 'Deep Magazine', '+50% magazine size, faster reloads.', 'common', ['weapon'], r => { r.mods.magMul *= 1.5; r.mods.reloadMul *= 0.85; }),
  c('headhunter', 'Headhunter', 'Headshot kills refill your magazine and Focus.', 'rare', ['weapon', 'focus'], r => { r.mods.headhunter = true; }),
  c('tungsten', 'Tungsten Core', 'Shots pierce one extra target.', 'common', ['weapon'], r => { r.mods.pierce += 1; }),
  c('thermite', 'Thermite', 'Hits ignite androids: burning damage over time.', 'rare', ['weapon', 'light'], r => { r.mods.thermite = true; }),
  c('overcharge', 'Overcharge', 'Every 6th shot deals triple damage.', 'common', ['weapon'], r => { r.mods.overcharge = true; }),
  c('tether', 'Tether Array', 'Kinetic hand grabs up to 3 objects.', 'rare', ['kinetic'], r => { r.mods.multiGrab = 3; }),
  c('singularity', 'Singularity', 'Thrown objects collapse into a brief vortex on impact.', 'legendary', ['kinetic'], r => { r.mods.singularity = true; }),
  c('heavyhand', 'Heavy Hand', '+60% throw force.', 'common', ['kinetic'], r => { r.mods.throwMul *= 1.6; }),
  c('siphon', 'Siphon', 'Kinetic kills restore 15 HP.', 'rare', ['kinetic', 'defense'], r => { r.mods.siphon += 15; }),
  c('lumenwell', 'Lumen Well', '+50 max Lumen.', 'common', ['kinetic', 'light'], r => { r.mods.lumenMaxAdd += 50; r.lumen += 50; }),
  c('shrapnel', 'Shrapnel Burst', 'Thrown objects explode into shrapnel on impact.', 'rare', ['kinetic', 'weapon'], r => { r.mods.shrapnel = true; }),
  c('puppeteer', 'Puppeteer', 'Grabbed androids fire their weapons at their friends.', 'legendary', ['kinetic'], r => { r.mods.puppeteer = true; }),
  c('graverobber', 'Graverobber', 'Severed limbs release Lumen.', 'common', ['kinetic', 'light'], r => { r.mods.graverobber = true; }),
  c('afterglow', 'Afterglow', 'Dashing leaves a burning light trail that damages.', 'rare', ['movement', 'light'], r => { r.mods.afterglow = true; }),
  c('updraft', 'Updraft', '+1 air jump.', 'common', ['movement'], r => { r.mods.extraAirJumps += 1; }),
  c('surplus', 'Surplus Coil', '+1 dash charge.', 'common', ['movement'], r => { r.mods.extraDash += 1; }),
  c('slidetackle', 'Slide Tackle', 'Sliding into androids knocks them into ragdoll.', 'common', ['movement', 'kinetic'], r => { r.mods.slideTackle = true; }),
  c('meteor', 'Meteor', 'Crouch in mid-air to slam down with a shockwave.', 'rare', ['movement', 'kinetic'], r => { r.mods.meteor = true; }),
  c('momentum', 'Momentum Plating', 'Take 40% less damage while moving fast.', 'rare', ['movement', 'defense'], r => { r.mods.momentum = true; }),
  c('phasedash', 'Phase Dash', 'Dash through androids, shredding them.', 'legendary', ['movement'], r => { r.mods.phaseDash = true; }),
  c('lanterns', 'Lanterns', 'Dead androids keep glowing. More light, more Lumen.', 'common', ['light'], r => { r.mods.lanterns = true; }),
  c('photovore', 'Photovore', 'Regenerate HP while standing in light.', 'rare', ['light', 'defense'], r => { r.mods.photovore = true; }),
  c('blackout', 'Blackout Protocol', 'Breaking a light stuns androids beneath it.', 'rare', ['light'], r => { r.mods.blackout = true; }),
  c('refraction', 'Refraction', 'Shots fired while standing in light split into 3.', 'legendary', ['light', 'weapon'], r => { r.mods.refraction = true; }),
  c('flare', 'Flare Rounds', 'Every 5th shot plants a burning flare that lights the area.', 'common', ['light', 'weapon'], r => { r.mods.flare = true; }),
  c('umbra', 'Umbra Sight', 'See and hit Shades in darkness.', 'rare', ['light'], r => { r.mods.umbra = true; }),
  c('afterimage', 'Afterimage', 'Bullet-time lasts 50% longer.', 'common', ['focus'], r => { r.mods.btDurMul *= 1.5; }),
  c('killchain', 'Killchain', 'Kills during bullet-time extend it.', 'rare', ['focus'], r => { r.mods.killchain = true; }),
  c('hairtrigger', 'Hair Trigger', 'Focus fills 40% faster.', 'common', ['focus'], r => { r.mods.focusMul *= 1.4; }),
  c('timebank', 'Time Bank', 'Press Q to trigger bullet-time manually at full Focus.', 'rare', ['focus'], r => { r.mods.timebank = true; }),
  c('plating', 'Reactive Plating', '+25 max HP.', 'common', ['defense'], r => { r.mods.hpAdd += 25; r.hp += 25; }),
  c('nanites', 'Nanite Mesh', 'Heal 20 HP whenever you clear a room.', 'common', ['defense'], r => { r.mods.nanites += 20; }),
  c('adrenal', 'Adrenal Shield', 'Kills grant a 10 HP overshield.', 'rare', ['defense'], r => { r.mods.adrenal = true; }),
  c('scavenger', 'Scavenger', 'Androids drop health cells more often.', 'common', ['defense'], r => { r.mods.scavenger = true; }),
  c('glasscannon', 'Glass Cannon', '+60% damage, −40% max HP.', 'legendary', ['weapon'], r => { r.mods.glass = true; r.mods.dmgMul *= 1.6; r.hp = Math.min(r.hp, r.maxHp); }),
];

/** Fallbacks guarantee a non-empty offer. */
export const FALLBACKS: CardDef[] = [
  c('repair', 'Field Repair', 'Restore 40 HP.', 'common', ['defense'], r => r.heal(40), false),
  c('lumencharge', 'Lumen Charge', 'Fill your Lumen.', 'common', ['light'], r => { r.lumen = r.maxLumen; }, false),
  c('focuscharge', 'Focus Charge', 'Fill your Focus.', 'common', ['focus'], r => { r.focus = 1; }, false),
];

const ALL = new Map([...CARDS, ...FALLBACKS].map(x => [x.id, x]));
export const cardById = (id: string) => ALL.get(id);

const RW: Record<Rarity, number> = { common: 1, rare: 0.35, legendary: 0.09 };

export function offerCards(run: RunState, rng: Rng, count = 3, opts: { rare?: boolean; weaponsOnly?: boolean } = {}): CardDef[] {
  const owned = new Set(run.cards);
  const ownedTags = new Map<Tag, number>();
  for (const id of run.cards) for (const t of cardById(id)?.tags ?? []) ownedTags.set(t, (ownedTags.get(t) ?? 0) + 1);
  let pool = CARDS.filter(cd => {
    if (cd.unique && owned.has(cd.id)) return false;
    if (cd.id.startsWith('w_') && run.weapons.includes(cd.id.slice(2) === 'scatter' ? 'scatter' : cd.id.slice(2))) return false;
    if (opts.weaponsOnly && !cd.id.startsWith('w_')) return false;
    return true;
  });
  const out: CardDef[] = [];
  while (out.length < count && pool.length) {
    const pick = rng.weighted(pool, cd => {
      let w = RW[cd.rarity] * (opts.rare && cd.rarity !== 'common' ? 4 : 1);
      for (const t of cd.tags) w *= 1 + 0.35 * Math.min(3, ownedTags.get(t) ?? 0);
      if (cd.id.startsWith('w_')) w *= 0.7;
      return w;
    });
    out.push(pick);
    pool = pool.filter(x => x !== pick);
  }
  for (const f of FALLBACKS) { if (out.length >= count) break; out.push(f); }
  return out;
}

export function applyCard(run: RunState, id: string) {
  const cd = cardById(id);
  if (!cd) return;
  cd.apply(run);
  if (!FALLBACKS.includes(cd)) run.cards.push(id);
}
