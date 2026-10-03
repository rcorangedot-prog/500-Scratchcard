/**
 * Generates a full fixed-pool batch (Dev Spec §5) and writes it as JSONL.
 *
 *   BATCH_HMAC_KEY_HEX=<64+ hex chars> npm run batch -- [--out out/batch.jsonl] [--batch-id ID]
 *
 * The HMAC key must come from the secrets manager (Dev Spec §7). If it is not
 * set, a random throwaway key is used and the batch is marked NOT FOR PRODUCTION.
 * Uses the platform CSPRNG; swap in a RandomSource backed by the certified RNG
 * for production batches.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CryptoRandomSource, PAR_SHEET_3X3 } from '../src/index.js';
import { generateBatch } from '../src/node.js';

const args = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const out = arg('out', 'out/batch.jsonl');
const batchId = arg('batch-id', randomUUID());
const keyHex = process.env.BATCH_HMAC_KEY_HEX;
const key = keyHex ? Buffer.from(keyHex, 'hex') : randomBytes(32);
if (!keyHex) console.warn('WARNING: BATCH_HMAC_KEY_HEX not set — using a throwaway key. NOT FOR PRODUCTION.');

mkdirSync(dirname(out), { recursive: true });
const ws = createWriteStream(out);
const t0 = Date.now();
const res = generateBatch(PAR_SHEET_3X3, {
  batchId,
  hmacKey: key,
  rng: new CryptoRandomSource(),
  onTicket: (t) => ws.write(JSON.stringify(t) + '\n'),
});
ws.end();
await new Promise<void>((r) => ws.on('finish', () => r()));

console.log(`Batch ${batchId}: ${res.ticketCount.toLocaleString()} tickets in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
console.table(res.reconciliation.tiers.map((t) => ({ tier: t.symbol, expected: t.expected, actual: t.actual, payout: t.payoutCents / 100 })));
console.log(`Losers: ${res.reconciliation.losers.actual} / ${res.reconciliation.losers.expected}`);
console.log(`Total payout: ${(res.reconciliation.totalPayoutCents / 100).toFixed(2)}  RTP: ${(res.reconciliation.rtp * 100).toFixed(4)}%`);
console.log(`Integrity errors: ${res.integrityErrors}  Duplicate validation numbers: ${res.duplicateValidationNumbers}`);
console.log(`Batch status: ${res.ready ? 'READY' : 'NOT READY — ' + res.reconciliation.problems.join('; ')}`);
if (!res.ready) process.exitCode = 1;
