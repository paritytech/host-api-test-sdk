/**
 * Minimal product page for the integration tests.
 *
 * Boots through `@parity/truapi/sandbox`, which performs the product half of
 * the `truapi-ready` / `truapi-init` MessagePort handover the host's
 * `createIframeHost` drives — so there is no manual wiring here, just
 * `getClientSync()`.
 *
 * Requests its product account and the session's legacy account, writes both
 * into the DOM, and exposes `window.__TEST_PRODUCT__` so the Playwright spec
 * can drive every call the host answers from inside the product realm.
 */

import type { Result } from 'neverthrow';
import { getClientSync, subscribeConnectionStatus } from '@parity/truapi/sandbox';
import type { ConnectionStatus } from '@parity/truapi/sandbox';
import type {
  AllocatableResource,
  ChatMessageContent,
  ContextualAlias,
  DerivationIndex,
  HexString,
  HostChatActionSubscribeItem,
  HostDevicePermissionRequest,
  HostThemeSubscribeItem,
  ObservableLike,
  ProductAccountId,
  RemotePermission,
  Statement,
  StatementProof,
  Subscription,
  TxPayloadExtension,
} from '@parity/truapi';
import { scale } from '@parity/truapi';

const DOTNS_ID = 'test-product.dot';
const DERIVATION_INDEX = 0;

/**
 * What every `__TEST_PRODUCT__` call resolves to: the payload on success, or
 * the rendered protocol error. A union rather than one partial shape, so a
 * spec that reads a field has already asserted the call succeeded.
 */
export type Outcome<R extends object = {}> =
  | ({ ok: true } & R)
  | { ok: false; error: string };

/**
 * Ring the alias / proof requests are scoped to (RFC-0022 shape: a chain plus
 * the junctions locating the ring on it). The test host does not look the ring
 * up, so a fixed placeholder is enough to exercise the call.
 */
const RING_LOCATION = {
  chainId: `0x${'00'.repeat(32)}` as HexString,
  junctions: [{ tag: 'PalletInstance' as const, value: 0 }],
};

const index = (value: number): DerivationIndex => ({ tag: 'Index', value });

const accountId = (dotNsIdentifier: string, derivationIndex: number): ProductAccountId => ({
  dotNsIdentifier,
  derivationIndex: index(derivationIndex),
});

/** Render a protocol error as a string a Playwright assertion can read. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== 'object') return String(error);
  const outer = error as { tag?: string; value?: unknown };
  // CallErrorValue: Domain carries the versioned, method-specific error.
  const inner = outer.tag === 'Domain' ? (outer.value as { tag?: string; value?: unknown }) : outer;
  // Versioned envelope: { tag: 'V1', value: <method error> }.
  const domain =
    inner?.tag === 'V1' ? (inner.value as { tag?: string; value?: unknown }) : inner;
  const reason = (domain?.value as { reason?: string } | undefined)?.reason;
  if (domain?.tag && reason) return `${domain.tag}: ${reason}`;
  if (domain?.tag) return domain.tag;
  return JSON.stringify(error);
}

/**
 * Run one client call and flatten its `ResultAsync` into a plain object.
 *
 * A thrown error becomes the same `{ ok: false, error }` shape as a protocol
 * rejection, so a spec never has to distinguish the two.
 */
