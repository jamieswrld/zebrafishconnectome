/**
 * Seeded pseudorandom number generation.
 *
 * The simulation must be reproducible: a given seed plus a given input sequence
 * has to produce the same behaviour every run, or benchmarks are noise and
 * controller tests cannot assert anything.
 */

/** mulberry32: small, fast, and identical across JS engines. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SeededRandom {
  private next: () => number;
  // Declared explicitly rather than as a constructor parameter property, so
  // this module can be loaded by Node's type-stripping loader in scripts.
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
    this.next = mulberry32(seed);
  }

  reset(seed = this.seed): void {
    this.seed = seed;
    this.next = mulberry32(seed);
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.next();
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Standard normal via Box-Muller. */
  gaussian(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  bool(probability: number): boolean {
    return this.next() < probability;
  }
}
