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

  /**
   * Accepts the filter object the core sends, and the bare array form.
   *
   * The core spells the keys lower-camel — `json!({ "matchAll": topics })` /
   * `json!({ "matchAny": topics })` in `statement_store_rpc.rs` — so those are
   * the spellings that matter. The capitalised variant names are accepted too:
   * they are unambiguous aliases, and a serde rename upstream would otherwise
   * turn every filter into an unmatched key, i.e. silently back into a
   * firehose. `matchAny` is probed first so an object carrying both keys is
   * never narrowed to `MatchAll`, which would drop statements a `matchAny`
   * subscriber asked for.
   */
  const FILTER_KEYS: ReadonlyArray<readonly [key: string, kind: TopicFilterKind]> = [
    ['matchAny', 'MatchAny'],
    ['MatchAny', 'MatchAny'],
    ['matchAll', 'MatchAll'],
    ['MatchAll', 'MatchAll'],
  ];

  function parseFilter(raw: unknown): { kind: TopicFilterKind; topics: Uint8Array[] } {
    const toTopics = (values: unknown[]) => values.map((t) => fromHex(String(t)));

    if (Array.isArray(raw)) {
      return { kind: 'MatchAll', topics: toTopics(raw) };
    }
    // Guard against non-object primitives (strings, numbers, etc.) which would throw on `in` operator.
    if (typeof raw !== 'object' || raw === null) {
      return { kind: 'MatchAll', topics: [] };
    }
    const filter = raw as Record<string, unknown>;
    for (const [key, kind] of FILTER_KEYS) {
      if (!(key in filter)) continue;
      const topics = filter[key];
      return { kind, topics: Array.isArray(topics) ? toTopics(topics) : [] };
    }
    // No recognised key: subscribe to everything rather than to nothing, so a
    // filter this store cannot read is loud (extra deliveries) instead of a
    // silent black hole.
    return { kind: 'MatchAll', topics: [] };
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
                // The core reads `.status` off the result object and treats
                // only `new`/`known` as accepted (`statement_store_rpc.rs`,
                // `fn submit`); a bare `"new"` string has no `status` field
                // and is rejected as `statement_submit not accepted`. The host
                // owns the store, so nothing is ever rejected here.
                reply({ status: 'new' });
                // Isolate each listener so one throwing doesn't starve the rest or contradict the success reply.
                for (const listener of submitListeners) {
                  try {
                    listener(statement);
                  } catch (error) {
                    // Swallowed so one listener cannot starve the rest or
                    // contradict the success reply — but never silently: the
                    // SSO responder is a listener, and a throw here is a reply
                    // the core will wait for forever.
                    console.error('[loopback-chain] statement_submit listener threw:', error);
                  }
                }
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
      // The core decodes every subscription item with
      // `parse_new_statements_result` (`host_logic/statement_store/rpc.rs`):
      // it demands `result.event === 'newStatements'` and reads the SCALE
      // statements out of `result.data.statements`. A bare hex string there is
      // rejected as `malformed statement-store frame`. `remaining` is the
      // server-side backlog, and this store never has one. The notification
      // method name is the one Substrate uses for this subscription; the core
      // ignores it and keys only on `params.subscription`.
      const result = {
        event: 'newStatements',
        data: { statements: [toHex(encodeStatement(statement))], remaining: 0 },
      };
      for (const subscription of subscriptions) {
        if (!matchesTopics(statement, subscription.kind, subscription.topics)) continue;
        // Isolate each subscriber's errors so one throwing callback doesn't starve the rest.
        try {
          subscription.notify(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'statement_statement',
              params: { subscription: subscription.id, result },
            }),
          );
        } catch (error) {
          // Swallowed to avoid cascading failures, but logged: a subscriber
          // that throws is a statement nobody received.
          console.error('[loopback-chain] statement subscriber threw:', error);
        }
      }
    },

    onSubmit(listener) {
      submitListeners.add(listener);
      return () => submitListeners.delete(listener);
    },
  };
}
