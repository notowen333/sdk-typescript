/**
 * Union type for all retry strategies accepted by the agent.
 */

import { logger } from '../logging/logger.js'
import type { ModelRetryStrategy } from './model-retry-strategy.js'

/**
 * Any retry strategy accepted by the agent.
 */
// Today this only admits model retries. Future retry kinds (e.g. tool retries)
// will be added as additional arms of this union.
export type RetryStrategy = ModelRetryStrategy

/**
 * Emit a warning for each duplicate-type retry strategy in the list.
 *
 * Two strategies of the same concrete class share the same `plugin.name`
 * and would otherwise collide in the plugin registry. This is a warning,
 * not an error — the caller decides how to handle duplicates (e.g. keep
 * the first, drop the rest).
 */
export function warnOnDuplicateRetryStrategyTypes(strategies: readonly RetryStrategy[]): void {
  const seen = new Set<new (...args: never[]) => RetryStrategy>()
  for (const strategy of strategies) {
    const ctor = strategy.constructor as new (...args: never[]) => RetryStrategy
    if (seen.has(ctor)) {
      logger.warn(`retry_strategy_type=<${ctor.name}> | multiple instances provided; only the first will be used`)
    } else {
      seen.add(ctor)
    }
  }
}
