export interface Mods {
  dmgMul: number; rateMul: number; magMul: number; reloadMul: number;
  ricochet: number; chain: number; pierce: number; thermite: boolean; overcharge: boolean; headhunter: boolean;
  volatile: boolean;
  multiGrab: number; singularity: boolean; throwMul: number; siphon: number; shrapnel: boolean; puppeteer: boolean; graverobber: boolean;
  lumenMaxAdd: number;
  afterglow: boolean; extraAirJumps: number; extraDash: number; slideTackle: boolean; meteor: boolean; momentum: boolean; phaseDash: boolean;
  lanterns: boolean; photovore: boolean; blackout: boolean; refraction: boolean; flare: boolean; umbra: boolean;
  btDurMul: number; killchain: boolean; focusMul: number; timebank: boolean;
  hpAdd: number; nanites: number; adrenal: boolean; scavenger: boolean; glass: boolean;
}

export function defaultMods(): Mods {
  return {
    dmgMul: 1, rateMul: 1, magMul: 1, reloadMul: 1,
    ricochet: 0, chain: 0, pierce: 0, thermite: false, overcharge: false, headhunter: false, volatile: false,
    multiGrab: 1, singularity: false, throwMul: 1, siphon: 0, shrapnel: false, puppeteer: false, graverobber: false, lumenMaxAdd: 0,
    afterglow: false, extraAirJumps: 0, extraDash: 0, slideTackle: false, meteor: false, momentum: false, phaseDash: false,
    lanterns: false, photovore: false, blackout: false, refraction: false, flare: false, umbra: false,
    btDurMul: 1, killchain: false, focusMul: 1, timebank: false,
    hpAdd: 0, nanites: 0, adrenal: false, scavenger: false, glass: false,
  };
}

/** Everything that persists across rooms within one run. */
export class RunState {
  hp = 100;
  shield = 0;
  lumen = 60;
  focus = 0;
  weapons: string[] = ['arc', 'scatter'];
  cards: string[] = [];
  mods: Mods = defaultMods();
  kills = 0;
  headshots = 0;
  kineticKills = 0;
  lightsBroken = 0;
  roomsCleared = 0;
  damageTaken = 0;
  score = 0;
  style = 0;
  bestStyle = 0;
  startTime = performance.now();
  sector = 0;
  constructor(public seed: number) {}

  get maxHp() { return Math.max(20, Math.round((100 + this.mods.hpAdd) * (this.mods.glass ? 0.6 : 1))); }
  get maxLumen() { return 100 + this.mods.lumenMaxAdd; }

  damage(amount: number): number {
    if (this.shield > 0) { const s = Math.min(this.shield, amount); this.shield -= s; amount -= s; }
    this.hp = Math.max(0, this.hp - amount);
    this.damageTaken += amount;
    return amount;
  }
  heal(n: number) { this.hp = Math.min(this.maxHp, this.hp + n); }
  addLumen(n: number) { this.lumen = Math.max(0, Math.min(this.maxLumen, this.lumen + n)); }
  addFocus(n: number) { this.focus = Math.min(1, this.focus + n * this.mods.focusMul); }
}
