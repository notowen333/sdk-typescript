/**
 * Abstract base class for retry strategies.
 */

import { AfterModelCallEvent } from '../hooks/events.js'
import type { Plugin } from '../plugins/plugin.js'
import type { LocalAgent } from '../types/agent.js'

/**
 * Abstract base class for retry strategies.
 *
 * A {@link ModelRetryStrategy} is a {@link Plugin} that retries failed agent calls.
 * {@link ModelRetryStrategy.retryModel} is abstract: every subclass must declare
 * how it handles model failures (even if only as an empty method body).
 *
 * Future retry topics (e.g. `retryTool`) will be added as non-abstract
 * methods with no-op defaults so that introducing a new topic does not
 * break existing external `ModelRetryStrategy` subclasses.
 *
 * State scope: the base class does not define any turn- or invocation-level
 * reset hook. The retried unit is a single turn (one {@link AfterModelCallEvent}),
 * so any attempt counters or timers are owned by the subclass and cleared
 * inside {@link ModelRetryStrategy.retryModel} — typically on the success
 * branch and the non-retryable-error branch.
 *
 * Single-agent attachment: retry strategies typically carry per-turn state
 * (attempt counters, timers), so sharing one instance across two agents
 * would let their calls trample each other. The base class enforces this by
 * remembering the first agent it's attached to and throwing on attempts to
 * attach to a different one. Stateless strategies are unaffected (the guard
 * only fires when the caller tries to share an instance across agents,
 * regardless of whether that instance has state).
 */
export abstract class ModelRetryStrategy implements Plugin {
  /**
   * A stable string identifier for this retry strategy.
   */
  abstract readonly name: string

  private _attachedAgent: LocalAgent | undefined

  /**
   * Handle a post-model-call event. Set `event.retry = true` (typically after
   * an `await sleep(delayMs)`) to request that the agent re-invoke the model.
   * Return without setting `event.retry` to let the error propagate.
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
