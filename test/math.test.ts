import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CryptoRandomSource,
  FinitePoolModel,
  PAR_SHEET_3X3,
  ParSheetError,
  WeightedTierModel,
  buildLosingGrid,
  buildWinningGrid,
  evaluateGrid,
  reconcile,
  scaleUniform,
  summarizeParSheet,
  validateParSheet,
  type ParSheet,
  type SymbolId,
} from '../src/index.js';

const ps = PAR_SHEET_3X3;
const src = new CryptoRandomSource();
const ints = { nextInt: (n: number) => scaleUniform(src, n) };

describe('par sheet (Dev Spec §4)', () => {
  it('matches the approved workbook totals', () => {
    const s = validateParSheet(ps);
    assert.equal(s.totalWinners, 265_310);
    assert.equal(s.totalLosers, 734_690);
    assert.equal(s.totalPayoutCents, 75_000_000);
    assert.equal(s.rtp, 0.75);
    assert.equal(s.maxPrizeCents, 50_000);
  });

  it('refuses to run when totals do not reconcile', () => {
    const tampered: ParSheet = {
      ...ps,
      tiers: ps.tiers.map((t) => (t.symbol === 'I' ? { ...t, targetWinners: 311 } : t)),
    };
    assert.throws(() => validateParSheet(tampered), ParSheetError);
  });

  it('refuses winners exceeding the ticket total and bad prizes', () => {
    assert.throws(() => validateParSheet({ ...ps, totalTickets: 1000 }), /exceeds totalTickets/);
    assert.throws(
      () => validateParSheet({ ...ps, tiers: ps.tiers.map((t) => ({ ...t, prizeCents: t.symbol === 'A' ? 0 : t.prizeCents })) }),
      /prizeCents/,
    );
  });

  it('summary is consistent with the Game Spec §3', () => {
    const s = summarizeParSheet(ps);
    assert.equal((ps.totalTickets / s.totalWinners).toFixed(2), '3.77');
  });
});

describe('unbiased scaling', () => {
  it('rejects values in the incomplete top bucket', () => {
    // n = 3: limit = 2^32 - (2^32 % 3) = 4294967295 → value 4294967295 must be rejected.
    const vals = [0xffff_ffff, 7];
    let i = 0;
    const r = scaleUniform({ nextUint32: () => vals[i++]! }, 3);
    assert.equal(r, 7 % 3);
    assert.equal(i, 2);
  });

  it('accepts every value when n is a power of two', () => {
    let i = 0;
    assert.equal(scaleUniform({ nextUint32: () => (i++, 0xffff_ffff) }, 8), 7);
    assert.equal(i, 1);
  });

  it('is uniform (chi-square, 10 bins, 200k draws)', () => {
    const bins = new Array(10).fill(0);
    const N = 200_000;
    for (let i = 0; i < N; i++) bins[scaleUniform(src, 10)]++;
    const chi2 = bins.reduce((a, o) => a + (o - N / 10) ** 2 / (N / 10), 0);
    assert.ok(chi2 < 27.88, `chi2=${chi2}`); // df=9, p=0.001 critical value
  });
});

