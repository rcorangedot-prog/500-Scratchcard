import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DevCryptoRngProvider,
  InMemoryWallet,
  RngError,
  ScratchcardEngine,
  ScriptedRngProvider,
  compactParser,
  formatCompact,
  type UxMessage,
  type WalletHook,
} from '../src/index.js';
import { HmacResultVerifier, stripSignature } from '../src/node.js';
import { DRAW, makeEngine, randomValues, types, valuesForDraw } from './helpers.js';

/** RNG that forces the first game's tier via the draw index. */
function forcedRng(drawIndex: number, rngId = 'TEST-RNG') {
  return new ScriptedRngProvider((req, n) =>
    formatCompact(rngId, String(n), req.requestId, n === 1 ? valuesForDraw(drawIndex) : randomValues(req.count)),
  );
}

describe('engine: start-up', () => {
  it('refuses an uncertified RNG unless explicitly allowed', async () => {
    const { engine } = makeEngine({ rng: new DevCryptoRngProvider() });
    await assert.rejects(engine.start(), (e: RngError) => e.code === 'RNG_UNCERTIFIED');
    const ok = makeEngine({ rng: new DevCryptoRngProvider(), requireCertifiedRng: false });
    await ok.engine.start();
    assert.equal(ok.messages[0]!.type, 'ENGINE_READY');
  });

  it('rejects actions before start()', async () => {
    const { engine } = makeEngine();
    await assert.rejects(engine.buyTicket(), /not started/);
  });

  it('exposes rules, paytable and RTP disclosure', async () => {
    const { engine } = makeEngine();
    const r = engine.getRules();
    assert.equal(r.paytable.length, 9);
    assert.equal(r.returnToPlayer, '75.00%');
    assert.equal(r.overallOdds, '1 in 3.77');
    assert.equal(r.paytable[8]!.prize, '$500.00');
    assert.equal(r.paytable[8]!.odds, '1 in 3225.81');
    assert.ok(r.notes.some((n) => /Malfunction voids all pays and plays/.test(n)));
  });
});

