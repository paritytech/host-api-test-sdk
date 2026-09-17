/**
 * In-memory statement store behind `chain.connect`.
 *
 * The core reaches its paired peer by submitting and subscribing to statements
 * on the People chain. Serving that surface in-page is what keeps signing local:
 * no node, no network, no allowance to register.
 */
import {
  type Statement,
  type TopicFilterKind,
  decodeStatement,
  encodeStatement,
  matchesTopics,
} from './sso/statement.js';

interface Subscription {
  id: string;
  kind: TopicFilterKind;
  topics: Uint8Array[];
  notify: (json: string) => void;
}

const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

const fromHex = (value: string): Uint8Array => {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export interface LoopbackConnection {
  send(request: string): void;
  close(): void;
}

export interface LoopbackStore {
  connect(onResponse: (json: string) => void): LoopbackConnection;
  /** Deliver a statement to every matching subscriber. */
  publish(statement: Statement): void;
  /** Observe statements the core submits. Returns the unsubscribe. */
  onSubmit(listener: (statement: Statement) => void): () => void;
}

export function createLoopbackStore(): LoopbackStore {
  const subscriptions = new Set<Subscription>();
  const submitListeners = new Set<(statement: Statement) => void>();
  let nextSubscriptionId = 1;

  /** Accepts `{ MatchAll: [...] }` / `{ MatchAny: [...] }` and the bare array form. */
  function parseFilter(raw: unknown): { kind: TopicFilterKind; topics: Uint8Array[] } {
    if (Array.isArray(raw)) {
      return { kind: 'MatchAll', topics: raw.map((t) => fromHex(String(t))) };
    }
    // Guard against non-object primitives (strings, numbers, etc.) which would throw on `in` operator.
    if (typeof raw !== 'object' || raw === null) {
      return { kind: 'MatchAll', topics: [] };
    }
    const filter = raw as Record<string, unknown>;
    const kind: TopicFilterKind = 'MatchAny' in filter ? 'MatchAny' : 'MatchAll';
    const topics = (filter[kind] as unknown[] | undefined) ?? [];
    return { kind, topics: topics.map((t) => fromHex(String(t))) };
  }

  return {
    connect(onResponse) {
      const owned = new Set<Subscription>();

      return {
        send(request: string) {
          try {
            const { id, method, params = [] } = JSON.parse(request) as {
              id: number | string;
              method: string;
              params?: unknown[];
            };
            const reply = (result: unknown) =>
              onResponse(JSON.stringify({ jsonrpc: '2.0', id, result }));

            switch (method) {
              case 'statement_submit': {
                const statement = decodeStatement(fromHex(String(params[0])));
                // The host owns the store, so nothing can be rejected here.
                reply('new');
                for (const listener of submitListeners) listener(statement);
                return;
              }
              case 'statement_subscribeStatement': {
                const { kind, topics } = parseFilter(params[0]);
                const subscriptionId = `sub-${nextSubscriptionId++}`;
                const subscription: Subscription = {
                  id: subscriptionId,
                  kind,
                  topics,
                  notify: onResponse,
                };
                subscriptions.add(subscription);
                owned.add(subscription);
                reply(subscriptionId);
                return;
              }
              case 'statement_unsubscribeStatement': {
                const target = String(params[0]);
                for (const subscription of owned) {
                  if (subscription.id !== target) continue;
                  subscriptions.delete(subscription);
                  owned.delete(subscription);
                }
                reply(true);
                return;
              }
              default:
                onResponse(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32601, message: `unsupported method: ${method}` },
                  }),
                );
            }
          } catch (error) {
            // Try to extract id from the request for error response.
            let id: number | string = 'unknown';
            try {
              const parsed = JSON.parse(request) as { id?: number | string };
              if (parsed.id !== undefined) id = parsed.id;
            } catch {
              // If we can't even parse the request, we can't get the id.
            }
            onResponse(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: {
                  code: -32603,
                  message: error instanceof Error ? error.message : String(error),
                },
              }),
            );
          }
        },
        close() {
          for (const subscription of owned) subscriptions.delete(subscription);
          owned.clear();
        },
      };
    },

    publish(statement) {
      const result = toHex(encodeStatement(statement));
      for (const subscription of subscriptions) {
        if (!matchesTopics(statement, subscription.kind, subscription.topics)) continue;
        // Isolate each subscriber's errors so one throwing callback doesn't starve the rest.
        try {
          subscription.notify(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'statement_subscribeStatement',
              params: { subscription: subscription.id, result },
            }),
          );
        } catch {
          // Subscriber threw; swallow and continue to avoid cascading failures.
        }
      }
    },

    onSubmit(listener) {
      submitListeners.add(listener);
      return () => submitListeners.delete(listener);
    },
  };
}
