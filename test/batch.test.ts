import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { CryptoRandomSource, PAR_SHEET_3X3, evaluateGrid } from '../src/index.js';
import { generateBatch, generateValidationNumber } from '../src/node.js';

describe('batch generation (Dev Spec §5–7)', () => {
  it('full 1,000,000-ticket batch reconciles exactly and is marked ready (AC-1, AC-2, AC-3, AC-5)', () => {
    const ps = PAR_SHEET_3X3;
    let n = 0;
    let multiConflicts = 0;
    let payout = 0;
    const firstSerials: string[] = [];
    const winnerPositions: number[] = [];
    const result = generateBatch(ps, {
      batchId: 'TEST-BATCH-1',
      hmacKey: randomBytes(32),
      rng: new CryptoRandomSource(),
      onTicket: (t) => {
        if (n < 3) firstSerials.push(t.serialNumber);
        if (!evaluateGrid(ps, [...t.grid]).valid) multiConflicts++;
        if (t.winningSymbol) winnerPositions.push(n);
        payout += t.prizeCents;
        n++;
      },
    });
    assert.equal(n, 1_000_000);
    assert.ok(result.ready, result.reconciliation.problems.join('; '));
    assert.equal(result.integrityErrors, 0);
    assert.equal(result.duplicateValidationNumbers, 0);
    assert.equal(multiConflicts, 0);
    assert.equal(payout, 75_000_000);
    assert.equal(result.reconciliation.rtp, 0.75);
    assert.deepEqual(firstSerials, ['SC-3X3-SYMBOL-MATCH-0000001', 'SC-3X3-SYMBOL-MATCH-0000002', 'SC-3X3-SYMBOL-MATCH-0000003']);

    // AC-7: winners spread evenly — winner count per decile within 5σ of 26,531.
    const dec = new Array(10).fill(0);
    for (const p of winnerPositions) dec[Math.floor(p / 100_000)]++;
    const sd = Math.sqrt(100_000 * 0.26531 * 0.73469);
    for (const d of dec) assert.ok(Math.abs(d - 26_531) < 5 * sd, `decile count ${d}`);
  });

  it('validation numbers are keyed: different key or tier gives a different number (AC-4)', () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const a = generateValidationNumber(k1, 't1', 'b1', 'I');
    assert.match(a, /^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);
    assert.notEqual(a, generateValidationNumber(k2, 't1', 'b1', 'I'));
    assert.notEqual(a, generateValidationNumber(k1, 't1', 'b1', 'A'));
    assert.equal(a, generateValidationNumber(k1, 't1', 'b1', 'I'));
  });

  it('refuses a short HMAC key', () => {
    assert.throws(
      () => generateBatch(PAR_SHEET_3X3, { batchId: 'b', hmacKey: new Uint8Array(8), rng: new CryptoRandomSource(), onTicket: () => {} }),
      /256 bits/,
    );
  });
});