async function call<T, E, R extends object>(
  run: () => PromiseLike<Result<T, E>>,
  onOk: (value: T) => R,
): Promise<Outcome<R>> {
  try {
    const result = await run();
    if (result.isOk()) return { ok: true, ...onOk(result.value) };
    return { ok: false, error: describeError(result.error) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/** Collect every item a subscription delivers until the test reads them back. */
function collect<T, Reason, U>(
  observable: ObservableLike<T, Reason>,
  sink: U[],
  map: (item: T) => U,
): { unsubscribe(): void } {
  const subscription: Subscription = observable.subscribe({
    next: (item) => {
      sink.push(map(item));
    },
    error: () => {},
  });
  return { unsubscribe: () => subscription.unsubscribe() };
}

type SigningResult = Outcome<{ signature: HexString }>;
type TransactionResult = Outcome<{ signedHex: HexString }>;

declare global {
  interface Window {
    __TEST_PRODUCT__: {
      /** The status the sandbox last reported for the host channel. */
      connectionStatus(): ConnectionStatus;
      /** The product account the page fetched at boot, if that succeeded. */
      productKey(): HexString | null;
      getLegacyAccounts(): Promise<Outcome<{ keys: string[] }>>;
      signRawLegacy(signerHex: string, payloadHex: string): Promise<SigningResult>;
      signRawProduct(dotnsId: string, index: number, payloadHex: string): Promise<SigningResult>;
      requestChainSubmit(): Promise<Outcome<{ approved: boolean }>>;
      requestRemote(domain: string): Promise<Outcome<{ approved: boolean }>>;
      requestDevicePermission(type: string): Promise<Outcome<{ approved: boolean }>>;
      navigateTo(url: string): Promise<Outcome>;
      pushNotification(text: string, deeplink?: string, scheduledAt?: number): Promise<Outcome<{ notificationId: number }>>;
      pushNotificationCancel(id: number): Promise<Outcome>;
      getAccountAlias(dotnsId: string, index: number): Promise<Outcome<{ context: HexString; alias: HexString }>>;
      chatCreateRoom(room: { roomId: string; name: string; icon: string }): Promise<Outcome<{ status: string }>>;
      chatRegisterBot(bot: { botId: string; name: string; icon: string }): Promise<Outcome<{ status: string }>>;
      chatPostTextMessage(roomId: string, text: string): Promise<Outcome<{ messageId: string }>>;
      subscribeChatActions(): { unsubscribe(): void };
      getReceivedChatActions(): HostChatActionSubscribeItem[];
      subscribeChatRooms(): { unsubscribe(): void };
      getReceivedChatRooms(): string[][];
      preimageLookup(key: string): Promise<Outcome<{ value: number[] | null }>>;
      subscribeTheme(): { unsubscribe(): void };
      getReceivedThemes(): HostThemeSubscribeItem[];
      deriveEntropy(contextHex: string): Promise<Outcome<{ entropyHex: HexString }>>;
      getUserId(): Promise<Outcome<{ primaryUsername: string }>>;
      requestResourceAllocation(resources: AllocatableResource[]): Promise<Outcome<{ outcomes: string[] }>>;
      featureSupported(genesisHash: string): Promise<Outcome<{ supported: boolean }>>;
      localStorageWrite(key: string, value: string): Promise<Outcome>;
      localStorageRead(key: string): Promise<Outcome<{ value: string | null }>>;
      localStorageClear(key: string): Promise<Outcome>;
      createTransaction(dotnsId: string, index: number): Promise<TransactionResult>;
      createTransactionLegacy(publicKeyHex: string): Promise<TransactionResult>;
      accountCreateProof(dotnsId: string, index: number): Promise<Outcome<{ proofHex: HexString; alias: HexString }>>;
      statementCreateProof(dotnsId: string, index: number, dataHex: string): Promise<Outcome<{ proof: StatementProof }>>;
      statementCreateProofAuthorized(dataHex: string): Promise<Outcome<{ proof: StatementProof }>>;
    };
  }
}

const receivedChatActions: HostChatActionSubscribeItem[] = [];
const receivedChatRooms: string[][] = [];
const receivedThemes: HostThemeSubscribeItem[] = [];

let status: ConnectionStatus = 'disconnected';
subscribeConnectionStatus((next) => {
  status = next;
});

function setResult(id: string, value: string): void {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = value;
  element.dataset.ready = 'true';
}

async function init(): Promise<void> {
  const client = getClientSync();
  if (!client) {
    setResult('status', 'no-host');
    return;
  }

  // Bound once so the null check above holds for every closure below.
  const api = client;

  /** The product account key, once the boot fetch has returned one. */
  let productKey: HexString | null = null;

  window.__TEST_PRODUCT__ = {
    connectionStatus: () => status,

    productKey: () => productKey,

    getLegacyAccounts: () =>
      call(
        () => api.account.getLegacyAccounts(),
        (value) => ({ keys: value.accounts.map((entry) => entry.publicKey) }),
      ),

    // The core never enumerates legacy accounts, so the signer is named by the
    // caller: it is the session identity, which the test knows from its own
    // account configuration.
    signRawLegacy: (signerHex, payloadHex) =>
      call(
        () =>
          api.signing.signRawWithLegacyAccount({
            signer: scale.toHexString(signerHex),
            payload: { tag: 'Bytes', value: { bytes: scale.toHexString(payloadHex) } },
          }),
        (value) => ({ signature: value.signature }),
      ),

    signRawProduct: (dotnsId, derivationIndex, payloadHex) =>
      call(
        () =>
          api.signing.signRaw({
            account: accountId(dotnsId, derivationIndex),
            payload: { tag: 'Bytes', value: { bytes: scale.toHexString(payloadHex) } },
          }),
        (value) => ({ signature: value.signature }),
      ),

    requestChainSubmit: () => requestRemotePermission({ tag: 'ChainSubmit', value: undefined }),

    requestRemote: (domain) => requestRemotePermission({ tag: 'Remote', value: { domains: [domain] } }),

    requestDevicePermission: (type) =>
      call(
        () => api.permissions.requestDevicePermission(type as HostDevicePermissionRequest),
        (value) => ({ approved: value.granted }),
      ),

    navigateTo: (url) => call(() => api.system.navigateTo({ url }), () => ({})),

    pushNotification: (text, deeplink, scheduledAt) =>
      call(
        () =>
          api.notifications.sendPushNotification({
            text,
            deeplink,
            scheduledAt: scheduledAt === undefined ? undefined : BigInt(scheduledAt),
          }),
        (value) => ({ notificationId: value.id }),
      ),

    pushNotificationCancel: (id) =>
      call(() => api.notifications.cancelPushNotification({ id }), () => ({})),

    getAccountAlias: (dotnsId, derivationIndex) =>
      call(
        () =>
          api.account.getAccountAlias({
            keyHandle: accountId(dotnsId, derivationIndex),
            context: { productId: dotnsId, suffix: index(derivationIndex) },
            ringLocation: RING_LOCATION,
          }),
        (value: ContextualAlias) => ({ context: value.context, alias: value.alias }),
      ),

    chatCreateRoom: (room) =>
      call(() => api.chat.createRoom(room), (value) => ({ status: value.status })),

    chatRegisterBot: (bot) =>
      call(() => api.chat.registerBot(bot), (value) => ({ status: value.status })),

    chatPostTextMessage: (roomId, text) => {
      const payload: ChatMessageContent = { tag: 'Text', value: { text } };
      return call(
        () => api.chat.postMessage({ roomId, payload }),
        (value) => ({ messageId: value.messageId }),
      );
    },

    subscribeChatActions: () =>
      collect(api.chat.actionSubscribe(), receivedChatActions, (item) => item),

    getReceivedChatActions: () => [...receivedChatActions],

    subscribeChatRooms: () =>
      collect(api.chat.listSubscribe(), receivedChatRooms, (item) =>
        item.rooms.map((room) => room.roomId),
      ),

    getReceivedChatRooms: () => receivedChatRooms.map((rooms) => [...rooms]),

    preimageLookup: (key) =>
      new Promise((resolve) => {
        let settled = false;
        const settle = (result: Outcome<{ value: number[] | null }>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          subscription.unsubscribe();
          resolve(result);
        };
        const subscription = api.preimage
          .lookupSubscribe({ request: { key: scale.toHexString(key) } })
          .subscribe({
            next: (item) =>
              settle({
                ok: true,
                value: item.value === undefined ? null : Array.from(scale.hexToBytes(item.value)),
              }),
            error: (error) => settle({ ok: false, error: describeError(error) }),
          });
        const timer = setTimeout(() => settle({ ok: false, error: 'timeout' }), 5_000);
      }),

    subscribeTheme: () => collect(api.theme.subscribe(), receivedThemes, (item) => item),

    getReceivedThemes: () => [...receivedThemes],

    deriveEntropy: (contextHex) =>
      call(
        () => api.entropy.derive({ context: scale.toHexString(contextHex) }),
        (value) => ({ entropyHex: value.entropy }),
      ),

    getUserId: () =>
      call(() => api.account.getUserId(), (value) => ({ primaryUsername: value.primaryUsername })),

    requestResourceAllocation: (resources) =>
      call(
        () => api.resourceAllocation.request({ resources }),
        (value) => ({ outcomes: [...value.outcomes] }),
      ),

    featureSupported: (genesisHash) =>
      call(
        () =>
          api.system.featureSupported({
            tag: 'Chain',
            value: { genesisHash: scale.toHexString(genesisHash) },
          }),
        (value) => ({ supported: value.supported }),
      ),

    localStorageWrite: (key, value) =>
      call(
        () =>
          api.localStorage.write({
            key,
            value: scale.bytesToHex(new TextEncoder().encode(value)),
          }),
        () => ({}),
      ),

    localStorageRead: (key) =>
      call(
        () => api.localStorage.read({ key }),
        (response) => ({
          value:
            response.value === undefined
              ? null
              : new TextDecoder().decode(scale.hexToBytes(response.value)),
        }),
      ),

    localStorageClear: (key) => call(() => api.localStorage.clear({ key }), () => ({})),

    createTransaction: (dotnsId, derivationIndex) =>
      call(
        () =>
          api.signing.createTransaction({
            signer: accountId(dotnsId, derivationIndex),
            genesisHash: `0x${'00'.repeat(32)}`,
            callData: '0x0000',
            extensions: [] as TxPayloadExtension[],
            txExtVersion: 0,
          }),
        (value) => ({ signedHex: value.transaction }),
      ),

    createTransactionLegacy: (publicKeyHex) =>
      call(
        () =>
          api.signing.createTransactionWithLegacyAccount({
            signer: scale.toHexString(publicKeyHex),
            genesisHash: `0x${'00'.repeat(32)}`,
            callData: '0x0000',
            extensions: [] as TxPayloadExtension[],
            txExtVersion: 0,
          }),
        (value) => ({ signedHex: value.transaction }),
      ),

    accountCreateProof: (dotnsId, derivationIndex) =>
      call(
        () =>
          api.account.createAccountProof({
            keyHandle: accountId(dotnsId, derivationIndex),
            context: { productId: dotnsId, suffix: index(derivationIndex) },
            ringLocation: RING_LOCATION,
            message: scale.bytesToHex(new TextEncoder().encode('test-proof')),
          }),
        (value) => ({ proofHex: value.proof, alias: value.contextualAlias.alias }),
      ),

    statementCreateProof: (dotnsId, derivationIndex, dataHex) => {
      const statement: Statement = { topics: [], data: scale.toHexString(dataHex) };
      return call(
        () =>
          api.statementStore.createProof({
            productAccountId: accountId(dotnsId, derivationIndex),
            statement,
          }),
        (value) => ({ proof: value.proof }),
      );
    },

    statementCreateProofAuthorized: (dataHex) => {
      const statement: Statement = { topics: [], data: scale.toHexString(dataHex) };
      return call(
        () => api.statementStore.createProofAuthorized(statement),
        (value) => ({ proof: value.proof }),
      );
    },
  };

  function requestRemotePermission(permission: RemotePermission) {
    return call(
      () => api.permissions.requestRemotePermission({ permission }),
      (value) => ({ approved: value.granted }),
    );
  }

  // Published before the account fetch: a host-callback test only needs the
  // client, and the fetch below is a full SSO round trip through the worker.
  setResult('status', 'client-created');

  const account = await api.account.getAccount({
    productAccountId: accountId(DOTNS_ID, DERIVATION_INDEX),
  });
  account.match(
    (response) => {
      productKey = response.account.publicKey;
      setResult('product-key', response.account.publicKey);
      setResult('status', 'connected');
    },
    (error) => {
      setResult('status', `no-account:${describeError(error)}`);
    },
  );
}

void init().catch((error: unknown) => {
  setResult('status', `boot-error:${error instanceof Error ? error.message : String(error)}`);
});
