import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RandomStream,
  RngError,
  compactParser,
  formatCompact,
  parseRngResult,
  type RngResultParser,
} from '../src/index.js';
import { HmacResultVerifier, stripSignature } from '../src/node.js';

describe('RNG result string parsing', () => {
  it('parses the compact SCRNG1 format', () => {
    const raw = formatCompact('GLI-RNG-07', '000123', 'req-1', [0, 1, 0xffffffff, 0xdeadbeef]);
    assert.equal(raw, 'SCRNG1|GLI-RNG-07|000123|req-1|0000000000000001ffffffffdeadbeef');
    const r = parseRngResult(raw);
    assert.equal(r.kind, 'values');
    assert.deepEqual(r.kind === 'values' && r.values, [0, 1, 0xffffffff, 0xdeadbeef]);
    assert.equal(r.rngId, 'GLI-RNG-07');
    assert.equal(r.sequence, '000123');
    assert.equal(r.requestId, 'req-1');
  });

  it('parses JSON values and JSON pre-determined tickets', () => {
    const v = parseRngResult('{"format":"SCRNG-JSON/1","rngId":"R","sequence":9,"requestId":"q","values":[5,6]}');
    assert.deepEqual(v.kind === 'values' && v.values, [5, 6]);
    const t = parseRngResult(
      '{"format":"SCRNG-JSON/1","rngId":"R","requestId":"q","ticket":{"serial":"S-1","grid":"IIBCIDFGH","symbol":"I"}}',
    );
    assert.equal(t.kind, 'ticket');
    assert.equal(t.kind === 'ticket' && t.grid, 'IIBCIDFGH');
  });

  it('rejects malformed input', () => {
    const bad = [
      '',
      'garbage',
      'SCRNG1|R|1|q|abc', // not whole words
      'SCRNG1|R|1|q', // missing field
      'SCRNG1|R w|1|q|00000001', // bad id chars
      '{"format":"SCRNG-JSON/1","rngId":"R","requestId":"q","values":[-1]}',
      '{"format":"SCRNG-JSON/1","rngId":"R","requestId":"q","values":[4294967296]}',
      '{"format":"SCRNG-JSON/1","rngId":"R","requestId":"q","values":[1.5]}',
      '{"format":"SCRNG-JSON/1","rngId":"R","requestId":"q"}',
      '{not json',
    ];
    for (const b of bad) assert.throws(() => parseRngResult(b), RngError, b);
  });

  it('accepts a custom vendor parser', () => {
    const vendor: RngResultParser = {
      format: 'VENDOR',
      parse: (raw) => {
        const m = /^V:(\w+):(\w+):([\d,]+)$/.exec(raw);
        return m
          ? { kind: 'values', format: 'VENDOR', rngId: m[1]!, sequence: null, requestId: m[2]!, values: m[3]!.split(',').map(Number) }
          : null;
      },
    };
    const r = parseRngResult('V:RNG:req9:1,2,3', [vendor, compactParser]);
    assert.deepEqual(r.kind === 'values' && r.values, [1, 2, 3]);
  });
});

describe('RandomStream', () => {
  it('throws RNG_EXHAUSTED when values run out and supports append', () => {
    const s = new RandomStream([3]);
    assert.equal(s.nextInt(10), 3);
    assert.throws(() => s.nextInt(10), (e: RngError) => e.code === 'RNG_EXHAUSTED');
    s.append([4]);
    assert.equal(s.nextInt(10), 4);
  });

  it('counts rejections', () => {
    const s = new RandomStream([0xffffffff, 1]);
    assert.equal(s.nextInt(3), 1);
    assert.equal(s.rejections, 1);
    assert.equal(s.consumed, 2);
  });
});

describe('HMAC result verifier', () => {
  it('accepts genuine and rejects tampered results', () => {
    const key = new Uint8Array(32).fill(7);
    const v = new HmacResultVerifier(key);
    const signed = HmacResultVerifier.sign(key, formatCompact('R', '1', 'q', [1, 2]));
    assert.equal(v.verify(signed), true);
    assert.equal(v.verify(signed.replace('00000001', '00000002')), false);
    assert.equal(v.verify('SCRNG1|R|1|q|00000001'), false);
    const r = parseRngResult(signed, [stripSignature(compactParser)]);
    assert.deepEqual(r.kind === 'values' && r.values, [1, 2]);
  });
});
