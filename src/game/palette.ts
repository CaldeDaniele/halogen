import { ENEMIES, EnemyType } from './enemies/defs';

/**
 * Colorblind-safe telegraph palettes. Colors are chosen so that, under a full-severity simulation of
 * each color-vision deficiency (Machado, Oliveira & Fernandes 2009), every attack tell is clearly
 * different from the enemy's idle core color and from the white hit flash (tests/palette.test.ts).
 */
export const CVD_MODES = ['default', 'deuteranopia', 'protanopia', 'tritanopia'] as const;
export type CvdMode = (typeof CVD_MODES)[number];

export interface Palette {
  /** enemy attack tell (core flare + projectiles) per type */
  tell: Record<EnemyType, number>;
  /** boss attack tell / the Foreman's alternate (slam) tell / Filament beam */
  bossTell: number; bossAlt: number; beam: number;
  /** HUD: player damage (vignette, direction arcs), kill + headshot markers */
  hurt: number; kill: number; head: number;
}

const DEFAULT: Palette = {
  tell: Object.fromEntries((Object.keys(ENEMIES) as EnemyType[]).map(t => [t, ENEMIES[t].attackColor])) as Record<EnemyType, number>,
  bossTell: 0xff3b3b, bossAlt: 0x19f0ff, beam: 0xffc0ff,
  hurt: 0xff3b3b, kill: 0xff3b3b, head: 0xffb02e,
};

const YELLOW = 0xffd400, BLUE = 0x2f6bff, ORANGE = 0xff8c00, RED = 0xff3b3b, CYAN = 0x19f0ff;

// red-green deficiencies: "yellow means attack" (blue on the amber Charger); tritanopia: the red/cyan axis
const RED_GREEN: Palette = {
  tell: { grunt: YELLOW, charger: BLUE, skitter: YELLOW, shade: YELLOW, lamplighter: DEFAULT.tell.lamplighter, foreman: YELLOW },
  bossTell: YELLOW, bossAlt: BLUE, beam: YELLOW,
  hurt: ORANGE, kill: BLUE, head: YELLOW,
};

const PALETTES: Record<CvdMode, Palette> = {
  default: DEFAULT,
  deuteranopia: RED_GREEN,
  protanopia: RED_GREEN,
  tritanopia: {
    tell: { grunt: RED, charger: CYAN, skitter: CYAN, shade: RED, lamplighter: DEFAULT.tell.lamplighter, foreman: RED },
    bossTell: RED, bossAlt: YELLOW, beam: RED,
    hurt: RED, kill: RED, head: 0xffb02e,
  },
};

export function palette(mode: CvdMode): Palette { return PALETTES[mode] ?? DEFAULT; }

// ---------------------------------------------------------------- color science (pure)
type RGB = [number, number, number];

const MACHADO: Record<Exclude<CvdMode, 'default'>, number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
};

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => { const v = Math.min(1, Math.max(0, c)); return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055; };

/** sRGB (0..1) of a hex color as seen with the given deficiency. */
export function simulateCvd(hex: number, mode: CvdMode): RGB {
  const s: RGB = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  if (mode === 'default') return s;
  const m = MACHADO[mode], l = s.map(toLin);
  return [0, 1, 2].map(i => toSrgb(m[i * 3] * l[0] + m[i * 3 + 1] * l[1] + m[i * 3 + 2] * l[2])) as RGB;
}

function lab(c: RGB): RGB {
  const [r, g, b] = c.map(toLin);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 color difference between two sRGB colors. */
export function deltaE(a: RGB, b: RGB) { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }
/** CIE L* (0..100) of an sRGB color. */
export function lightness(c: RGB) { return lab(c)[0]; }