describe('engine: game cycle and UX messages', () => {
  it('runs a full winning game with the correct message sequence', async () => {
    const { engine, messages, wallet } = makeEngine({ rng: forcedRng(DRAW.G) });
    await engine.start();
    const view = await engine.buyTicket({ playerId: 'p1' });
    assert.ok(view);
    assert.equal(wallet.balanceCents, 10_000 - 100);
    for (let i = 0; i < 9; i++) await engine.revealCell(i);

    assert.deepEqual(types(messages), [
      'ENGINE_READY',
      'TICKET_PURCHASED',
      ...Array(9).fill('CELL_REVEALED'),
      'ALL_CELLS_REVEALED',
      'RESULT_WIN',
      'PRIZE_CREDITED',
      'GAME_COMPLETE',
    ]);
    const win = messages.find((m) => m.type === 'RESULT_WIN') as UxMessage<'RESULT_WIN'>;
    assert.equal(win.payload.winningSymbol, 'G');
    assert.equal(win.payload.prizeCents, 5_000);
    assert.equal(win.payload.winLevel, 'BIG_WIN');
    assert.equal(win.cue, 'cue.win_big');
    assert.equal(win.text, 'Big win! Three Crown symbols — you win $50.00!');
    assert.equal(wallet.balanceCents, 10_000 - 100 + 5_000);
    assert.equal(engine.getStatus().status, 'IDLE');
    // seq is strictly increasing
    messages.forEach((m, i) => assert.equal(m.seq, i + 1));
  });

  it('never sends a symbol before its cell is revealed', async () => {
    const { engine, messages } = makeEngine({ rng: forcedRng(DRAW.I) });
    await engine.start();
    const view = await engine.buyTicket();
    const purchased = messages.find((m) => m.type === 'TICKET_PURCHASED')!;
    const leak = /"symbol"|"grid"|IIB|Jackpot/;
    assert.doesNotMatch(JSON.stringify(purchased), leak);
    assert.doesNotMatch(JSON.stringify(view), /"symbol"/);
    assert.equal(view!.result, null);
    await engine.revealCell(4);
    const cells = messages.filter((m) => m.type === 'CELL_REVEALED') as UxMessage<'CELL_REVEALED'>[];
    assert.equal(cells.length, 1);
    assert.equal(cells[0]!.payload.index, 4);
    const status = engine.getStatus();
    assert.equal(status.game!.revealedCells.length, 1);
    assert.equal(status.game!.hiddenCellIndexes.length, 8);
    assert.equal(status.game!.result, null);
  });

  it('top prize uses the top-prize presentation', async () => {
    const { engine, messages } = makeEngine({ rng: forcedRng(DRAW.I) });
    await engine.start();
    await engine.buyTicket();
    await engine.revealAll();
    const win = messages.find((m) => m.type === 'RESULT_WIN') as UxMessage<'RESULT_WIN'>;
    assert.equal(win.payload.winLevel, 'TOP_PRIZE');
    assert.equal(win.messageId, 'MSG_WIN_TOP_PRIZE');
    assert.equal(win.payload.prizeCents, 50_000);
    assert.equal(win.payload.winningCells.length, 3);
  });

  it('a prize below the stake is a partial return, not a celebrated win', async () => {
    const { engine, messages } = makeEngine({ rng: forcedRng(DRAW.A) });
    await engine.start();
    await engine.buyTicket();
    await engine.revealAll();
    const win = messages.find((m) => m.type === 'RESULT_WIN') as UxMessage<'RESULT_WIN'>;
    assert.equal(win.payload.winLevel, 'PARTIAL_RETURN');
    assert.equal(win.cue, 'cue.win_partial_return');
    assert.doesNotMatch(win.text, /win|!/i);
  });

  it('losing game: RESULT_NO_WIN, no credit', async () => {
    const { engine, messages, wallet } = makeEngine({ rng: forcedRng(DRAW.LOSE) });
    await engine.start();
    await engine.buyTicket();
    await engine.revealAll();
    assert.ok(types(messages).includes('RESULT_NO_WIN'));
    assert.ok(!types(messages).includes('PRIZE_CREDITED'));
    assert.equal(wallet.balanceCents, 9_900);
  });

  it('rejects invalid actions with ACTION_REJECTED', async () => {
    const { engine, messages } = makeEngine();
    await engine.start();
    await engine.revealCell(0);
    await engine.buyTicket();
    await engine.buyTicket(); // game in progress
    await engine.revealCell(9);
    await engine.revealCell(-1);
    await engine.revealCell(1.5);
    await engine.revealCell(0);
    await engine.revealCell(0); // already revealed
    const reasons = (messages.filter((m) => m.type === 'ACTION_REJECTED') as UxMessage<'ACTION_REJECTED'>[]).map(
      (m) => m.payload.reason,
    );
    assert.deepEqual(reasons, [
      'NO_GAME_IN_PROGRESS',
      'GAME_IN_PROGRESS',
      'INVALID_CELL',
      'INVALID_CELL',
      'INVALID_CELL',
      'ALREADY_REVEALED',
    ]);
  });

  it('insufficient funds: no RNG call, no game', async () => {
    const rng = forcedRng(DRAW.A);
    const { engine, messages } = makeEngine({ rng, wallet: new InMemoryWallet(50) });
    await engine.start();
    assert.equal(await engine.buyTicket(), null);
    assert.equal(messages.at(-1)!.type, 'INSUFFICIENT_FUNDS');
    assert.equal(rng.requests.length, 0);
  });

  it('serialises concurrent reveal calls', async () => {
    const { engine, messages } = makeEngine();
    await engine.start();
    await engine.buyTicket();
    await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8, 0].map((i) => engine.revealCell(i)));
    assert.equal(messages.filter((m) => m.type === 'CELL_REVEALED').length, 9);
    assert.equal(messages.filter((m) => m.type === 'GAME_COMPLETE').length, 1);
  });

  it('outcome is independent of reveal order', async () => {
    const values = valuesForDraw(DRAW.D);
    const rng = () => new ScriptedRngProvider((req) => formatCompact('TEST-RNG', '1', req.requestId, values));
    const runWith = async (order: number[]) => {
      const { engine } = makeEngine({ rng: rng() });
      await engine.start();
      await engine.buyTicket();
      for (const i of order) await engine.revealCell(i);
      return engine.getHistory()[0]!;
    };
    const a = await runWith([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const b = await runWith([8, 4, 0, 7, 3, 6, 2, 5, 1]);
    assert.deepEqual(a.grid, b.grid);
    assert.equal(a.prizeCents, 500);
  });
});

