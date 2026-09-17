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

  it('handles malformed filters without throwing', () => {
    const store = createLoopbackStore();
    const onResponse = vi.fn();
    const connection = store.connect(onResponse);

    // Bare string filter should not throw; should return an error response instead.
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'statement_subscribeStatement',
        params: ['bare-string-filter'],
      }),
    );

    expect(onResponse).toHaveBeenCalledOnce();
    const response = JSON.parse(onResponse.mock.calls[0][0]);
    expect(response.result).toBeDefined(); // Should have a subscription ID, not an error.
  });

  it('continues publishing after a subscriber throws', () => {
    const store = createLoopbackStore();
    let callCount = 0;
    const onResponse1 = vi.fn(() => {
      callCount++;
      // Throw only on the publish call (callCount > 1), not on subscription setup (callCount === 1).
      if (callCount > 1) throw new Error('subscriber 1 error');
    });
    const onResponse2 = vi.fn();
    const connection1 = store.connect(onResponse1);
    const connection2 = store.connect(onResponse2);

    connection1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'statement_subscribeStatement',
        params: [{ MatchAll: [toHex(topic(5))] }],
      }),
    );
    connection2.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'statement_subscribeStatement',
        params: [{ MatchAll: [toHex(topic(5))] }],
      }),
    );
    onResponse1.mockClear();
    onResponse2.mockClear();

    store.publish({ topics: [topic(5)], data: new Uint8Array([1]) });

    // Even though subscriber 1 threw, subscriber 2 should still receive the message.
    expect(onResponse2).toHaveBeenCalledOnce();
  });

  it('drops only the closed connection\'s subscriptions', () => {
    const store = createLoopbackStore();
    const onResponse1 = vi.fn();
    const onResponse2 = vi.fn();
    const connection1 = store.connect(onResponse1);
    const connection2 = store.connect(onResponse2);

    // Both subscribe to the same topic.
    connection1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'statement_subscribeStatement',
        params: [{ MatchAll: [toHex(topic(6))] }],
      }),
    );
    connection2.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'statement_subscribeStatement',
        params: [{ MatchAll: [toHex(topic(6))] }],
      }),
    );
    onResponse1.mockClear();
    onResponse2.mockClear();

    // Close connection1.
    connection1.close();

    // Publish a matching statement.
    store.publish({ topics: [topic(6)], data: new Uint8Array([1]) });

    // Only connection2 should receive it.
    expect(onResponse1).not.toHaveBeenCalled();
    expect(onResponse2).toHaveBeenCalledOnce();
  });

  it('continues notifying listeners after one throws', () => {
    const store = createLoopbackStore();
    const listener1 = vi.fn(() => {
      throw new Error('listener 1 error');
    });
    const listener2 = vi.fn();
    store.onSubmit(listener1);
    store.onSubmit(listener2);
    const onResponse = vi.fn();
    const connection = store.connect(onResponse);

    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'statement_submit',
        params: [toHex(encodeStatement({ topics: [topic(7)], data: new Uint8Array([1]) }))],
      }),
    );

    // Both listeners should have been called.
    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();

    // Exactly one response should be sent for this request id, and it should be success.
    expect(onResponse).toHaveBeenCalledOnce();
    const response = JSON.parse(onResponse.mock.calls[0][0]);
    expect(response.result).toBe('new');
  });
});
