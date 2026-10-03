/**
 * RNG integration hooks.
 *
 * The engine never generates its own randomness for real-money play. Every
 * game outcome is derived from a result string supplied by an external,
 * GLI-19-certified RNG through the RngProvider hook below. The engine:
 *   1. builds an RngRequest (unique requestId per game),
 *   2. awaits RngProvider.getResult(request) → raw result string,
 *   3. optionally verifies it (RngResultVerifier — e.g. signature/HMAC),
 *   4. parses it (RngResultParser) into an RngResult,
 *   5. scales the raw values to game outcomes without bias (RandomStream).
 * The raw string is stored verbatim with the game record so the outcome can
 * be independently replayed by a test lab or regulator.
 */

export type RngPurpose = 'GAME_OUTCOME' | 'GAME_OUTCOME_TOPUP' | 'BATCH_GENERATION';

export interface RngRequest {
  /** Unique per request; the RNG result must echo it back (replay protection). */
  readonly requestId: string;
  readonly gameId: string;
  readonly gameRoundId: string;
  readonly purpose: RngPurpose;
  /** Number of 32-bit unsigned values requested. */
  readonly count: number;
  readonly requestedAt: string;
}

/**
 * THE HOOK: implement this to connect the certified RNG.
 * Return the RNG's result string exactly as received (no reformatting), so the
 * stored record is the RNG's own output.
 */
export interface RngProvider {
  /** Identifier of the RNG (e.g. certificate / instance id), recorded in each game. */
  readonly rngId: string;
  /** True only for sources that hold a GLI certification for production use. */
  readonly certified: boolean;
  getResult(request: RngRequest): Promise<string>;
}

/** A single parsed RNG response. */
export type RngResult = RngValuesResult | RngTicketResult;

interface RngResultBase {
  readonly format: string;
  readonly rngId: string;
  /** RNG-side sequence / draw number, if provided. */
  readonly sequence: string | null;
  /** requestId echoed back by the RNG. */
  readonly requestId: string;
}

/** Raw uniformly distributed 32-bit values; the engine scales them to outcomes. */
export interface RngValuesResult extends RngResultBase {
  readonly kind: 'values';
  readonly values: readonly number[];
}

/**
 * A pre-determined ticket supplied by a certified central system (e.g. a
 * pre-generated, pre-shuffled pool). The engine re-evaluates the grid
 * independently and refuses it if it breaks the game rules.
 */
export interface RngTicketResult extends RngResultBase {
  readonly kind: 'ticket';
  readonly ticketSerial: string;
  /** 9 symbol codes, row-major. */
  readonly grid: string;
  /** Tier the issuing system claims; cross-checked against the engine's evaluation. */
  readonly declaredSymbol: string | null;
}

/** Parses one vendor format. Return null if the string is not this format. */
export interface RngResultParser {
  readonly format: string;
  parse(raw: string): RngResult | null;
}

/** Optional authenticity check of the raw result (signature, HMAC, TLS-channel binding...). */
export interface RngResultVerifier {
  verify(raw: string, request: RngRequest): Promise<boolean> | boolean;
}

export class RngError extends Error {
  constructor(
    readonly code:
      | 'RNG_UNAVAILABLE'
      | 'RNG_TIMEOUT'
      | 'RNG_PARSE_FAILED'
      | 'RNG_VERIFY_FAILED'
      | 'RNG_REQUEST_MISMATCH'
      | 'RNG_EXHAUSTED'
      | 'RNG_UNCERTIFIED',
    message: string,
  ) {
    super(message);
    this.name = 'RngError';
  }
}