describe('engine: interrupted game recovery', () => {
  it('restores the same outcome and reveal state after a restart', async () => {
    const first = makeEngine({ rng: forcedRng(DRAW.H) });
    await first.engine.start();
    await first.engine.buyTicket();
    await first.engine.revealCell(0);
    await first.engine.revealCell(5);
    const before = first.engine.getStatus().game!;

    // "crash": new engine instance over the same persistence + wallet
    const second = makeEngine({ persistence: first.persistence, wallet: first.wallet, rng: forcedRng(DRAW.LOSE) });
    await second.engine.start();
    const rec = second.messages.find((m) => m.type === 'GAME_RECOVERED') as UxMessage<'GAME_RECOVERED'>;
    assert.ok(rec);
    assert.deepEqual(
      rec.payload.revealedCells.map((c) => c.index),
      [0, 5],
    );
    assert.deepEqual(rec.payload.revealedCells, before.revealedCells);
    assert.equal(rec.payload.hiddenCellIndexes.length, 7);
    await second.engine.revealAll();
    const win = second.messages.find((m) => m.type === 'RESULT_WIN') as UxMessage<'RESULT_WIN'>;
    assert.equal(win.payload.winningSymbol, 'H'); // original outcome, not the new RNG's
    assert.equal(second.wallet.balanceCents, 10_000 - 100 + 10_000);
  });

  it('host can auto-complete an abandoned game', async () => {
    const { engine, messages, wallet } = makeEngine({ rng: forcedRng(DRAW.E) });
    await engine.start();
    await engine.buyTicket();
    await engine.completeInterruptedGame();
    assert.equal(engine.getStatus().status, 'IDLE');
    assert.ok(types(messages).includes('GAME_COMPLETE'));
    assert.equal(wallet.balanceCents, 10_000 - 100 + 1_000);
  });

  it('retries a failed credit idempotently and blocks new tickets until settled', async () => {
    const inner = new InMemoryWallet(1_000);
    let failCredit = true;
    const wallet: WalletHook = {
      debit: (tx) => inner.debit(tx),
      refund: (tx) => inner.refund(tx),
      credit: async (tx) => (failCredit ? { ok: false, reason: 'ERROR' } : inner.credit(tx)),
    };
    const { engine, messages } = makeEngine({ rng: forcedRng(DRAW.F), wallet });
    await engine.start();
    await engine.buyTicket();
    await engine.revealAll();
    assert.equal(messages.at(-1)!.type, 'SETTLEMENT_PENDING');
    assert.equal(engine.getStatus().status, 'REVEALED');
    await engine.buyTicket();
    assert.equal((messages.at(-1) as UxMessage<'ACTION_REJECTED'>).payload.reason, 'GAME_IN_PROGRESS');
    failCredit = false;
    assert.equal(await engine.retrySettlement(), true);
    assert.equal(inner.balanceCents, 1_000 - 100 + 2_000);
    assert.equal(await engine.retrySettlement(), false); // nothing pending; no double pay
    assert.equal(inner.balanceCents, 2_900);
  });

  it('refuses persisted state from a different par sheet version', async () => {
    const a = makeEngine();
    await a.engine.start();
    await a.engine.buyTicket();
    const b = makeEngine({
      persistence: a.persistence,
      parSheet: { ...a.ps, parSheetVersion: '2.0' },
    });
    await assert.rejects(b.engine.start(), /persisted state/);
  });
});

