import {
  InMemoryAudit,
  InMemoryPersistence,
  InMemoryWallet,
  PAR_SHEET_3X3,
  ScratchcardEngine,
  ScriptedRngProvider,
  formatCompact,
  type EngineOptions,
  type RngRequest,
  type UxMessage,
} from '../src/index.js';

export function randomValues(n: number): number[] {
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  return Array.from(a);
}

/** RNG that answers every request with fresh CSPRNG values in SCRNG1 format. */
export function liveRng(rngId = 'TEST-RNG') {
  return new ScriptedRngProvider((req: RngRequest, n) => formatCompact(rngId, String(n), req.requestId, randomValues(req.count)), rngId);
}

/**
 * Value sequence that makes the FinitePool model with a fresh 1,000,000 pool
 * land on `drawIndex` (first value), followed by `tail` filler values.
 */
export function valuesForDraw(drawIndex: number, tail: number[] = randomValues(31)): number[] {
  return [drawIndex, ...tail]; // drawIndex < 1e6 < rejection limit, and v % 1e6 === v
}

/** Draw indexes (fresh pool) that select each tier, in par-sheet cumulative order. */
export const DRAW = {
  A: 0,
  B: 150_000,
  C: 210_000,
  D: 240_000,
  E: 252_000,
  F: 258_000,
  G: 262_000,
  H: 264_000,
  I: 265_000,
  LOSE: 265_310,
} as const;

export function makeEngine(over: Partial<EngineOptions> = {}) {
  const persistence = (over.persistence as InMemoryPersistence) ?? new InMemoryPersistence();
  const wallet = (over.wallet as InMemoryWallet) ?? new InMemoryWallet(10_000);
  const audit = (over.audit as InMemoryAudit) ?? new InMemoryAudit();
  const messages: UxMessage[] = [];
  let n = 0;
  const engine = new ScratchcardEngine({
    rng: liveRng(),
    persistence,
    wallet,
    audit,
    ids: { newGameRoundId: () => `round-${++n}-${Math.random().toString(36).slice(2, 8)}` },
    onMessage: (m) => messages.push(m),
    ...over,
  });
  return { engine, persistence, wallet, audit, messages, ps: PAR_SHEET_3X3 };
}

export const types = (msgs: UxMessage[]) => msgs.map((m) => m.type);
