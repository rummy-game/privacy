import type { Rng } from './rules';

// Zufällige Spielernamen (Adjektiv-Tier-Zahl). Bewusst kurze, harmlose Listen: keine Marken,
// keine Beleidigungen, keine Personennamen.
const ADJECTIVES = [
  'Flinker', 'Ruhiger', 'Mutiger', 'Kluger', 'Listiger', 'Fröhlicher', 'Gelassener', 'Wacher',
  'Zäher', 'Sanfter', 'Schneller', 'Stiller', 'Heiterer', 'Tapferer', 'Geduldiger', 'Neugieriger',
];
const ANIMALS = [
  'Fuchs', 'Dachs', 'Otter', 'Falke', 'Luchs', 'Igel', 'Biber', 'Hase', 'Rabe', 'Uhu',
  'Wal', 'Elch', 'Specht', 'Marder', 'Kranich', 'Hirsch',
];

const pick = <T>(list: T[], rng: Rng) => list[Math.floor(rng() * list.length)];

export const randomName = (rng: Rng) =>
  `${pick(ADJECTIVES, rng)}-${pick(ANIMALS, rng)}-${100 + Math.floor(rng() * 900)}`;
