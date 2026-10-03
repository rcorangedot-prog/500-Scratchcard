/**
 * Unbiased scaling of raw RNG values to game ranges.
 *
 * GLI-19 requires that scaling of RNG output to a game range introduces no
 * bias. A plain `value % n` is biased whenever 2^32 is not a multiple of n, so
 * nextInt() uses rejection sampling: values in the incomplete top "bucket" are
 * discarded and the next value is used. The rejection rule is deterministic,
 * so a stored result string always replays to the same outcome.
 */

import { RngError } from './types.js';

const TWO_POW_32 = 0x1_0000_0000;

export interface RandomSource {
  /** Next raw uniformly distributed 32-bit unsigned value. */
  nextUint32(): number;
}

/** Uniform integer in [0, n) from a RandomSource, with rejection sampling. */
export function scaleUniform(src: RandomSource, n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0 || n > TWO_POW_32) throw new RangeError(`invalid range ${n}`);
  if (n === 1) return 0;
  const limit = TWO_POW_32 - (TWO_POW_32 % n); // largest multiple of n ≤ 2^32
  for (;;) {
    const v = src.nextUint32();
    if (v < limit) return v % n;
  }
}

/** A finite stream of values taken from one or more RNG result strings. */
export class RandomStream implements RandomSource {
  private pos = 0;
  private rejected = 0;
  private readonly values: number[];

  constructor(values: readonly number[]) {
    this.values = values.slice();
  }

  append(values: readonly number[]): void {
    this.values.push(...values);
  }

  nextUint32(): number {
    if (this.pos >= this.values.length)
      throw new RngError('RNG_EXHAUSTED', `RNG values exhausted after ${this.pos} draws`);
    return this.values[this.pos++]!;
  }

  nextInt(n: number): number {
    const before = this.pos;
    const r = scaleUniform(this, n);
    this.rejected += this.pos - before - 1;
    return r;
  }

  get consumed(): number {
    return this.pos;
  }
  get rejections(): number {
    return this.rejected;
  }
  get available(): number {
    return this.values.length;
  }
}
