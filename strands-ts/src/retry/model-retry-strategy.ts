/**
 * Abstract base class for retry strategies.
 */

import { AfterModelCallEvent } from '../hooks/events.js'
import type { Plugin } from '../plugins/plugin.js'
import type { LocalAgent } from '../types/agent.js'

/**
 * Abstract base class for model-retry strategies.
 *
 * A {@link ModelRetryStrategy} is a {@link Plugin} that retries failed model
 * calls. {@link ModelRetryStrategy.retryModel} is abstract: every subclass
 * must declare how it handles model failures (even if only as an empty method
 * body). The method receives every `AfterModelCallEvent`, success or failure.
 *
 * Other retry kinds (e.g. tool retries) will land as *sibling* abstract
 * classes, not as additional methods on this one — different retry kinds
 * have different unit-of-work boundaries and don't share a single reset
 * contract.
 *
 * State scope: the base class does not define any reset hook. Per-turn
 * state ownership lives in the subclass; {@link DefaultModelRetryStrategy}
 * uses `event.attemptCount === 1` as its turn boundary.
 *
 * Single-agent attachment: instances typically carry per-turn state, so
 * sharing one instance across agents would let their calls trample each
 * other. The base class throws on attempts to attach to a different agent.
 */
export abstract class ModelRetryStrategy implements Plugin {
  /**
   * A stable string identifier for this retry strategy.
   */
  abstract readonly name: string

  private _attachedAgent: LocalAgent | undefined

  /**
   * Handle a post-model-call event. Fires for **every** {@link AfterModelCallEvent},
   * including successful completions (where `event.error` is undefined) — this
   * lets stateful subclasses use the success path as a turn-boundary signal
   * (e.g. to reset per-turn backoff state). Error events pass through the
   * same method; implementations typically branch on `event.error`.
   *
   * To request a retry, set `event.retry = true` (typically after an
   * `await sleep(delayMs)`). Returning without setting `event.retry` lets
   * the error propagate normally.
   *
   * Subclasses that don't retry model calls should implement this as an
   * empty method — the {@link AfterModelCallEvent} hook is registered by
   * the base class regardless.
   */
  abstract retryModel(event: AfterModelCallEvent): void | Promise<void>

  initAgent(agent: LocalAgent): void {
    if (this._attachedAgent !== undefined && this._attachedAgent !== agent) {
      throw new Error(
        `${this.constructor.name}: instance is already attached to another agent. ` +
          'Create a separate instance per agent.'
      )
    }
    this._attachedAgent = agent

    agent.addHook(AfterModelCallEvent, (event) => this.retryModel(event))
  }
}
