/**
 * In-memory statement store behind `chain.connect`. The core reaches its paired
 * peer over People-chain statements, so serving that surface in-page is what
 * keeps signing local: no node, no network, no allowance to register.
 *
 * It is a real store, not a relay: a submitted statement is retained, delivered
 * to every matching live subscription, and replayed to a subscription opened
 * later. Without the replay a test would race the subscribe against the submit,
 * which is what `RemoteStatementStoreSubscribeItem.isComplete` exists to rule
 * out — the protocol promises a historical dump before the live tail.
 *
 * The host's own SSO channel is the one exception. Its statements are tagged
 * and pass straight through to `onSubmit`, retained by nothing and delivered to
 * no subscription, because the core both submits and subscribes on those topics:
 * retaining them would replay stale signing requests into a re-subscribing
 * session, and fanning them out would echo the core its own request. Signing
 * therefore travels exactly the path it did before this store kept anything.
 */
import { scale } from '@parity/truapi';
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

export interface LoopbackConnection {
  send(request: string): void;
  close(): void;
}

/** One retained statement, in arrival order. */
export interface StoredStatement {
  statement: Statement;
  /** True when the product submitted it, false when a test injected it. */
  fromProduct: boolean;
  timestamp: number;
}

export interface LoopbackStore {
  connect(onResponse: (json: string) => void): LoopbackConnection;
  /**
   * Deliver a statement to every matching subscriber without retaining it —
   * the SSO responder's replies, which are answers to one in-flight request.
   */
  publish(statement: Statement): void;
  /** Observe statements the core submits. Returns the unsubscribe. */
  onSubmit(listener: (statement: Statement) => void): () => void;
  /**
   * Declare a topic as the host's own SSO session traffic. Statements carrying
   * it are neither retained nor fanned out. Register before the session opens,
   * or its first statements are read as a product's.
   */
  markSessionTopic(topic: Uint8Array): void;
  /** Every retained statement, oldest first. */
  statements(): StoredStatement[];
  /** Retain a statement and deliver it, as though it had been submitted. */
  inject(statement: Statement): void;
  /** Drop every retained statement. Live subscriptions stay open. */
  clear(): void;
}

export function createLoopbackStore(): LoopbackStore {
  const subscriptions = new Set<Subscription>();
  const submitListeners = new Set<(statement: Statement) => void>();
  const retained: StoredStatement[] = [];
  const sessionTopics = new Set<string>();
  let nextSubscriptionId = 1;

  const isSessionTraffic = (statement: Statement): boolean =>
    (statement.topics ?? []).some((topic) => sessionTopics.has(scale.bytesToHex(topic)));

  /**
   * Lower-camel keys, as `statement_store_rpc.rs` sends them. `matchAny` is
   * probed first so an object carrying both keys is never narrowed to
   * `MatchAll`, which would drop statements the subscriber asked for.
   */
  const FILTER_KEYS: ReadonlyArray<readonly [key: string, kind: TopicFilterKind]> = [
    ['matchAny', 'MatchAny'],
    ['matchAll', 'MatchAll'],
  ];

  function parseFilter(raw: unknown): { kind: TopicFilterKind; topics: Uint8Array[] } {
    const toTopics = (values: unknown[]) => values.map((t) => scale.hexToBytes(String(t)));

    if (Array.isArray(raw)) {
      return { kind: 'MatchAll', topics: toTopics(raw) };
    }
    // `in` throws on a non-object primitive.
    if (typeof raw !== 'object' || raw === null) {
      return { kind: 'MatchAll', topics: [] };
    }
    const filter = raw as Record<string, unknown>;
    for (const [key, kind] of FILTER_KEYS) {
      if (!(key in filter)) continue;
      const topics = filter[key];
      return { kind, topics: Array.isArray(topics) ? toTopics(topics) : [] };
    }
    // An unreadable filter subscribes to everything, so it is loud (extra
    // deliveries) rather than a silent black hole.
    return { kind: 'MatchAll', topics: [] };
  }

  /**
   * `parse_new_statements_result` demands this exact envelope — a bare hex
   * string is rejected as `malformed statement-store frame`. `remaining` is a
   * server backlog this store never has, and the core keys on
   * `params.subscription`, ignoring the method name.
   */
  function frame(subscriptionId: string, statements: Statement[]): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: subscriptionId,
        result: {
          event: 'newStatements',
          data: {
            statements: statements.map((s) => scale.bytesToHex(encodeStatement(s))),
            remaining: 0,
          },
        },
      },
    });
  }

  function deliver(subscription: Subscription, statements: Statement[]): void {
    if (statements.length === 0) return;
    try {
      subscription.notify(frame(subscription.id, statements));
    } catch (error) {
      // Logged, not silent: a subscriber that throws is a statement nobody
      // received.
      console.error('[loopback-chain] statement subscriber threw:', error);
    }
  }

  /** Deliver to every matching live subscription. */
  function fanOut(statement: Statement): void {
    for (const subscription of subscriptions) {
      if (!matchesTopics(statement, subscription.kind, subscription.topics)) continue;
      deliver(subscription, [statement]);
    }
  }

  function retain(statement: Statement, fromProduct: boolean): void {
    retained.push({ statement, fromProduct, timestamp: Date.now() });
    fanOut(statement);
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
                const statement = decodeStatement(scale.hexToBytes(String(params[0])));
                // The core reads `.status` off this object and accepts only
                // `new`/`known`; a bare `"new"` string is rejected as
                // `statement_submit not accepted`.
                reply({ status: 'new' });
                // Session traffic is plumbing: it reaches the responder through
                // the listeners below and goes no further. See the file comment.
                if (!isSessionTraffic(statement)) retain(statement, true);
                for (const listener of submitListeners) {
                  try {
                    listener(statement);
                  } catch (error) {
                    // Swallowed so one listener cannot starve the rest, but
                    // never silently: the SSO responder is a listener, and a
                    // throw here is a reply the core waits for forever.
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
                // The id first: a frame naming a subscription the core has not
                // been told about yet has nowhere to land.
                reply(subscriptionId);
                deliver(
                  subscription,
                  retained
                    .filter((entry) => matchesTopics(entry.statement, kind, topics))
                    .map((entry) => entry.statement),
                );
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
            let id: number | string = 'unknown';
            try {
              const parsed = JSON.parse(request) as { id?: number | string };
              if (parsed.id !== undefined) id = parsed.id;
            } catch {
              // Unparseable request: no id to echo.
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
      fanOut(statement);
    },

    onSubmit(listener) {
      submitListeners.add(listener);
      return () => submitListeners.delete(listener);
    },

    markSessionTopic(topic) {
      sessionTopics.add(scale.bytesToHex(topic));
    },

    statements() {
      return retained.map((entry) => ({ ...entry }));
    },

    inject(statement) {
      retain(statement, false);
    },

    clear() {
      retained.length = 0;
    },
  };
}