describe('engine: malfunction handling (voids and refunds)', () => {
  const cases: [string, ScriptedRngProvider, string][] = [
    ['RNG throws', new ScriptedRngProvider(() => { throw new Error('socket closed'); }), 'RNG_UNAVAILABLE'],
    ['malformed string', new ScriptedRngProvider(() => 'not-a-result'), 'RNG_PARSE_FAILED'],
    [
      'request id mismatch (replayed result)',
      new ScriptedRngProvider(() => formatCompact('TEST-RNG', '1', 'some-other-request', randomValues(32))),
      'RNG_REQUEST_MISMATCH',
    ],
    [
      'wrong RNG id',
      new ScriptedRngProvider((req) => formatCompact('ROGUE', '1', req.requestId, randomValues(32))),
      'RNG_REQUEST_MISMATCH',
    ],
    [
      'invalid pre-determined ticket (two triples)',
      new ScriptedRngProvider(
        (req) =>
          `{"format":"SCRNG-JSON/1","rngId":"TEST-RNG","requestId":"${req.requestId}","ticket":{"serial":"X1","grid":"AAABBBCDE"}}`,
      ),
      'OUTCOME_INTEGRITY',
    ],
    [
      'ticket whose declared tier disagrees with its grid',
      new ScriptedRngProvider(
        (req) =>
          `{"format":"SCRNG-JSON/1","rngId":"TEST-RNG","requestId":"${req.requestId}","ticket":{"serial":"X2","grid":"ABCDEFGHI","symbol":"I"}}`,
      ),
      'OUTCOME_INTEGRITY',
    ],
  ];

  for (const [name, rng, code] of cases) {
    it(`${name} → ${code}, game void, stake refunded`, async () => {
      const { engine, messages, wallet } = makeEngine({ rng });
      await engine.start();
      assert.equal(await engine.buyTicket(), null);
      const m = messages.at(-1) as UxMessage<'MALFUNCTION'>;
      assert.equal(m.type, 'MALFUNCTION');
      assert.equal(m.payload.code, code);
      assert.equal(m.payload.stakeRefunded, true);
      assert.equal(wallet.balanceCents, 10_000);
      assert.ok(!types(messages).includes('TICKET_PURCHASED'));
      const h = engine.getHistory()[0]!;
      assert.equal(h.status, 'VOID');
      assert.equal(h.grid, null);
      assert.equal(engine.getStatus().status, 'IDLE');
    });
  }

  it('RNG timeout voids the game', async () => {
    const rng = new ScriptedRngProvider(() => new Promise<string>(() => {}));
    const { engine, messages } = makeEngine({ rng, rngTimeoutMs: 30 });
    await engine.start();
    await engine.buyTicket();
    assert.equal((messages.at(-1) as UxMessage<'MALFUNCTION'>).payload.code, 'RNG_TIMEOUT');
  });

  it('persistence failure before commit voids the game and rolls back the pool', async () => {
    const { engine, messages, persistence, wallet } = makeEngine();
    await engine.start();
    const save = persistence.save.bind(persistence);
    persistence.save = async () => {
      throw new Error('disk full');
    };
    await engine.buyTicket();
    persistence.save = save;
    assert.equal(messages.at(-1)!.type, 'MALFUNCTION');
    assert.equal(wallet.balanceCents, 10_000);
    // a following game works and the pool counted only that one
    await engine.buyTicket();
    await engine.revealAll();
    const snap = await persistence.load();
    const remaining = Object.values(snap!.pool!.remaining).reduce((a, b) => a + b, 0);
    assert.equal(remaining, 999_999);
  });

  it('signed results: verifier rejects tampering', async () => {
    const key = new Uint8Array(32).fill(1);
    const rng = new ScriptedRngProvider((req) => {
      const signed = HmacResultVerifier.sign(key, formatCompact('TEST-RNG', '1', req.requestId, randomValues(32)));
      return signed.replace(/\|([0-9a-f]{8})/, '|00000000'); // tamper with first value
    });
    const { engine, messages } = makeEngine({
      rng,
      verifier: new HmacResultVerifier(key),
      parsers: [stripSignature(compactParser)],
    });
    await engine.start();
    await engine.buyTicket();
    assert.equal((messages.at(-1) as UxMessage<'MALFUNCTION'>).payload.code, 'RNG_VERIFY_FAILED');

    const good = new ScriptedRngProvider((req) =>
      HmacResultVerifier.sign(key, formatCompact('TEST-RNG', '1', req.requestId, randomValues(32))),
    );
    const ok = makeEngine({ rng: good, verifier: new HmacResultVerifier(key), parsers: [stripSignature(compactParser)] });
    await ok.engine.start();
    assert.ok(await ok.engine.buyTicket());
  });
});

