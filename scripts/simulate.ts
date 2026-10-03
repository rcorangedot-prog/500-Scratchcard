/**
 * Simulation / verification harness.
 *
 *   npm run simulate -- [--games N] [--model FINITE_POOL|WEIGHTED] [--engine]
 *
 * Default path: for each game, a SCRNG1 result string is produced, parsed and
 * fed through deriveOutcome() — the exact code the engine uses live.
 * --engine runs every game through the full ScratchcardEngine (wallet,
 * persistence, UX messages) — slower, but end-to-end.
 *
 * Reports hit frequency vs. Par Sheet (chi-square), RTP, integrity errors,
 * and for FINITE_POOL runs of exactly one pool, exact reconciliation.
 *
 * NOTE: uses the platform CSPRNG as a stand-in. Re-run against captured
 * output of the certified RNG before submission.
 */

import {
  DevCryptoRngProvider,
  FinitePoolModel,
  InMemoryWallet,
  PAR_SHEET_3X3,
  ScratchcardEngine,
  WeightedTierModel,
  deriveOutcome,
  formatCompact,
  parseRngResult,
  reconcile,
  type OutcomeModel,
  type UxMessage,
} from '../src/index.js';
import { chiSquarePValue } from './stats.js';

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const ps = PAR_SHEET_3X3;
const N = Number(arg('games', String(ps.totalTickets)));
const modelKind = arg('model', 'FINITE_POOL') as 'FINITE_POOL' | 'WEIGHTED';
const viaEngine = args.includes('--engine');

const counts: Record<string, number> = { LOSE: 0 };
let payout = 0;
let integrityErrors = 0;
let rejections = 0;
const t0 = Date.now();

if (viaEngine) {
  const wallet = new InMemoryWallet(N * ps.ticketPriceCents);
  let lastResult: UxMessage | null = null;
  const engine = new ScratchcardEngine({
    rng: new DevCryptoRngProvider(),
    requireCertifiedRng: false,
    outcomeModel: modelKind,
    wallet,
    historySize: 1,
    onMessage: (m) => {
      if (m.type === 'RESULT_WIN' || m.type === 'RESULT_NO_WIN') lastResult = m;
      if (m.type === 'MALFUNCTION') integrityErrors++;
    },
  });
  await engine.start();
  for (let i = 0; i < N; i++) {
    await engine.buyTicket();
    await engine.revealAll();
    const r = lastResult as UxMessage | null;
    if (r?.type === 'RESULT_WIN') {
      const p = (r as UxMessage<'RESULT_WIN'>).payload;
      counts[p.winningSymbol] = (counts[p.winningSymbol] ?? 0) + 1;
      payout += p.prizeCents;
    } else counts.LOSE!++;
    if (i % 100_000 === 99_999) process.stderr.write(`  ${i + 1} games\n`);
  }
  const expectBalance = N * ps.ticketPriceCents - N * ps.ticketPriceCents + payout;
  if (wallet.balanceCents !== expectBalance) {
    console.error(`WALLET MISMATCH: ${wallet.balanceCents} != ${expectBalance}`);
    integrityErrors++;
  }
} else {
  const model: OutcomeModel = modelKind === 'FINITE_POOL' ? new FinitePoolModel(ps) : new WeightedTierModel(ps);
  const buf = new Uint32Array(32);
  for (let i = 0; i < N; i++) {
    crypto.getRandomValues(buf);
    const raw = formatCompact('DEV-CSPRNG', String(i), `sim-${i}`, Array.from(buf));
    try {
      const d = deriveOutcome(ps, model, [parseRngResult(raw)]);
      if (d.draw) model.commit(d.draw);
      const k = d.evaluation.winningSymbol ?? 'LOSE';
      counts[k] = (counts[k] ?? 0) + 1;
      payout += d.evaluation.prizeCents;
      rejections += d.rejections;
    } catch (e) {
      integrityErrors++;
      console.error(e);
    }
  }
}

const secs = (Date.now() - t0) / 1000;
const revenue = N * ps.ticketPriceCents;
console.log(`\n3x3 Symbol Match — simulation of ${N.toLocaleString()} games`);
console.log(`model=${modelKind} path=${viaEngine ? 'full engine' : 'deriveOutcome'}  (${secs.toFixed(1)}s)\n`);
console.log('Tier  Prize      Expected     Actual   Diff%');
let chi2 = 0;
for (const t of ps.tiers) {
  const exp = (t.targetWinners / ps.totalTickets) * N;
  const act = counts[t.symbol] ?? 0;
  chi2 += (act - exp) ** 2 / exp;
  console.log(
    `${t.symbol}     ${(t.prizeCents / 100).toFixed(2).padStart(7)}  ${exp.toFixed(1).padStart(10)} ${String(act).padStart(9)}  ${(((act - exp) / exp) * 100).toFixed(2).padStart(6)}`,
  );
}
const expLose = ((ps.totalTickets - 265_310) / ps.totalTickets) * N;
chi2 += ((counts.LOSE ?? 0) - expLose) ** 2 / expLose;
console.log(`LOSE            ${expLose.toFixed(1).padStart(10)} ${String(counts.LOSE).padStart(9)}`);
console.log(`\nRTP: ${((payout / revenue) * 100).toFixed(4)}% (target 75.0000%)`);
console.log(`Hit-frequency chi-square: ${chi2.toFixed(3)} (df=9) p=${chiSquarePValue(chi2, 9).toFixed(4)}`);
console.log(`Integrity errors: ${integrityErrors}`);
if (!viaEngine) console.log(`Scaling rejections: ${rejections}`);
if (modelKind === 'FINITE_POOL' && N === ps.totalTickets) {
  const rep = reconcile(ps, counts);
  console.log(`Full-pool reconciliation (AC-1/AC-3): ${rep.exactMatch ? 'EXACT MATCH' : 'MISMATCH ' + rep.problems.join('; ')}`);
  if (!rep.exactMatch) process.exitCode = 1;
}
if (integrityErrors) process.exitCode = 1;
