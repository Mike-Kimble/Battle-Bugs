/**
 * The people who'll work for you. Each name always has the same traits, but
 * the game never says what they are — you learn who's who by hiring them.
 *
 * Mechanics:
 *   pay       — what they expect, as a share of the going rate per vehicle
 *   blindTo   — a drive type they know nothing about: no advice on it (or on
 *               anything to do with the drive while you're running one)
 *   weapons   — false: knows nothing about weapons, never recommends one
 *
 * Managers (their wage habits only apply when they handle your wages):
 *   mechPay   — what they pay the mechanic, as a share of what the mechanic expects
 *   selfPay   — what they pay themselves, as a share of the going rate
 *   find      — chance of finding a part you want straight away (null: the
 *               usual hunt, 40% then +20% a bout)
 *   forgets   — now and then forgets to pay the mechanic (every 5–8 bouts)
 */
export const MECHANICS = Object.freeze({
  grizzle: { name: 'Grizzle Sprocketface', pay: 1.25 },
  oona: { name: 'Oona Fluxwrench', pay: 1, weapons: false },
  tibbs: { name: 'Tibbs Ratchetmoss', pay: 0.9 },
  vex: { name: 'Vex Ironmandible', pay: 1 },
  pog: { name: 'Pog Gristlebolt', pay: 1, blindTo: 'combustion' },
  marla: { name: 'Marla Two-Spanners', pay: 1, blindTo: 'torque' },
  quill: { name: 'Quill Ashthorax', pay: 1, blindTo: 'turbine' },
  dibbo: { name: 'Dibbo Coilgrub', pay: 1, blindTo: 'electric' },
  rumbo: { name: 'Rumbo Greasepit', pay: 1, blindTo: 'plasma' },
});

export const MANAGERS = Object.freeze({
  slyke: { name: 'Slyke Underwood', mechPay: 0.9, selfPay: 1 },
  bellamy: { name: 'Bellamy Goldwhisker', mechPay: 1.1, selfPay: 1.1 },
  zazz: { name: 'Zazz Quickfingers', mechPay: 1, selfPay: 1.25, find: 1 },
  krull: { name: 'Krull Tightjaw', mechPay: 0.9, selfPay: 1.25 },
  prim: { name: 'Prim Ledgerly', mechPay: 1, selfPay: 1 },
  nyx: { name: 'Nyx Fastcall', mechPay: 1, selfPay: 1, find: 0.8 },
  dorrit: { name: 'Dorrit Hazebrain', mechPay: 1, selfPay: 1, forgets: true },
});

export const STAFF_ROSTER = Object.freeze({ mechanic: MECHANICS, manager: MANAGERS });

/** Who staff on a save from before names were given turn out to be: the ones who do it straight. */
export const DEFAULT_STAFF = Object.freeze({ mechanic: 'vex', manager: 'prim' });
