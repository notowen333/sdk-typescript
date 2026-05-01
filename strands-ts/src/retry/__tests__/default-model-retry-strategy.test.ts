// Tests use vi.useFakeTimers() so the internal `await sleep(...)` never waits
// real wall time — timers are advanced manually with vi.advanceTimersByTimeAsync.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DefaultModelRetryStrategy } from '../default-model-retry-strategy.js'
import { ModelRetryStrategy } from '../model-retry-strategy.js'
import { ConstantBackoff, type BackoffStrategy } from '../backoff-strategy.js'
import { AfterModelCallEvent } from '../../hooks/events.js'
import { ModelThrottledError } from '../../errors.js'
import { createMockAgent, invokeTrackedHook, type MockAgent } from '../../__fixtures__/agent-helpers.js'

function makeErrorEvent(agent: MockAgent, error: Error, attemptCount: number): AfterModelCallEvent {
  return new AfterModelCallEvent({ agent, model: {} as never, attemptCount, error, invocationState: {} })
}

describe('DefaultModelRetryStrategy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers an AfterModelCallEvent hook', () => {
    const strategy = new DefaultModelRetryStrategy()
    const agent = createMockAgent()
    strategy.initAgent(agent)
    const types = agent.trackedHooks.map((h) => h.eventType)
    expect(types).toContain(AfterModelCallEvent)
  })

  it('exposes the plugin name', () => {
    expect(new DefaultModelRetryStrategy().name).toBe('strands:model-retry-strategy')
  })

  it('is a ModelRetryStrategy', () => {
    expect(new DefaultModelRetryStrategy()).toBeInstanceOf(ModelRetryStrategy)
  })

  it('rejects maxAttempts below 1', () => {
    expect(() => new DefaultModelRetryStrategy({ maxAttempts: 0 })).toThrow(/maxAttempts/)
  })

  it('sets retry=true on ModelThrottledError and sleeps for the configured delay', async () => {
    const strategy = new DefaultModelRetryStrategy({
      maxAttempts: 3,
      backoff: new ConstantBackoff({ delayMs: 500 }),
    })
    const agent = createMockAgent()
    strategy.initAgent(agent)

    const event = makeErrorEvent(agent, new ModelThrottledError('rate limited'), 1)
    const pending = invokeTrackedHook(agent, event)

    // Before the timer advances, the hook is still awaiting sleep — retry not yet set.
    await vi.advanceTimersByTimeAsync(499)
    expect(event.retry).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(event.retry).toBe(true)
  })

  it('does not retry non-retryable errors', async () => {
    const strategy = new DefaultModelRetryStrategy({
      backoff: new ConstantBackoff({ delayMs: 10 }),
    })
    const agent = createMockAgent()
    strategy.initAgent(agent)

    const event = makeErrorEvent(agent, new Error('boom'), 1)
    await invokeTrackedHook(agent, event)
    expect(event.retry).toBeUndefined()
  })

  it('stops retrying once maxAttempts is reached', async () => {
    const strategy = new DefaultModelRetryStrategy({
      maxAttempts: 3,
      backoff: new ConstantBackoff({ delayMs: 1 }),
    })
    const agent = createMockAgent()
    strategy.initAgent(agent)

    // Attempt 1 → retry
    const e1 = makeErrorEvent(agent, new ModelThrottledError('x'), 1)
    const p1 = invokeTrackedHook(agent, e1)
    await vi.advanceTimersByTimeAsync(1)
    await p1
    expect(e1.retry).toBe(true)

    // Attempt 2 → retry
    const e2 = makeErrorEvent(agent, new ModelThrottledError('x'), 2)
    const p2 = invokeTrackedHook(agent, e2)
    await vi.advanceTimersByTimeAsync(1)
    await p2
    expect(e2.retry).toBe(true)

    // Attempt 3 → at max, should not retry
    const e3 = makeErrorEvent(agent, new ModelThrottledError('x'), 3)
    await invokeTrackedHook(agent, e3)
    expect(e3.retry).toBeUndefined()
  })

  it('skips work if another hook already requested retry', async () => {
    const strategy = new DefaultModelRetryStrategy({
      maxAttempts: 5,
      backoff: new ConstantBackoff({ delayMs: 1000 }),
    })
    const agent = createMockAgent()
    strategy.initAgent(agent)

    const event = makeErrorEvent(agent, new ModelThrottledError('x'), 1)
    event.retry = true

    // Should return immediately with no sleep — if it tried to sleep we'd see
    // hung test state; resolving without advancing timers proves the skip.
    await invokeTrackedHook(agent, event)
    expect(event.retry).toBe(true)
  })

  it('clears backoff state at the start of each new turn', async () => {
    // The strategy resets state on `attemptCount === 1` regardless of how
    // the prior turn ended. This exercises that: a turn racks up a retry
    // (lastDelayMs = 5), then the next turn's first attempt must see a
    // fresh BackoffContext (no lastDelayMs).
    const nextDelay = vi.fn<BackoffStrategy['nextDelay']>().mockReturnValue(5)
    const backoff: BackoffStrategy = { nextDelay }
    const strategy = new DefaultModelRetryStrategy({ maxAttempts: 5, backoff })
    const agent = createMockAgent()
    strategy.initAgent(agent)

    // Turn 1 → fail → lastDelayMs gets set to 5.
    const e1 = makeErrorEvent(agent, new ModelThrottledError('x'), 1)
    const p1 = invokeTrackedHook(agent, e1)
    await vi.advanceTimersByTimeAsync(5)
    await p1

    // Turn 2 → fail on first attempt → should see no lastDelayMs.
    const e2 = makeErrorEvent(agent, new ModelThrottledError('x'), 1)
    const p2 = invokeTrackedHook(agent, e2)
    await vi.advanceTimersByTimeAsync(5)
    await p2

    expect(nextDelay.mock.calls[1]![0]).toEqual({
      attempt: 1,
      elapsedMs: expect.any(Number),
    })
  })

  it('passes BackoffContext with attempt and lastDelayMs to the backoff strategy', async () => {
    const nextDelay = vi.fn<BackoffStrategy['nextDelay']>().mockReturnValue(5)
    const backoff: BackoffStrategy = { nextDelay }
    const strategy = new DefaultModelRetryStrategy({ maxAttempts: 5, backoff })
    const agent = createMockAgent()
    strategy.initAgent(agent)

    const e1 = makeErrorEvent(agent, new ModelThrottledError('x'), 1)
    const p1 = invokeTrackedHook(agent, e1)
    await vi.advanceTimersByTimeAsync(5)
    await p1

    expect(nextDelay).toHaveBeenCalledTimes(1)
    expect(nextDelay.mock.calls[0]![0]).toEqual({
      attempt: 1,
      elapsedMs: expect.any(Number),
    })

    const e2 = makeErrorEvent(agent, new ModelThrottledError('x'), 2)
    const p2 = invokeTrackedHook(agent, e2)
    await vi.advanceTimersByTimeAsync(5)
    await p2

    expect(nextDelay).toHaveBeenCalledTimes(2)
    expect(nextDelay.mock.calls[1]![0]).toEqual({
      attempt: 2,
      elapsedMs: expect.any(Number),
      lastDelayMs: 5,
    })
  })
})
