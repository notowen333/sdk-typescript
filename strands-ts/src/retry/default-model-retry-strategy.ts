/**
 * Retry strategy for model invocations.
 *
 * Overrides {@link ModelRetryStrategy.retryModel} to retry failed model calls.
 * The attempt counter lives on {@link AfterModelCallEvent.attemptCount},
 * maintained by the agent loop. This strategy only keeps per-turn backoff
 * state (first-failure timestamp, last delay), which is cleared on the
 * first attempt of each new turn (detected via `event.attemptCount === 1`).
 */

import type { AfterModelCallEvent } from '../hooks/events.js'
import { ModelThrottledError } from '../errors.js'
import { logger } from '../logging/logger.js'
import type { BackoffContext, BackoffStrategy } from './backoff-strategy.js'
import { ExponentialBackoff } from './backoff-strategy.js'
import { ModelRetryStrategy } from './model-retry-strategy.js'

const DEFAULT_MAX_ATTEMPTS = 6
const DEFAULT_BACKOFF_BASE_MS = 4_000
const DEFAULT_BACKOFF_MAX_MS = 240_000

/**
 * Options for {@link DefaultModelRetryStrategy}.
 */
export interface DefaultModelRetryStrategyOptions {
  /**
   * Total model attempts before giving up and re-raising the error.
   * Must be \>= 1. Default {@link DEFAULT_MAX_ATTEMPTS}.
   */
  maxAttempts?: number
  /**
   * Backoff used to compute the delay between retries.
   * Default: `new ExponentialBackoff({ baseMs: DEFAULT_BACKOFF_BASE_MS, maxMs: DEFAULT_BACKOFF_MAX_MS })`.
   */
  backoff?: BackoffStrategy
}

/**
 * Retries failed model calls classified by the SDK as retryable.
 *
 * Today, only {@link ModelThrottledError} is treated as retryable. The set of
 * retryable errors may grow over time (e.g. transient server errors) without
 * requiring changes to this class's public API.
 *
 * State is per-turn: backoff timing state resets on the first attempt of
 * each new turn. The attempt counter itself is owned by the agent loop and
 * read off {@link AfterModelCallEvent.attemptCount}.
 *
 * Hook precedence: {@link AfterModelCallEvent} fires hooks in reverse registration
 * order, so user-registered hooks run before this strategy. If a user hook sets
 * `event.retry = true` first, this strategy returns early and does not stack
 * additional backoff on top.
 *
 * Sharing: a given instance tracks its own backoff state and must not be shared
 * across multiple agents. Create a separate instance per agent.
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   model,
 *   retryStrategy: new DefaultModelRetryStrategy({ maxAttempts: 4 }),
 * })
 * ```
 */
export class DefaultModelRetryStrategy extends ModelRetryStrategy {
  readonly name = 'strands:model-retry-strategy'

  private readonly _maxAttempts: number
  private readonly _backoff: BackoffStrategy

  private _lastDelayMs: number | undefined
  private _firstFailureAt: number | undefined

  constructor(opts: DefaultModelRetryStrategyOptions = {}) {
    super()
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error(`DefaultModelRetryStrategy: maxAttempts must be an integer >= 1 (got ${maxAttempts})`)
    }
    this._maxAttempts = maxAttempts
    this._backoff =
      opts.backoff ?? new ExponentialBackoff({ baseMs: DEFAULT_BACKOFF_BASE_MS, maxMs: DEFAULT_BACKOFF_MAX_MS })
  }

  override async retryModel(event: AfterModelCallEvent): Promise<void> {
    // Another hook already requested retry — don't stack a second delay on top.
    if (event.retry) return

    // Clear any state left over from a prior turn at the turn boundary.
    if (event.attemptCount === 1) this._reset()

    if (event.error === undefined) return
    if (!this._isRetryable(event.error)) return

    if (event.attemptCount >= this._maxAttempts) {
      logger.debug(
        `attempt_count=<${event.attemptCount}> max_attempts=<${this._maxAttempts}> | max retry attempts reached`
      )
      return
    }

    if (this._firstFailureAt === undefined) {
      this._firstFailureAt = Date.now()
    }

    // Per-error-class backoff selection is a future extension; today every
    // retryable error uses the single configured backoff.
    const delayMs = this._backoff.nextDelay(this._buildContext(event.attemptCount))

    logger.debug(
      `retry_delay_ms=<${delayMs}> attempt_count=<${event.attemptCount}> max_attempts=<${this._maxAttempts}> ` +
        `| retryable model error, delaying before retry`
    )

    await sleep(delayMs)

    this._lastDelayMs = delayMs
    event.retry = true
  }

  private _buildContext(attemptCount: number): BackoffContext {
    const ctx: BackoffContext = {
      attempt: attemptCount,
      elapsedMs: this._firstFailureAt === undefined ? 0 : Date.now() - this._firstFailureAt,
    }
    if (this._lastDelayMs !== undefined) {
      ctx.lastDelayMs = this._lastDelayMs
    }
    return ctx
  }

  private _isRetryable(error: Error): boolean {
    return error instanceof ModelThrottledError
  }

  private _reset(): void {
    this._lastDelayMs = undefined
    this._firstFailureAt = undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}
