# 500-Scratchcard: 3×3 Symbol Match game engine

This is a TypeScript game engine for the **3×3 Symbol Match** instant game. It follows GLI-19 and is built from the approved Par Sheet (`par_sheet_3x3_symbol_match.xlsx`), the Game Specification, the Game Developer Specification and the Developer Action List.

The engine:

* takes every game outcome from an **external, certified RNG result string** through a pluggable hook. It never uses `Math.random`.
* applies the game rules and logic (wager → outcome → reveal → evaluate → settle).
* tells the game's **UX** what to show and play through a typed, ordered message protocol.

It has no runtime dependencies. The core runs in Node and in the browser. Batch generation and HMAC tooling are Node-only.

```
              ┌──────────────── host platform ────────────────┐
              │ WalletHook   PersistenceHook   AuditHook        │
              └──────▲──────────────▲──────────────▲───────────┘
                     │              │              │
 Certified RNG ──►  RngProvider ──► ScratchcardEngine ──► UxMessage stream ──► Game UX
 (result string)    (+ verifier,     │  par sheet config                       (render only)
                     parser)         │  outcome model (fixed pool / weighted)      │
                                     │  grid builder + independent evaluator       │
                                     ◄──────── buyTicket / revealCell / revealAll ─┘
```

## Quick start

```bash
npm install
npm test                 # 58 tests, including a full 1,000,000-ticket pool and batch
npm run simulate         # 1M games through the live derivation path → exact reconciliation
npm run simulate -- --model WEIGHTED --games 1000000
npm run simulate -- --engine --games 100000     # end-to-end through the full engine
npm run batch            # Dev Spec §5 printed batch → out/batch.jsonl
npm run demo             # then open http://localhost:8080/demo/
```

```ts
import { ScratchcardEngine } from 'scratchcard-3x3-engine';

const engine = new ScratchcardEngine({
  rng: myCertifiedRng,          // RngProvider: the hook to the GLI-certified RNG
  wallet: myWallet,             // optional WalletHook
  persistence: myDurableStore,  // PersistenceHook (needed for recovery)
  audit: myAuditLog,            // optional AuditHook
  onMessage: (msg) => ux.handle(msg),
});

await engine.start();                       // validates par sheet, recovers interrupted game
await engine.buyTicket({ playerId: 'p1' }); // outcome fixed & persisted here
await engine.revealCell(4);                 // player scratches panel 4
await engine.revealAll();                   // or reveal the rest
```

---

## 1. RNG integration (the result-string hook)

Implement `RngProvider` to call your GLI-19 certified RNG:

```ts
import type { RngProvider, RngRequest } from 'scratchcard-3x3-engine';

export class CertifiedRng implements RngProvider {
  readonly rngId = 'GLI-RNG-07';     // must match the rngId inside each result string
  readonly certified = true;
  async getResult(req: RngRequest): Promise<string> {
    // req = { requestId, gameId, gameRoundId, purpose, count, requestedAt }
    return await rngClient.draw(req);   // return the raw string exactly as received
  }
}
```

For each game the engine:

1. Sends an `RngRequest` with a unique `requestId` (`<gameRoundId>:<n>`) asking for `count` (default 32) 32-bit values.
2. Optionally checks the raw string with an `RngResultVerifier`, such as a signature or HMAC (an `HmacResultVerifier` example is included).
3. Parses it with the registered `RngResultParser`s.
4. Rejects it unless the result echoes the same `requestId` and `rngId`. This blocks replayed or misrouted results.
5. Stores the raw string verbatim in the game record, so the outcome can be replayed later.

A game normally uses about 11 values. If a result runs short, the engine asks for a top-up (`purpose: 'GAME_OUTCOME_TOPUP'`, up to `maxRngTopUps`). It then re-derives the outcome from the full value sequence, so the outcome is always a pure function of the stored strings.

### Built-in result-string formats

| Format | Example |
|---|---|
| `SCRNG1` compact | `SCRNG1\|GLI-RNG-07\|000123\|<requestId>\|9f3a01c47be2…` (hex, 8 chars per uint32, big-endian) |
| `SCRNG-JSON/1` values | `{"format":"SCRNG-JSON/1","rngId":"GLI-RNG-07","sequence":"123","requestId":"…","values":[…]}` |
| `SCRNG-JSON/1` pre-determined ticket | `{"format":"SCRNG-JSON/1",…,"ticket":{"serial":"…","grid":"IIBCIDFGH","symbol":"I"}}` |

