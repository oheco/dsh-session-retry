import { LlmError } from '@deepseek-ai/dsh-llm';

const normalizeLlmFailure = error => error instanceof LlmError ? error.failure
  : { code: 'STREAM_ERROR', message: (error instanceof Error ? error.message : typeof error === 'string' ? error : '') || 'Model stream failed.' };
const failure = (code, message, kind = 'error') => ({ type: 'finish', reason: { kind, failure: { code, message } } });

// Returning an async generator may itself wait forever behind a pending next().
// Detach cleanup and observe rejection so timeout/cancellation can still settle.
function close(iterator) {
  try { Promise.resolve(iterator?.return?.()).catch(() => {}); }
  catch { /* Cleanup failure cannot replace an already settled stream outcome. */ }
}

function read(iterator, signal, idleTimeoutMs, remainingMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => finish({ type: 'cancelled' });
    const timeout = remainingMs === undefined ? idleTimeoutMs : Math.min(idleTimeoutMs, Math.max(0, remainingMs));
    const timer = setTimeout(() => finish({ type: 'timeout' }), timeout);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    Promise.resolve().then(() => settled ? undefined : iterator.next()).then(
      item => { if (item !== undefined) finish({ type: 'item', item }); },
      error => finish({ type: 'error', error }),
    );
  });
}

/**
 * End the consumer's attempt even when next()/return() ignores cancellation.
 * The original request and signal remain untouched; late chunks are discarded.
 * Closing the underlying transport remains cooperative with its adapter.
 * @param {() => AsyncIterable<object>} open Open downstream middleware lazily.
 * @param {object} options Validated timeout snapshot and cancellation signals.
 * @returns {AsyncIterable<object>} Chunks ending with one terminal finish.
 */
export async function* guardStream(open, { signal, lifetime, idleTimeoutMs, requestTimeoutMs }) {
  const fused = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
  const deadline = requestTimeoutMs > 0 ? performance.now() + requestTimeoutMs : undefined;
  let iterator;
  try {
    if (fused.aborted) { yield failure('ABORTED', 'Model request cancelled.', 'aborted'); return; }
    iterator = open()[Symbol.asyncIterator]();
    while (true) {
      const remainingMs = deadline === undefined ? undefined : deadline - performance.now();
      if (remainingMs !== undefined && remainingMs <= 0) {
        yield failure('TIMEOUT', `Model request exceeded ${requestTimeoutMs}ms; retrying the same step.`);
        return;
      }
      const result = await read(iterator, fused, idleTimeoutMs, remainingMs);
      if (fused.aborted || result.type === 'cancelled') {
        yield failure('ABORTED', 'Model request cancelled.', 'aborted');
        return;
      }
      if (result.type === 'timeout') {
        const total = deadline !== undefined && performance.now() >= deadline;
        yield failure('TIMEOUT', total
          ? `Model request exceeded ${requestTimeoutMs}ms; retrying the same step.`
          : `Model stream had no response for ${idleTimeoutMs}ms; retrying the same step.`);
        return;
      }
      if (result.type === 'error') {
        yield { type: 'finish', reason: { kind: 'error', failure: normalizeLlmFailure(result.error) } };
        return;
      }
      if (result.item.done) {
        yield failure('STREAM_CLOSED', 'Model stream ended without a terminal response.');
        return;
      }
      yield result.item.value;
      if (result.item.value.type === 'finish') return;
    }
  } catch (error) {
    yield { type: 'finish', reason: { kind: fused.aborted ? 'aborted' : 'error', failure: normalizeLlmFailure(error) } };
  } finally {
    close(iterator);
  }
}
