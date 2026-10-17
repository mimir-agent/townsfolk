// The brain's only source of randomness. The same seed always gives the same sequence, so a
// night (or a whole simulated year) replays exactly.

export type Rng = { next(): number };

// mulberry32: small, fast, good enough for gossip dice. next() is in [0, 1).
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

// FNV-1a, 32 bit. Turns a text key (save id and night) into a seed.
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
