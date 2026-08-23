import { describe, expect, it } from 'vitest';

import { createPushableQueue } from './pushable-queue.js';

describe('createPushableQueue', () => {
  it('yields items pushed before any consumer starts', async () => {
    const q = createPushableQueue<number>();
    q.push(1);
    q.push(2);

    const it1 = q[Symbol.asyncIterator]();
    expect(await it1.next()).toEqual({ value: 1, done: false });
    expect(await it1.next()).toEqual({ value: 2, done: false });
  });

  it('resolves a pending next() as soon as an item is pushed', async () => {
    const q = createPushableQueue<string>();
    const it1 = q[Symbol.asyncIterator]();
    const pending = it1.next();

    q.push('hello');

    expect(await pending).toEqual({ value: 'hello', done: false });
  });

  it('ends iteration for consumers waiting when close() is called', async () => {
    const q = createPushableQueue<number>();
    const it1 = q[Symbol.asyncIterator]();
    const pending = it1.next();

    q.close();

    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it('a push after close() is a silent no-op', async () => {
    const q = createPushableQueue<number>();
    q.close();
    q.push(1);

    const it1 = q[Symbol.asyncIterator]();
    expect(await it1.next()).toEqual({ value: undefined, done: true });
  });
});
