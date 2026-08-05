/**
 * The Codex price table — a quarantined hellscape, and deliberately its own file.
 *
 * It exists only because the Codex CLI, unlike Claude, declines to report any
 * USD figure in its stream: `codex exec --json` emits token counts and nothing
 * else (verified Aug 2026). So JFDI multiplies tokens by these rates itself.
 *
 * These numbers rot. They are OpenAI list prices, hand-transcribed, and they
 * change without warning. When a Codex cost shows up as `unknown` downstream,
 * that is this table saying "update me" — a model it does not know, priced at
 * nothing rather than at a fabricated number. Extend it here, nowhere else:
 * this is the only place rates live.
 *
 * Rates verified 2026-08-03 against openai.com (last changed 2026-07-30: Terra
 * −20%, Luna −80%). Cached input is 10% of input across all tiers. USD per 1M
 * tokens. Covers exactly the three GPT-5.6 varieties and nothing else.
 *
 * Two dimensions of OpenAI's 5.6 pricing this table deliberately does NOT model,
 * because Codex's stream reports no counts to drive them:
 *
 *   - **Cache writes.** 5.6 prices a cache *write* between input and cache read
 *     (sol $6.25, terra $2.50, luna $0.25 per 1M — a ~25% premium over input).
 *     But `codex exec --json` reports only `input_tokens` and its cache-*read*
 *     subset `cached_input_tokens`; there is no write counter (OpenAI's Responses
 *     `usage` exposes cached reads only, unlike Anthropic's cache-creation field).
 *     So write tokens are billed here at the plain input rate.
 *   - **Short vs long context.** 5.6 charges more once a *request's* context
 *     passes 272K tokens. Codex reports only cumulative session totals, not
 *     per-request context sizes, so the tier cannot be reconstructed. These are
 *     the short-context (≤272K) rates — the common case.
 *
 * Both gaps make the figure a slight *under*estimate when they apply, which is
 * consistent with what this number is: an approximate, comparison-grade cost,
 * not a bill. Add write/long-context handling only if Codex ever reports the
 * counts; until then, modeling them would be inventing data.
 */

/** USD per one million tokens, per rate class. */
interface ModelRates {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

const TOKENS_PER_MILLION = 1_000_000;

const CODEX_RATES: Readonly<Record<string, ModelRates>> = {
  "gpt-5.6-sol": { inputPerMillion: 5.0, cachedInputPerMillion: 0.5, outputPerMillion: 30.0 },
  "gpt-5.6-terra": { inputPerMillion: 2.0, cachedInputPerMillion: 0.2, outputPerMillion: 12.0 },
  "gpt-5.6-luna": { inputPerMillion: 0.2, cachedInputPerMillion: 0.02, outputPerMillion: 1.2 },
};

/** The token counts a price depends on. Cached input is a subset of input. */
export interface BillableTokens {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Dollars for a Codex session, or null when the model is not in the table
 * ("unknown" — the signal to update it, never a guessed number).
 *
 * Cached input is billed at the discount rate and is a subset of input, so the
 * uncached remainder pays the full rate. Output is billed as the provider
 * counts it: Codex's output count already includes reasoning tokens (see the
 * decision logged on the ticket), so reasoning is not added on top here — doing
 * so would double-bill every reasoning session.
 */
export function codexCostUsd(model: string | undefined, tokens: BillableTokens): number | null {
  if (model === undefined) return null;
  const rates = CODEX_RATES[model.toLowerCase()];
  if (rates === undefined) return null;
  const uncachedInput = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens);
  const dollars =
    (uncachedInput * rates.inputPerMillion +
      tokens.cachedInputTokens * rates.cachedInputPerMillion +
      tokens.outputTokens * rates.outputPerMillion) /
    TOKENS_PER_MILLION;
  return dollars;
}