describe('grid construction (AC-2)', () => {
  it('winning grids have exactly one winning symbol: the tier symbol', () => {
    for (let i = 0; i < 30_000; i++) {
      const sym = ps.tiers[i % 9]!.symbol;
      const g = buildWinningGrid(ps, sym, ints);
      const ev = evaluateGrid(ps, g);
      assert.ok(ev.valid);
      assert.equal(ev.winningSymbol, sym);
      assert.equal(ev.winningCells.length, 3);
      for (const [s, c] of Object.entries(ev.counts)) if (s !== sym) assert.ok(c <= 2);
    }
  });

  it('losing grids have every symbol ≤ 2', () => {
    for (let i = 0; i < 30_000; i++) {
      const ev = evaluateGrid(ps, buildLosingGrid(ps, ints));
      assert.ok(ev.valid);
      assert.equal(ev.isWinner, false);
      assert.ok(Object.values(ev.counts).every((c) => c <= 2));
    }
  });

  it('filler symbols are not steered (jackpot symbol appears in losing grids at chance rate)', () => {
    // Every symbol is exchangeable in losing-grid construction, so each should
    // appear in 1/9 of cells. A near-miss bias toward I would break this.
    const counts: Record<string, number> = {};
    const N = 20_000;
    for (let i = 0; i < N; i++) for (const s of buildLosingGrid(ps, ints)) counts[s] = (counts[s] ?? 0) + 1;
    const exp = (N * 9) / 9;
    const chi2 = Object.values(counts).reduce((a, o) => a + (o - exp) ** 2 / exp, 0);
    assert.ok(chi2 < 26.12, `chi2=${chi2}`); // df=8, p=0.001
  });

  it('evaluator rejects multi-symbol conflicts, unknown symbols and bad sizes', () => {
    assert.equal(evaluateGrid(ps, [...'AAABBBCDE']).valid, false);
    assert.equal(evaluateGrid(ps, [...'AAXBCDEFG']).valid, false);
    assert.equal(evaluateGrid(ps, [...'ABCDEFGH']).valid, false);
    const ev = evaluateGrid(ps, [...'IIBCIDFGH']); // Game Spec §4 example
    assert.ok(ev.valid && ev.winningSymbol === 'I' && ev.prizeCents === 50_000);
    assert.deepEqual(ev.valid && ev.winningCells, [0, 1, 4]);
    const lose = evaluateGrid(ps, [...'ABCDEFGHI']);
    assert.ok(lose.valid && !lose.isWinner && lose.prizeCents === 0);
    const four = evaluateGrid(ps, [...'AAAABCDEF']); // "3 or more" wins
    assert.ok(four.valid && four.winningSymbol === 'A');
  });
});

describe('outcome models', () => {
  it('FINITE_POOL: a full 1,000,000-ticket cycle reconciles to the Par Sheet exactly (AC-1, AC-3)', () => {
    const model = new FinitePoolModel(ps);
    const counts: Record<string, number> = {};
    let payout = 0;
    for (let i = 0; i < ps.totalTickets; i++) {
      const d = model.drawTier(ints);
      model.commit(d);
      const k = d.symbol ?? 'LOSE';
      counts[k] = (counts[k] ?? 0) + 1;
      if (d.symbol) payout += ps.tiers.find((t) => t.symbol === d.symbol)!.prizeCents;
    }
    const rep = reconcile(ps, counts);
    assert.ok(rep.exactMatch, rep.problems.join('; '));
    assert.equal(payout, 75_000_000);
    assert.equal(rep.rtp, 0.75);
    assert.equal(model.remainingTickets, 0);
    // next draw starts a new cycle
    model.commit(model.drawTier(ints));
    assert.equal(model.snapshot().poolCycle, 2);
    assert.equal(model.remainingTickets, ps.totalTickets - 1);
  });

  it('FINITE_POOL draw is pure until commit', () => {
    const m = new FinitePoolModel(ps);
    const before = JSON.stringify(m.snapshot());
    m.drawTier(ints);
    assert.equal(JSON.stringify(m.snapshot()), before);
  });

  it('FINITE_POOL rejects a corrupted restored state', () => {
    assert.throws(() => new FinitePoolModel(ps, { poolCycle: 1, remaining: { A: -1 } }));
  });

  it('WEIGHTED: hit frequencies match the Par Sheet (chi-square, 1,000,000 draws)', () => {
    const m = new WeightedTierModel(ps);
    const counts: Record<string, number> = {};
    const N = 1_000_000;
    for (let i = 0; i < N; i++) {
      const k = m.drawTier(ints).symbol ?? 'LOSE';
      counts[k] = (counts[k] ?? 0) + 1;
    }
    let chi2 = 0;
    for (const t of ps.tiers) chi2 += ((counts[t.symbol] ?? 0) - t.targetWinners) ** 2 / t.targetWinners;
    chi2 += ((counts.LOSE ?? 0) - 734_690) ** 2 / 734_690;
    assert.ok(chi2 < 27.88, `chi2=${chi2}`); // df=9, p=0.001
  });

  it('tier boundaries map exactly (cumulative winner counts)', () => {
    const m = new FinitePoolModel(ps);
    const at = (idx: number) => m.drawTier({ nextInt: () => idx }).symbol;
    const expect: [number, SymbolId | null][] = [
      [0, 'A'], [149_999, 'A'], [150_000, 'B'], [209_999, 'B'], [210_000, 'C'],
      [264_999, 'H'], [265_000, 'I'], [265_309, 'I'], [265_310, null], [999_999, null],
    ];
    for (const [i, s] of expect) assert.equal(at(i), s, `index ${i}`);
  });
});