If your RNG vendor uses another wire format, write an `RngResultParser` (a single `parse(raw) → RngResult | null` function) and pass it as `parsers: [vendorParser]`. Nothing else changes.

**Pre-determined tickets.** If a certified central system issues whole tickets from a pre-shuffled pool, the engine counts the grid itself and refuses any ticket that breaks the rules. Examples are two triples, unknown symbols, or a declared tier that doesn't match the grid. You can switch this mode off with `acceptTicketResults: false`.

**Unbiased scaling.** `value % n` is biased. The engine uses rejection sampling instead (`scaleUniform`): values in the incomplete top bucket of 2³² are discarded, and this is deterministic, so replay still works.

**Certification guard.** The engine refuses to start with a provider that reports `certified: false` unless you pass `requireCertifiedRng: false`. `DevCryptoRngProvider` (Web Crypto CSPRNG) is uncertified and only for development and demos.

## 2. UX message protocol

The UX only presents. It sends player actions in, and renders `UxMessage`s that come out. It never decides win or loss (Dev Spec §9).

```ts
interface UxMessage {
  seq: number;          // strictly increasing — process in order
  type: UxMessageType;  // what happened
  messageId: string;    // localisation key (MESSAGE_CATALOG)
  text: string;         // default English text
  a11y: string;         // screen-reader text
  cue: string | null;   // animation/sound cue to play
  gameRoundId: string | null;
  timestamp: string;
  payload: {...};       // typed per message type (UxPayloads)
}
```

| `type` | When | Key payload | `cue` |
|---|---|---|---|
| `ENGINE_READY` | after `start()` | ticket price, model | `cue.ready` |
| `GAME_RECOVERED` | `start()` found an unfinished game | already-revealed cells, hidden indexes | `cue.recovered` |
| `TICKET_PURCHASED` | outcome committed (**no symbols**) | serial, stake, grid size, balance | `cue.ticket_purchase` |
| `CELL_REVEALED` | each panel scratched | index, row, col, symbol, iconRef, progress | `cue.scratch_cell` |
| `ALL_CELLS_REVEALED` | last panel revealed | full grid | – |
| `RESULT_WIN` | after full reveal | symbol, prize, `winningCells`, `winLevel` | by win level |
| `RESULT_NO_WIN` | after full reveal | stake | `cue.no_win` |
| `PRIZE_CREDITED` | wallet credited | prize, balance | `cue.prize_credited` |
| `SETTLEMENT_PENDING` | wallet credit failed (will retry) | prize, reason | `cue.settlement_pending` |
| `GAME_COMPLETE` | game closed | serial, prize | `cue.game_complete` |
| `INSUFFICIENT_FUNDS` | debit declined | stake, balance | `cue.error` |
| `ACTION_REJECTED` | invalid action (e.g. reveal twice) | action, reason | – |
| `MALFUNCTION` | RNG/integrity/persistence fault: game void, stake refunded | code, refunded | `cue.malfunction` |

`winLevel` sets how big the celebration is:

* `PARTIAL_RETURN`: the prize is less than the stake (Cherry pays $0.50 on a $1.00 ticket). It is shown quietly ("you get $0.50 back"), so a net loss is never presented as a win.
* `STAKE_BACK`, `WIN`, `BIG_WIN` (≥ 50× stake), `TOP_PRIZE`: increasingly strong presentation.

The engine never sends a symbol before that panel is revealed, and it has no "near miss" messages.

`engine.getRules()` returns the help screen content: how to play, the paytable with odds, overall odds (1 in 3.77), RTP (75.00%), maximum prize, and the disclosures (outcome is fixed at purchase, interrupted games are restored, malfunction voids all pays and plays).

## 3. Host hooks

| Hook | Contract |
|---|---|
| `WalletHook` | `debit` / `credit` / `refund`. Every call has a deterministic `transactionId` (`<round>:debit` and so on). **The wallet must be idempotent on it**, because the engine retries credits after a crash. |
| `PersistenceHook` | `save(snapshot)` must not resolve until the data is durable. The engine commits the outcome **before** telling the UX anything. If the commit fails, the game is voided and refunded. |
| `AuditHook` | Records significant events: wager, RNG request, raw RNG result, outcome committed, reveals, credit, void, pool cycle completed. |
| `ClockHook`, `IdHook` | Injectable time and round-id generation (for tests and platform IDs). |

