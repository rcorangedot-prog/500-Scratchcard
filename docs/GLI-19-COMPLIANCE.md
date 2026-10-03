# GLI-19 / specification traceability

This matrix maps the GLI-19 game and RNG topic areas, plus the project acceptance criteria (Game Developer Specification §12), to where the engine implements each one and how it is verified. GLI-19 references are given by topic area (Chapter 3 RNG and Chapter 4 game requirements), not by clause number. The accredited test lab decides the final clause-by-clause mapping for the submitted version of the standard.

> **Not a certification.** Items marked *Host* or *Lab* are outside this engine. They have to be met by the platform or evidenced to the lab.

## RNG (GLI-19 Chapter 3 topics)

| Requirement | Implementation | Evidence |
|---|---|---|
| Outcomes come from a certified RNG | `RngProvider` hook. The engine refuses uncertified providers unless overridden (`requireCertifiedRng`) | `engine.test.ts` › refuses an uncertified RNG |
| Scaling introduces no bias | `scaleUniform` uses rejection sampling with exact integer ranges | `math.test.ts` › unbiased scaling |
| No discarding or altering of RNG output except by a documented scaling rule | The only discard is the documented rejection rule. Results are stored verbatim | `GameRecord.rng.rawResults` |
| RNG output authenticity and integrity | `RngResultVerifier` hook (`HmacResultVerifier` example). `requestId` and `rngId` echo check blocks replayed or misrouted results | `engine.test.ts` › signed results, request id mismatch, wrong RNG id |
| RNG failure handling | Timeout, unavailability or malformed output voids the game and refunds the stake | `engine.test.ts` › malfunction handling |
| Statistical testing of the RNG | **Lab.** `scripts/simulate.ts` and the HTML simulator battery are for development only. Re-run them on the certified RNG's captured output | – |

## Game requirements (GLI-19 Chapter 4 topics)

| Requirement | Implementation | Evidence |
|---|---|---|
| Outcome determined by the RNG before presentation. Presentation can't change it | Outcome is derived and persisted in `buyTicket()` before `TICKET_PURCHASED`. Reveal order has no effect | `engine.test.ts` › outcome independent of reveal order. Audit shows `OUTCOME_COMMITTED` before `CELL_REVEALED` |
| No early disclosure of the outcome | UX receives only revealed cells. Public views carry no grid before full reveal | `engine.test.ts` › never sends a symbol before its cell is revealed |
| Game rules, paytable and RTP disclosed | `getRules()`: how to play, paytable, odds, overall odds, RTP, max prize, malfunction clause | `engine.test.ts` › exposes rules |
| Fairness, with no near-miss manipulation | Fillers are uniformly random, not steered. No near-miss messaging | `math.test.ts` › filler symbols not steered |
| Accurate win evaluation | Independent `evaluateGrid` cross-checked against construction. Any disagreement voids the game | `math.test.ts` › grid construction. `engine.test.ts` › invalid pre-determined ticket |
| Losses not presented as wins | `winLevel = PARTIAL_RETURN` for prize < stake, with subdued text and cue | `engine.test.ts` › partial return |
| Malfunction voids all pays and plays | `voidGame()`: VOID record, refund, `MALFUNCTION` message. Clause shown in rules | `engine.test.ts` › malfunction handling |
| Interrupted game recovery | Persisted state is restored by `start()` to the same outcome and reveal state. Settlement is retried idempotently. `completeInterruptedGame()` | `engine.test.ts` › interrupted game recovery |
| Game recall / history | `getHistory()` keeps the last N (default 10) with grid, prize, timestamps and RNG references | `engine.test.ts` › history |
| Outcome reproducibility for disputes | `replay(record)` re-derives from the stored raw RNG strings | `engine.test.ts` › every completed game replays identically |
| Significant event logging | `AuditHook` events across the full cycle | `engine.test.ts` › audit trail |
| Configuration integrity | `validateParSheet` refuses mismatched totals. Persisted state is bound to game id, par-sheet version and model | `math.test.ts` › par sheet. `engine.test.ts` › refuses persisted state from a different version |
| Theoretical RTP matches the paytable | 75.00% exact. Fixed pool reconciles exactly | `math.test.ts` › full 1,000,000 cycle. `npm run simulate` |

## Game Developer Specification acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| AC-1 tier distribution exact | Met (fixed pool and batch) | `math.test.ts`, `batch.test.ts`, `npm run simulate`, `npm run batch` |
| AC-2 no multi-symbol conflicts | Met | grid tests, batch test (0 conflicts in 1M) |
| AC-3 RTP 75.0% | Met | same as AC-1 |
| AC-4 validation numbers non-guessable | Met in batch: HMAC-SHA256 with a per-batch secret. **Host:** key in a secrets manager, entropy testing | `batch.test.ts` |
| AC-5 unique validation numbers | Checked in generation. **Host:** DB unique constraint | `batch.test.ts` |
| AC-6 idempotent claims | Engine credits use idempotent transaction ids. **Host:** `/claim` service for printed tickets | `engine.test.ts` › retries a failed credit |
| AC-7 shuffle unpredictability | Unbiased Fisher-Yates. Decile spread test | `batch.test.ts` |
| AC-8 reconciliation report | `reconcile()` | `math.test.ts`, batch script |

## Open items (Host / Lab)

* Integrate the production certified RNG and its signing scheme, and provide its certificate reference (`rngId`).
* Durable `PersistenceHook` (transactional DB) and an idempotent `WalletHook` on the real wallet.
* Secrets management for HMAC keys. TLS 1.2+, RBAC, encryption at rest, pen test (Dev Spec §10).
* Platform-level GLI-19 items: player accounts, responsible gaming limits, financial transactions, security and operational audit.
* Software identification and signature verification of the released build (e.g. a hash of `dist/`) for lab submission.
* Lab statistical testing of the certified RNG output.
