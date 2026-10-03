/**
 * Example RngResultVerifier for RNG services that sign each result with a
 * shared-secret HMAC appended as a final field:  <result>|sig=<hex>
 * Node only. Adapt to the RNG vendor's actual signing scheme (e.g. Ed25519).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RngResultParser, RngResultVerifier } from './types.js';

export class HmacResultVerifier implements RngResultVerifier {
  constructor(private readonly key: Uint8Array) {}

  static sign(key: Uint8Array, body: string): string {
    return `${body}|sig=${createHmac('sha256', key).update(body).digest('hex')}`;
  }

  verify(raw: string): boolean {
    const i = raw.lastIndexOf('|sig=');
    if (i < 0) return false;
    const body = raw.slice(0, i);
    const sig = Buffer.from(raw.slice(i + 5), 'hex');
    const expect = createHmac('sha256', this.key).update(body).digest();
    return sig.length === expect.length && timingSafeEqual(sig, expect);
  }
}

/** Wraps a parser so it ignores a trailing "|sig=..." field (already verified). */
export function stripSignature(inner: RngResultParser): RngResultParser {
  return {
    format: `${inner.format}+sig`,
    parse(raw) {
      const i = raw.lastIndexOf('|sig=');
      return i < 0 ? null : inner.parse(raw.slice(0, i));
    },
  };
}