In-memory versions (`InMemoryWallet`, `InMemoryPersistence`, `InMemoryAudit`) are included for development and tests.

## 4. Game cycle and recovery

```
IDLE ─buyTicket→ [debit] → [RNG → derive → evaluate] → COMMIT(persist) → IN_PROGRESS
IN_PROGRESS ─revealCell/revealAll→ … → REVEALED → [credit] → COMPLETE → IDLE
any fault before COMMIT → VOID (refund, MALFUNCTION)
```

* **One game at a time.** All actions run through a queue, so overlapping UX calls can't race. A new ticket is refused until the current one is settled.
* **Interrupted games.** After a crash, `start()` restores the in-progress game with its outcome and revealed panels unchanged, then emits `GAME_RECOVERED`. If the credit hadn't completed, it is retried idempotently. `completeInterruptedGame()` lets the host finish an abandoned ticket after a timeout.
* **Game recall.** `getHistory()` returns the last N games (default 10), newest first. Each record has its grid, prize, timestamps and the raw RNG strings.
* **Replay.** `engine.replay(record)` re-derives a game from its stored RNG strings, using the same pool state from before the draw, and reports any mismatch.

## 5. Game math

* **Par sheet** (`src/config/parSheet.ts`): transcribed from the workbook in integer cents. `validateParSheet` refuses to run unless the totals reconcile: 265,310 winners, $750,000 payout, 75.00% RTP.
* **Outcome models:**
  * `FINITE_POOL` (default, Game Spec §5 "fixed-pool"): each game draws uniformly from the tickets left in the current 1,000,000-ticket pool. That is the same as dealing the next ticket from a shuffled, pre-generated pool. A completed pool matches the Par Sheet **exactly**, and only 10 counters are persisted.
  * `WEIGHTED`: each game independently has exactly the par-sheet probability for every tier. This matches the HTML simulator's behaviour.
* **Grid construction:**
  * A winning grid places the tier symbol in 3 random cells.
  * All other cells are filled uniformly from symbols with fewer than 2 occurrences, so a second triple is impossible (AC-2).
  * Fillers are chance only, never steered toward near misses.
* **Independent evaluation:** every grid is re-counted before it is used. Two triples, an unknown symbol, or disagreement between construction and evaluation voids the game.

## 6. Batch generation (Dev Spec §5–7)

`generateBatch()` and `npm run batch` produce the printed or production pool:

1. Exact per-tier allocation.
2. Unbiased Fisher-Yates shuffle.
3. Grid construction.
4. Serials assigned after the shuffle.
5. `HMAC-SHA256(ticket_id|batch_id|tier)` validation numbers with a per-batch key from `BATCH_HMAC_KEY_HEX`, checked for uniqueness.
6. Reconciliation. The batch is marked `READY` only on an exact match.

## 7. Verification results (this repo, CSPRNG stand-in)

| Check | Result |
|---|---|
| FINITE_POOL, 1,000,000 games | all 9 tiers exact, RTP 75.0000%, 0 integrity errors (AC-1, AC-3) |
| WEIGHTED, 1,000,000 games | hit-frequency χ² p = 0.19, 0 integrity errors |
| Full engine path, 100,000 games | χ² p = 0.81, wallet reconciles, 0 malfunctions |
| Batch, 1,000,000 tickets | READY: exact reconciliation, 0 conflicts, 0 duplicate validation numbers |
| Unit/integration tests | 58 passing |

## 8. Differences from the HTML simulator

* `Math.random` is replaced by the RNG hook, and float threshold comparison is replaced by exact integer ranges with rejection sampling.
* Fillers are uniformly random (each symbol at most 2 times). The simulator always built "3 pairs + 3 singles", which makes pairs more common than chance would.
* The default model is the fixed pool from the Dev Spec. The simulator's per-play model is available as `WEIGHTED`.

## Scope and certification

This engine is written to meet the game-logic and RNG-integration requirements of GLI-19 and the project specifications. A GLI certificate is issued only by an accredited test lab evaluating the production system. That includes the certified RNG itself, the platform's account management, security, and operational controls, which sit outside this engine. See [`docs/GLI-19-COMPLIANCE.md`](docs/GLI-19-COMPLIANCE.md) for the requirement-to-implementation traceability and the open items.
