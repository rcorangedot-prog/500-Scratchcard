/**
 * Result-string formats accepted from the RNG.
 *
 * Two built-in formats are provided. If the certified RNG uses a different
 * wire format, implement RngResultParser and pass it to the engine — nothing
 * else changes.
 *
 * 1) Compact pipe-delimited (values):
 *      SCRNG1|<rngId>|<sequence>|<requestId>|<hex>
 *    <hex> is a whole number of 32-bit big-endian words (8 hex chars each).
 *    e.g. SCRNG1|GLI-RNG-07|000123|req-1|9f3a01c47be2...
 *
 * 2) JSON (values or pre-determined ticket):
 *      {"format":"SCRNG-JSON/1","rngId":"...","sequence":"...","requestId":"...",
 *       "values":[uint32, ...]}
 *    or
 *      {"format":"SCRNG-JSON/1","rngId":"...","sequence":"...","requestId":"...",
 *       "ticket":{"serial":"...","grid":"IIBCIDFGH","symbol":"I"}}
 */

import { RngError, type RngResult, type RngResultParser } from './types.js';

const UINT32_MAX = 0xffff_ffff;
const SAFE_FIELD = /^[A-Za-z0-9._:\-]{1,128}$/;

function checkField(name: string, v: unknown): string {
  if (typeof v !== 'string' || !SAFE_FIELD.test(v)) throw new RngError('RNG_PARSE_FAILED', `invalid ${name}`);
  return v;
}

export const compactParser: RngResultParser = {
  format: 'SCRNG1',
  parse(raw) {
    if (!raw.startsWith('SCRNG1|')) return null;
    const parts = raw.trim().split('|');
    if (parts.length !== 5) throw new RngError('RNG_PARSE_FAILED', 'SCRNG1 needs 5 fields');
    const [, rngId, sequence, requestId, hex] = parts as [string, string, string, string, string];
    if (!/^(?:[0-9a-fA-F]{8})+$/.test(hex))
      throw new RngError('RNG_PARSE_FAILED', 'SCRNG1 payload must be whole 32-bit hex words');
    const values: number[] = [];
    for (let i = 0; i < hex.length; i += 8) values.push(Number.parseInt(hex.slice(i, i + 8), 16));
    return {
      kind: 'values',
      format: 'SCRNG1',
      rngId: checkField('rngId', rngId),
      sequence: sequence === '' ? null : checkField('sequence', sequence),
      requestId: checkField('requestId', requestId),
      values,
    };
  },
};

export const jsonParser: RngResultParser = {
  format: 'SCRNG-JSON/1',
  parse(raw) {
    const s = raw.trim();
    if (!s.startsWith('{')) return null;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s) as Record<string, unknown>;
    } catch {
      throw new RngError('RNG_PARSE_FAILED', 'malformed JSON result');
    }
    if (o.format !== 'SCRNG-JSON/1') return null;
    const base = {
      format: 'SCRNG-JSON/1',
      rngId: checkField('rngId', o.rngId),
      sequence: o.sequence == null ? null : checkField('sequence', String(o.sequence)),
      requestId: checkField('requestId', o.requestId),
    };
    if (Array.isArray(o.values)) {
      const values = o.values.map((v) => {
        if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > UINT32_MAX)
          throw new RngError('RNG_PARSE_FAILED', 'values must be uint32 integers');
        return v as number;
      });
      return { kind: 'values', ...base, values };
    }
    if (o.ticket && typeof o.ticket === 'object') {
      const t = o.ticket as Record<string, unknown>;
      if (typeof t.grid !== 'string') throw new RngError('RNG_PARSE_FAILED', 'ticket.grid missing');
      return {
        kind: 'ticket',
        ...base,
        ticketSerial: checkField('ticket.serial', t.serial),
        grid: t.grid,
        declaredSymbol: t.symbol == null ? null : String(t.symbol),
      };
    }
    throw new RngError('RNG_PARSE_FAILED', 'JSON result has neither values nor ticket');
  },
};

export const DEFAULT_PARSERS: readonly RngResultParser[] = [compactParser, jsonParser];

export function parseRngResult(raw: string, parsers: readonly RngResultParser[] = DEFAULT_PARSERS): RngResult {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1_000_000)
    throw new RngError('RNG_PARSE_FAILED', 'empty or oversized result string');
  for (const p of parsers) {
    const r = p.parse(raw);
    if (r) return r;
  }
  throw new RngError('RNG_PARSE_FAILED', 'result string matches no registered format');
}

/** Builds a compact SCRNG1 string (used by dev/test providers and fixtures). */
export function formatCompact(rngId: string, sequence: string, requestId: string, values: readonly number[]): string {
  const hex = values.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
  return `SCRNG1|${rngId}|${sequence}|${requestId}|${hex}`;
}
