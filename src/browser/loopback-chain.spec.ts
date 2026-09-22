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

    // The core reads `.status` off the result; a bare `'new'` string is
    // rejected as `statement_submit not accepted`.
    expect(JSON.parse(onResponse.mock.calls[0][0]).result).toEqual({ status: 'new' });
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
        params: [{ matchAll: [toHex(topic(3))] }],
      }),
    );
    onResponse.mockClear();

    store.publish({ topics: [topic(9)], data: new Uint8Array([1]) });
    expect(onResponse).not.toHaveBeenCalled();

    store.publish({ topics: [topic(3)], data: new Uint8Array([2]) });
    expect(onResponse).toHaveBeenCalledOnce();
  });

  it('delivers a statement in the newStatements envelope the core decodes', () => {
    const store = createLoopbackStore();
    const onResponse = vi.fn();
    const connection = store.connect(onResponse);
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 22,
        method: 'statement_subscribeStatement',
        params: [{ matchAll: [toHex(topic(8))] }],
      }),
    );
    const subscriptionId = JSON.parse(onResponse.mock.calls[0][0]).result;
    onResponse.mockClear();

    const statement = { topics: [topic(8)], data: new Uint8Array([7]) };
    store.publish(statement);

    // `parse_new_statements_result` keys on `result.event`; a bare hex string
    // is rejected as a malformed statement-store frame.
    expect(JSON.parse(onResponse.mock.calls[0][0])).toEqual({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: subscriptionId,
        result: {
          event: 'newStatements',
          data: { statements: [toHex(encodeStatement(statement))], remaining: 0 },
        },
      },
    });
  });

  it('honours a matchAny filter without widening it to matchAll', () => {
    const store = createLoopbackStore();
    const onResponse = vi.fn();
    const connection = store.connect(onResponse);
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'statement_subscribeStatement',
        params: [{ matchAny: [toHex(topic(10)), toHex(topic(11))] }],
      }),
    );
    onResponse.mockClear();

    store.publish({ topics: [topic(12)], data: new Uint8Array([1]) });
    expect(onResponse).not.toHaveBeenCalled();

    store.publish({ topics: [topic(11)], data: new Uint8Array([2]) });
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
        params: [{ matchAll: [toHex(topic(4))] }],
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
        params: [{ matchAll: [toHex(topic(5))] }],
      }),
    );
    connection2.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'statement_subscribeStatement',
        params: [{ matchAll: [toHex(topic(5))] }],
      }),
    );
    onResponse1.mockClear();
    onResponse2.mockClear();

    store.publish({ topics: [topic(5)], data: new Uint8Array([1]) });

    expect(onResponse2).toHaveBeenCalledOnce();
  });

  it('drops only the closed connection\'s subscriptions', () => {
    const store = createLoopbackStore();
    const onResponse1 = vi.fn();
    const onResponse2 = vi.fn();
    const connection1 = store.connect(onResponse1);
    const connection2 = store.connect(onResponse2);

    connection1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'statement_subscribeStatement',
        params: [{ matchAll: [toHex(topic(6))] }],
      }),
    );
    connection2.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'statement_subscribeStatement',
        params: [{ matchAll: [toHex(topic(6))] }],
      }),
    );
    onResponse1.mockClear();
    onResponse2.mockClear();

    connection1.close();

    store.publish({ topics: [topic(6)], data: new Uint8Array([1]) });

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

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();

    expect(onResponse).toHaveBeenCalledOnce();
    const response = JSON.parse(onResponse.mock.calls[0][0]);
    expect(response.result).toEqual({ status: 'new' });
  });
});

