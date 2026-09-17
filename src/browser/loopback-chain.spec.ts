import { describe, expect, it, vi } from 'vitest';
import { createLoopbackStore } from './loopback-chain.js';
import { encodeStatement } from './sso/statement.js';

const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
const topic = (fill: number) => new Uint8Array(32).fill(fill);

describe('loopback statement store', () => {
  it('accepts a submitted statement as new', () => {
    const store = createLoopbackStore();
    const onResponse = vi.fn();
    const connection = store.connect(onResponse);
    const statement = { topics: [topic(1)], data: new Uint8Array([9]) };

    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'statement_submit',
        params: [toHex(encodeStatement(statement))],
      }),
    );

    expect(JSON.parse(onResponse.mock.calls[0][0]).result).toBe('new');
  });

  it('reports submitted statements to listeners', () => {
    const store = createLoopbackStore();
    const seen = vi.fn();
    store.onSubmit(seen);
    const connection = store.connect(() => {});
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'statement_submit',
        params: [toHex(encodeStatement({ topics: [topic(2)], data: new Uint8Array([1]) }))],
      }),
    );
    expect(seen).toHaveBeenCalledOnce();
  });

  it('delivers published statements to matching subscribers only', () => {
    const store = createLoopbackStore();
    const onResponse = vi.fn();
    const connection = store.connect(onResponse);
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'statement_subscribeStatement',
        params: [{ MatchAll: [toHex(topic(3))] }],
      }),
    );
    onResponse.mockClear();

    store.publish({ topics: [topic(9)], data: new Uint8Array([1]) });
    expect(onResponse).not.toHaveBeenCalled();

    store.publish({ topics: [topic(3)], data: new Uint8Array([2]) });
    expect(onResponse).toHaveBeenCalledOnce();
  });

  it('stops delivering after unsubscribe', () => {
    const store = createLoopbackStore();
    const onResponse = vi.fn();
    const connection = store.connect(onResponse);
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'statement_subscribeStatement',
        params: [{ MatchAll: [toHex(topic(4))] }],
      }),
    );
    const subscriptionId = JSON.parse(onResponse.mock.calls[0][0]).result;
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'statement_unsubscribeStatement',
        params: [subscriptionId],
      }),
    );
    onResponse.mockClear();

    store.publish({ topics: [topic(4)], data: new Uint8Array([1]) });
    expect(onResponse).not.toHaveBeenCalled();
  });
});
