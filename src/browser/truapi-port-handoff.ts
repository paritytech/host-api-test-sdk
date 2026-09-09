/**
 * Product iframe provider serving both TrUAPI channel generations.
 *
 * Products embed one of two bootstraps, distinguished by how they open the
 * frame channel:
 *
 * - `@novasamatech/host-api-wrapper` (truapi 0.3): exchanges raw Uint8Array
 *   frames directly with the parent window — `createIframeProvider`'s native
 *   channel.
 * - `@parity/truapi/sandbox` (truapi 0.4): posts `{ type: "truapi-ready" }`
 *   to the parent and waits for `{ type: "truapi-init" }` carrying a
 *   transferred MessagePort, then runs all traffic over that port. It never
 *   listens on window postMessage.
 *
 * Wire frames are identical on both channels, so this provider wraps
 * `createIframeProvider`, answers the ready ping with a fresh port pair, and
 * routes frames to whichever channel the product opened — presenting a single
 * Provider to the container.
 *
 * The provider's lifetime is one container generation: `setAccounts()`
 * disposes the container (and this provider with it) and builds a fresh pair,
 * so a handed-off port never outlives the product generation it serves.
 */

import type { Provider } from '@novasamatech/host-api';
import { createIframeProvider } from '@novasamatech/host-container';

export function createDualChannelIframeProvider(options: {
  iframe: HTMLIFrameElement;
  url: string;
}): Provider {
  const { iframe, url } = options;
  const productOrigin = new URL(url, window.location.href).origin;
  const subscribers = new Set<(message: Uint8Array) => void>();
  let port: MessagePort | null = null;

  const deliver = (message: Uint8Array): void => {
    for (const subscriber of subscribers) subscriber(message);
  };

  const onWindowMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return;
    if (event.origin !== productOrigin) return;
    const data = event.data;
    if (typeof data !== 'object' || data === null || !('type' in data)) return;
    if (data.type !== 'truapi-ready') return;

    // Each product page load needs its own port pair. Repeated readiness
    // announcements replace a handoff that the product has not adopted yet.
    port?.close();
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Uint8Array) deliver(e.data);
    };
    iframe.contentWindow?.postMessage({ type: 'truapi-init' }, productOrigin, [channel.port2]);
  };
  window.addEventListener('message', onWindowMessage);
  let inner: Provider;
  try {
    // createIframeProvider navigates the iframe, so the readiness listener must
    // already exist before product code can execute.
    inner = createIframeProvider({ iframe, url });
  } catch (error) {
    window.removeEventListener('message', onWindowMessage);
    throw error;
  }
  const unsubscribeInner = inner.subscribe(deliver);

  return {
    logger: inner.logger,
    isCorrectEnvironment: () => inner.isCorrectEnvironment(),
    postMessage(message: Uint8Array): void {
      // A product that completed the handoff listens only on the port; one
      // that did not listens only on window postMessage.
      if (port) {
        port.postMessage(message);
      } else {
        inner.postMessage(message);
      }
    },
    subscribe(callback: (message: Uint8Array) => void): () => void {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    dispose(): void {
      window.removeEventListener('message', onWindowMessage);
      port?.close();
      port = null;
      subscribers.clear();
      unsubscribeInner();
      inner.dispose();
    },
  };
}
