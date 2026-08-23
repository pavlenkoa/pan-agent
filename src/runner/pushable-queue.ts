/**
 * Minimal push-based async queue — feeds the SDK's streaming-input `prompt`
 * (architecture doc: one persistent `query()` per pod, not one per turn) and
 * the session controller's task-notification reaction FIFO. No dependency
 * beyond the async iterator protocol.
 */
export interface PushableQueue<T> extends AsyncIterable<T> {
  push(item: T): void;
  close(): void;
}

export function createPushableQueue<T>(): PushableQueue<T> {
  const buffered: T[] = [];
  const waiting: ((result: IteratorResult<T>) => void)[] = [];
  let closed = false;

  return {
    push(item: T): void {
      if (closed) return;
      const resolve = waiting.shift();
      if (resolve) resolve({ value: item, done: false });
      else buffered.push(item);
    },
    close(): void {
      if (closed) return;
      closed = true;
      while (waiting.length > 0) waiting.shift()?.({ value: undefined as never, done: true });
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffered.length > 0) return Promise.resolve({ value: buffered.shift() as T, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiting.push(resolve));
        },
      };
    },
  };
}