describe('engine: RNG top-up, ticket mode, replay, history', () => {
  it('requests more RNG values when a result is too short', async () => {
    const rng = new ScriptedRngProvider((req, n) =>
      formatCompact('TEST-RNG', String(n), req.requestId, n === 1 ? [DRAW.I, 0, 1] : randomValues(req.count)),
    );
    const { engine } = makeEngine({ rng });
    await engine.start();
    await engine.buyTicket();
    await engine.revealAll();
    assert.equal(rng.requests.length, 2);
    assert.equal(rng.requests[1]!.purpose, 'GAME_OUTCOME_TOPUP');
    const rec = engine.getHistory()[0]!;
    assert.equal(rec.rng.rawResults.length, 2);
    assert.equal(rec.winningSymbol, 'I');
    assert.ok(engine.replay(rec).matches);
  });

  it('accepts a valid pre-determined ticket from the RNG/central system', async () => {
    const rng = new ScriptedRngProvider(
      (req) =>
        `{"format":"SCRNG-JSON/1","rngId":"TEST-RNG","sequence":"77","requestId":"${req.requestId}","ticket":{"serial":"CENTRAL-000042","grid":"IIBCIDFGH","symbol":"I"}}`,
    );
    const { engine, messages } = makeEngine({ rng });
    await engine.start();
    const v = await engine.buyTicket();
    assert.equal(v!.ticketSerial, 'CENTRAL-000042');
    await engine.revealAll();
    const win = messages.find((m) => m.type === 'RESULT_WIN') as UxMessage<'RESULT_WIN'>;
    assert.deepEqual(win.payload.winningCells, [0, 1, 4]);
  });

  it('ticket results can be disabled', async () => {
    const rng = new ScriptedRngProvider(
      (req) =>
        `{"format":"SCRNG-JSON/1","rngId":"TEST-RNG","requestId":"${req.requestId}","ticket":{"serial":"S","grid":"ABCDEFGHI"}}`,
    );
    const { engine, messages } = makeEngine({ rng, acceptTicketResults: false });
    await engine.start();
    await engine.buyTicket();
    assert.equal(messages.at(-1)!.type, 'MALFUNCTION');
  });

  it('every completed game replays identically from its stored RNG strings (both models)', async () => {
    for (const outcomeModel of ['FINITE_POOL', 'WEIGHTED'] as const) {
      const { engine } = makeEngine({ outcomeModel, historySize: 50, wallet: new InMemoryWallet(1_000_000) });
      await engine.start();
      for (let i = 0; i < 40; i++) {
        await engine.buyTicket();
        await engine.revealAll();
      }
      const h = engine.getHistory();
      assert.equal(h.length, 40);
      for (const rec of h) {
        const r = engine.replay(rec);
        assert.ok(r.matches, r.differences.join('; '));
      }
      // tampering is detected
      const forged = structuredClone(h[0]!);
      forged.prizeCents += 100;
      assert.equal(engine.replay(forged).matches, false);
    }
  });

  it('history keeps the last N games, newest first, with RNG audit data', async () => {
    const { engine } = makeEngine({ historySize: 10 });
    await engine.start();
    const serials: string[] = [];
    for (let i = 0; i < 12; i++) {
      serials.push((await engine.buyTicket())!.ticketSerial);
      await engine.revealAll();
    }
    const h = engine.getHistory();
    assert.equal(h.length, 10);
    assert.deepEqual(
      h.map((g) => g.ticketSerial),
      serials.slice(2).reverse(),
    );
    assert.ok(h.every((g) => g.status === 'COMPLETE' && g.rng.rawResults.length >= 1 && g.timestamps.completedAt));
  });

  it('audit trail records the full cycle', async () => {
    const { engine, audit } = makeEngine({ rng: forcedRng(DRAW.B) });
    await engine.start();
    await engine.buyTicket();
    await engine.revealAll();
    const t = audit.events.map((e) => e.type);
    for (const k of [
      'ENGINE_STARTED',
      'WAGER_ACCEPTED',
      'RNG_REQUESTED',
      'RNG_RESULT_RECEIVED',
      'OUTCOME_COMMITTED',
      'CELL_REVEALED',
      'GAME_REVEALED',
      'PRIZE_CREDITED',
      'GAME_COMPLETED',
    ] as const)
      assert.ok(t.includes(k), k);
    // outcome committed strictly before any reveal
    assert.ok(t.indexOf('OUTCOME_COMMITTED') < t.indexOf('CELL_REVEALED'));
  });

  it('WEIGHTED model: plays, persists no pool, and discloses per-ticket odds', async () => {
    const { engine, persistence } = makeEngine({ outcomeModel: 'WEIGHTED' });
    await engine.start();
    await engine.buyTicket();
    await engine.revealAll();
    const snap = await persistence.load();
    assert.equal(snap!.outcomeModel, 'WEIGHTED');
    assert.equal(snap!.pool, null);
    assert.ok(engine.getRules().notes.some((n) => /probability of each prize on every ticket/.test(n)));
    // a FINITE_POOL engine must refuse WEIGHTED state
    const other = new ScratchcardEngine({ rng: engine['opts'].rng, persistence });
    await assert.rejects(other.start(), /outcome model/);
  });
});
