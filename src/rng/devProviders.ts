/**
 * Non-certified RNG providers for development, demos and tests ONLY.
 *
 * Both report `certified: false`; the engine refuses to start with them
 * unless `requireCertifiedRng: false` is passed explicitly. In production,
 * replace them with an RngProvider that calls the GLI-certified RNG.
 */

import type { RandomSource } from './randomStream.js';
import { formatCompact } from './resultString.js';
import type { RngProvider, RngRequest } from './types.js';

function cryptoValues(count: number): number[] {
  const buf = new Uint32Array(count);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf);
}

/**
 * Emulates a remote RNG using the platform CSPRNG (Web Crypto
 * getRandomValues — available in browsers and Node ≥ 19). Emits SCRNG1
 * result strings exactly as a real RNG adapter would.
 */
export class DevCryptoRngProvider implements RngProvider {
  readonly certified = false;
  private seq = 0;
  constructor(readonly rngId = 'DEV-CSPRNG') {}

  async getResult(req: RngRequest): Promise<string> {
    this.seq++;
    return formatCompact(this.rngId, String(this.seq), req.requestId, cryptoValues(req.count));
  }
}

/**
 * Test double: returns results produced by a callback, so tests can script
 * exact RNG values, failures, delays or malformed strings.
 */
export class ScriptedRngProvider implements RngProvider {
  readonly requests: RngRequest[] = [];
  constructor(
    private readonly respond: (req: RngRequest, n: number) => string | Promise<string>,
    readonly rngId = 'TEST-RNG',
    readonly certified = true,
  ) {}

  async getResult(req: RngRequest): Promise<string> {
    this.requests.push(req);
    return this.respond(req, this.requests.length);
  }
}

/** Synchronous buffered CSPRNG source — for batch generation and simulation. */
export class CryptoRandomSource implements RandomSource {
  private buf = new Uint32Array(16_384);
  private pos = this.buf.length;
  nextUint32(): number {
    if (this.pos >= this.buf.length) {
      globalThis.crypto.getRandomValues(this.buf);
      this.pos = 0;
    }
    return this.buf[this.pos++]!;
  }
}