describe('loopback statement retention', () => {
  const submit = (store: ReturnType<typeof createLoopbackStore>, statement: Parameters<typeof encodeStatement>[0]) => {
    const connection = store.connect(() => {});
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'statement_submit',
        params: [toHex(encodeStatement(statement))],
      }),
    );
    return connection;
  };

  const subscribe = (
    store: ReturnType<typeof createLoopbackStore>,
    onResponse: (json: string) => void,
    filterTopic: Uint8Array,
  ) => {
    const connection = store.connect(onResponse);
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'statement_subscribeStatement',
        params: [{ matchAll: [toHex(filterTopic)] }],
      }),
    );
    return connection;
  };

  /** The statements carried by every `newStatements` frame the mock received. */
  const delivered = (onResponse: ReturnType<typeof vi.fn>): string[] =>
    onResponse.mock.calls
      .map(([json]) => JSON.parse(json as string))
      .filter((message) => message.method === 'statement_statement')
      .flatMap((message) => message.params.result.data.statements as string[]);

  it('retains what the product submits, and reports it as the product\'s', () => {
    const store = createLoopbackStore();
    submit(store, { topics: [topic(1)], data: new Uint8Array([7]) });

    expect(store.statements()).toHaveLength(1);
    expect(store.statements()[0].fromProduct).toBe(true);
    expect(store.statements()[0].statement.data).toEqual(new Uint8Array([7]));
  });

  it('marks an injected statement as not the product\'s', () => {
    const store = createLoopbackStore();
    store.inject({ topics: [topic(1)], data: new Uint8Array([7]) });

    expect(store.statements()[0].fromProduct).toBe(false);
  });

  // The whole point: without the replay a test races its subscribe against the
  // submit, which is what the protocol's `isComplete` dump exists to rule out.
  it('replays matching statements to a subscription opened afterwards', () => {
    const store = createLoopbackStore();
    store.inject({ topics: [topic(1)], data: new Uint8Array([1]) });
    store.inject({ topics: [topic(2)], data: new Uint8Array([2]) });

    const onResponse = vi.fn();
    subscribe(store, onResponse, topic(1));

    expect(delivered(onResponse)).toEqual([
      toHex(encodeStatement({ topics: [topic(1)], data: new Uint8Array([1]) })),
    ]);
  });

  it('sends no dump frame at all when nothing matches', () => {
    const store = createLoopbackStore();
    store.inject({ topics: [topic(2)], data: new Uint8Array([2]) });

    const onResponse = vi.fn();
    subscribe(store, onResponse, topic(1));

    expect(delivered(onResponse)).toEqual([]);
  });

  it('fans a submitted statement out to a live subscription', () => {
    const store = createLoopbackStore();
    const onResponse = vi.fn();
    subscribe(store, onResponse, topic(1));
    onResponse.mockClear();

    submit(store, { topics: [topic(1)], data: new Uint8Array([5]) });

    expect(delivered(onResponse)).toEqual([
      toHex(encodeStatement({ topics: [topic(1)], data: new Uint8Array([5]) })),
    ]);
  });

  it('clears the retained set without closing live subscriptions', () => {
    const store = createLoopbackStore();
    const onResponse = vi.fn();
    subscribe(store, onResponse, topic(1));
    store.inject({ topics: [topic(1)], data: new Uint8Array([1]) });
    onResponse.mockClear();

    store.clear();
    expect(store.statements()).toEqual([]);

    store.inject({ topics: [topic(1)], data: new Uint8Array([2]) });
    expect(delivered(onResponse)).toHaveLength(1);
  });

  // Signing shares this store. Retaining the session's traffic would replay
  // stale requests into a re-subscribing session; fanning it out would echo the
  // core its own request. Neither may happen.
  it('neither retains nor delivers the host\'s own session traffic', () => {
    const store = createLoopbackStore();
    store.markSessionTopic(topic(8));

    const onResponse = vi.fn();
    subscribe(store, onResponse, topic(8));
    onResponse.mockClear();

    const seen = vi.fn();
    store.onSubmit(seen);
    submit(store, { topics: [topic(8)], data: new Uint8Array([1]) });

    // The responder still hears it — that is how signing travels.
    expect(seen).toHaveBeenCalledOnce();
    expect(store.statements()).toEqual([]);
    expect(delivered(onResponse)).toEqual([]);
  });

  it('still retains a statement whose topics miss every session topic', () => {
    const store = createLoopbackStore();
    store.markSessionTopic(topic(8));
    submit(store, { topics: [topic(1)], data: new Uint8Array([1]) });

    expect(store.statements()).toHaveLength(1);
  });
});
