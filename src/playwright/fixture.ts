import type { Page, FrameLocator } from '@playwright/test';
import { createTestHostServer } from '../server.js';
import { DEFAULT_CHAIN } from '../networks.js';
import type { ChainEntry, ChatActionInput, ChatBot, ChatMessageLogEntry, ChatRoom, CreateTestHostOptions, DevAccountName, DevicePermissionStatus, HexString, HostDevicePermissionRequest, InitialBehaviors, InitialState, NavigationLogEntry, NotificationLogEntry, PermissionLogEntry, PreimageEntry, SigningLogEntry, TestHostAPI, Theme, ThemeInput, UserConfirmationLogEntry } from '../types.js';

/**
 * What the fixture's behaviour setters accept. A `Behavior`'s function form
 * cannot cross `page.evaluate`, so it is in-page only — via `window.__TEST_HOST__`.
 */
export type FixtureBehavior = 'approve-all' | 'reject-all';

export interface TestHost {
  /** The host page (contains the iframe) */
  page: Page;

  /** FrameLocator for the embedded product iframe */
  productFrame(): FrameLocator;

  /**
   * Re-mint the host session under one account, matched case-insensitively
   * against the configured `accounts` (an unknown dev name falls back to
   * `'bob'` → `//Bob`). The product iframe is NOT reloaded and the product is
   * not told — reload the page yourself if it must re-initialise.
   */
  switchAccount(name: DevAccountName | (string & {})): Promise<void>;

  /**
   * Replace the whole roster. The FIRST name becomes the active identity and is
   * the only account that signs; the rest are later `switchAccount` targets.
   */
  setAccounts(names: Array<DevAccountName | (string & {})>): Promise<void>;

  /** All auto-signed payloads since last clear */
  getSigningLog(): Promise<SigningLogEntry[]>;

  /** Clear the signing log */
  clearSigningLog(): Promise<void>;

  /** Set how the host responds to remote permission requests. */
  setPermissionBehavior(behavior: FixtureBehavior): Promise<void>;

  /** Pre-grant a permission without the product requesting it */
  grantPermission(tag: string): Promise<void>;

  /** Revoke a previously granted permission */
  revokePermission(tag: string): Promise<void>;

  /** List currently granted permissions */
  getGrantedPermissions(): Promise<string[]>;

  /** Get the log of all permission requests and their outcomes */
  getPermissionLog(): Promise<PermissionLogEntry[]>;

  /** Clear the permission log */
  clearPermissionLog(): Promise<void>;

  /**
   * Force the OS status `permissionStatus.devicePermissionStatus` reports for
   * one device permission; `undefined` restores the default status.
   */
  setDevicePermissionStatus(
    type: HostDevicePermissionRequest,
    status: DevicePermissionStatus | undefined,
  ): Promise<void>;

  /** The forced device-permission statuses currently in effect. */
  getDevicePermissionStatuses(): Promise<Record<string, DevicePermissionStatus>>;

  /** Get the log of navigation attempts from the product */
  getNavigationLog(): Promise<NavigationLogEntry[]>;

  /** Clear the navigation log */
  clearNavigationLog(): Promise<void>;

  /** Get the log of push notifications from the product */
  getNotificationLog(): Promise<NotificationLogEntry[]>;

  /** Clear the notification log */
  clearNotificationLog(): Promise<void>;

  /** List chat rooms the product has created in the current session */
  getChatRooms(): Promise<ChatRoom[]>;

  /** List chat bots the product has registered in the current session */
  getChatBots(): Promise<ChatBot[]>;

  /** Get the log of messages posted by the product */
  getChatMessageLog(): Promise<ChatMessageLogEntry[]>;

  /** Clear all chat state (rooms, bots, messages, subscribers) */
  clearChat(): Promise<void>;

  /** Add a chat room without the product creating it; live subscribers are notified. */
  seedChatRoom(room: ChatRoom): Promise<void>;

  /** Add a chat bot without the product registering it. */
  seedChatBot(bot: ChatBot): Promise<void>;

  /** Inject an incoming chat action into the product; rejects if it could not be delivered. */
  injectChatAction(action: ChatActionInput): Promise<void>;

  /** List preimages known to the test host (submitted + seeded) */
  getPreimages(): Promise<PreimageEntry[]>;

  /** Seed a preimage value; returns its key (blake2b-256 hash). */
  seedPreimage(value: Uint8Array): Promise<HexString>;

  /** Clear all preimages */
  clearPreimages(): Promise<void>;

  /** Get the current theme; `theme.variant` is the light/dark sub-mode. */
  getTheme(): Promise<Theme>;

  /** Set the theme and notify subscribers. `'light' | 'dark'` map to the host's `Default` theme. */
  setTheme(theme: ThemeInput): Promise<void>;

  /** The BCP 47 tag the host reports to products. */
  getLocale(): Promise<string>;

  /** Replace the reported locale; live subscribers are notified. */
  setLocale(languageTag: string): Promise<void>;

  /** Set how the host answers `confirmUserAction`. */
  setUserConfirmationBehavior(behavior: FixtureBehavior): Promise<void>;

  /** Every review the core asked the host to confirm. */
  getUserConfirmationLog(): Promise<UserConfirmationLogEntry[]>;

  /** Drop the confirmation log. */
  clearUserConfirmationLog(): Promise<void>;

  /** Set how the host answers `navigateTo`. */
  setNavigationBehavior(behavior: FixtureBehavior): Promise<void>;

  /** Set how the host answers `pushNotification`. */
  setNotificationBehavior(behavior: FixtureBehavior): Promise<void>;

  /** Force `featureSupported` for one feature tag; `undefined` restores the derived answer. */
  setFeatureSupport(feature: string, supported: boolean | undefined): Promise<void>;

  /** The forced answers currently in effect. */
  getFeatureSupport(): Promise<Record<string, boolean>>;

  /** Replace the advertised chain set; `undefined` restores the derived one. */
  setSupportedChains(chains: ChainEntry[] | undefined): Promise<void>;

  /** The chain set in effect — the override if one is set, the derived one otherwise. */
  getSupportedChains(): Promise<ChainEntry[]>;

  /**
   * Pre-populate one product-storage entry; the value is stored as UTF-8. The
   * core namespaces keys per product, so `key` must be one `getProductStorage()`
   * reported — a product-level key it never wrote is not resolvable here.
   */
  seedProductStorage(key: string, value: string): Promise<void>;

  /** Every product-storage entry, decoded as UTF-8. */
  getProductStorage(): Promise<Record<string, string>>;

  /** Drop every product-storage entry. */
  clearProductStorage(): Promise<void>;

  /**
   * Wait until the product has actually talked to the host. This is the
   * readiness gate — `window.__TEST_HOST__` says nothing about the product.
   */
  waitForConnection(timeout?: number): Promise<void>;

  /**
   * The product connection. Prefer `waitForConnection()` as a gate; read this
   * when a test needs to assert the product went quiet.
   */
  getConnectionStatus(): Promise<string>;

  /**
   * The host's own session, which is what carries local signing: a switch that
   * leaves this `'disconnected'` means no signature will ever come back.
   */
  getChainStatus(): Promise<string>;
}

export interface TestHostFixtureOptions {
  /** URL of the product to test */
  productUrl: string;
  /**
   * dotNS identifier the product runs as (default `'test-product.dot'`); see
   * `CreateTestHostOptions.productId`.
   */
  productId?: CreateTestHostOptions['productId'];
  /**
   * The account roster (default `['alice']`). The FIRST entry is the active
   * identity and the only account that signs.
   */
  accounts?: CreateTestHostOptions['accounts'];
  /** Networks the host can route (default: [PASEO_ASSET_HUB]) */
  networks?: CreateTestHostOptions['networks'];
  /** Map a product's account subtree to a specific account, keyed by the bare
   * product id (see `CreateTestHostOptions.productAccounts`) */
  productAccounts?: CreateTestHostOptions['productAccounts'];
  /** Default `'App'`; set `'Worker'` to exercise chat, which the core serves for no other kind. */
  executionKind?: CreateTestHostOptions['executionKind'];
  /** Host state applied before the product loads. */
  initialState?: InitialState;
  /** Decision policies applied before the product loads. */
  behaviors?: InitialBehaviors;
}

export function createTestHostFixture(defaults: TestHostFixtureOptions) {
  return {
    testHost: async ({ page }: { page: Page }, use: (fixture: TestHost) => Promise<void>) => {
      const server = await createTestHostServer({
        productUrl: defaults.productUrl,
        productId: defaults.productId,
        accounts: defaults.accounts ?? ['alice'],
        networks: defaults.networks ?? [DEFAULT_CHAIN],
        productAccounts: defaults.productAccounts,
        executionKind: defaults.executionKind,
        initialState: defaults.initialState,
        behaviors: defaults.behaviors,
      });

      await page.goto(server.url);

      // The control plane is published last, so this gates on the HOST being
      // up. The product is a separate gate — `waitForConnection()`.
      await page.waitForFunction(() => !!window.__TEST_HOST__, { timeout: 30_000 });

      const testHost: TestHost = {
        page,

        productFrame() {
          return page.frameLocator('#product-frame');
        },

        // `page.evaluate` awaits the host's own promise, which resolves once
        // the session is active and the provider replaced. Nothing further to
        // wait on: the iframe is deliberately never reloaded.
        async switchAccount(name: DevAccountName | (string & {})) {
          await page.evaluate((n) => window.__TEST_HOST__.switchAccount(n), name);
        },

        async setAccounts(names: Array<DevAccountName | (string & {})>) {
          await page.evaluate((n) => window.__TEST_HOST__.setAccounts(n), names);
        },

        async getSigningLog() {
          return page.evaluate(() => window.__TEST_HOST__.getSigningLog());
        },

        async clearSigningLog() {
          await page.evaluate(() => window.__TEST_HOST__.clearSigningLog());
        },

        async setPermissionBehavior(behavior: FixtureBehavior) {
          await page.evaluate((b) => window.__TEST_HOST__.setPermissionBehavior(b), behavior);
        },

        async grantPermission(tag: string) {
          await page.evaluate((t) => window.__TEST_HOST__.grantPermission(t), tag);
        },

        async revokePermission(tag: string) {
          await page.evaluate((t) => window.__TEST_HOST__.revokePermission(t), tag);
        },

        async getGrantedPermissions() {
          return page.evaluate(() => window.__TEST_HOST__.getGrantedPermissions());
        },

        async getPermissionLog() {
          return page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
        },

        async clearPermissionLog() {
          await page.evaluate(() => window.__TEST_HOST__.clearPermissionLog());
        },

        async setDevicePermissionStatus(
          type: HostDevicePermissionRequest,
          status: DevicePermissionStatus | undefined,
        ) {
          await page.evaluate(
            (args) => window.__TEST_HOST__.setDevicePermissionStatus(args.type, args.status),
            { type, status },
          );
        },

        async getDevicePermissionStatuses() {
          return page.evaluate(() => window.__TEST_HOST__.getDevicePermissionStatuses());
        },

        async getNavigationLog() {
          return page.evaluate(() => window.__TEST_HOST__.getNavigationLog());
        },

        async clearNavigationLog() {
          await page.evaluate(() => window.__TEST_HOST__.clearNavigationLog());
        },

        async getNotificationLog() {
          return page.evaluate(() => window.__TEST_HOST__.getNotificationLog());
        },

        async clearNotificationLog() {
          await page.evaluate(() => window.__TEST_HOST__.clearNotificationLog());
        },

        async getChatRooms() {
          return page.evaluate(() => window.__TEST_HOST__.getChatRooms());
        },

        async getChatBots() {
          return page.evaluate(() => window.__TEST_HOST__.getChatBots());
        },

        async getChatMessageLog() {
          return page.evaluate(() => window.__TEST_HOST__.getChatMessageLog());
        },

        async clearChat() {
          await page.evaluate(() => window.__TEST_HOST__.clearChat());
        },

        async seedChatRoom(room: ChatRoom) {
          await page.evaluate((r) => window.__TEST_HOST__.seedChatRoom(r), room);
        },

        async seedChatBot(bot: ChatBot) {
          await page.evaluate((b) => window.__TEST_HOST__.seedChatBot(b), bot);
        },

        async injectChatAction(action: ChatActionInput) {
          // Returning the host's promise makes a delivery failure surface here
          // rather than in the page console.
          await page.evaluate((a) => window.__TEST_HOST__.injectChatAction(a), action);
        },

        async getPreimages() {
          return page.evaluate(() => window.__TEST_HOST__.getPreimages());
        },

        async seedPreimage(value: Uint8Array) {
          return page.evaluate(
            (bytes) => window.__TEST_HOST__.seedPreimage(new Uint8Array(bytes)),
            Array.from(value),
          );
        },

        async clearPreimages() {
          await page.evaluate(() => window.__TEST_HOST__.clearPreimages());
        },

        async getTheme() {
          return page.evaluate(() => window.__TEST_HOST__.getTheme());
        },

        async setTheme(theme: ThemeInput) {
          await page.evaluate((t) => window.__TEST_HOST__.setTheme(t), theme);
        },

        async getLocale() {
          return page.evaluate(() => window.__TEST_HOST__.getLocale());
        },

        async setLocale(languageTag: string) {
          await page.evaluate((tag) => window.__TEST_HOST__.setLocale(tag), languageTag);
        },

        async setUserConfirmationBehavior(behavior: FixtureBehavior) {
          await page.evaluate((b) => window.__TEST_HOST__.setUserConfirmationBehavior(b), behavior);
        },

        async getUserConfirmationLog() {
          return page.evaluate(() => window.__TEST_HOST__.getUserConfirmationLog());
        },

        async clearUserConfirmationLog() {
          await page.evaluate(() => window.__TEST_HOST__.clearUserConfirmationLog());
        },

        async setNavigationBehavior(behavior: FixtureBehavior) {
          await page.evaluate((b) => window.__TEST_HOST__.setNavigationBehavior(b), behavior);
        },

        async setNotificationBehavior(behavior: FixtureBehavior) {
          await page.evaluate((b) => window.__TEST_HOST__.setNotificationBehavior(b), behavior);
        },

        async setFeatureSupport(feature: string, supported: boolean | undefined) {
          await page.evaluate(
            (args) => window.__TEST_HOST__.setFeatureSupport(args.feature, args.supported),
            { feature, supported },
          );
        },

        async getFeatureSupport() {
          return page.evaluate(() => window.__TEST_HOST__.getFeatureSupport());
        },

        async setSupportedChains(chains: ChainEntry[] | undefined) {
          await page.evaluate((c) => window.__TEST_HOST__.setSupportedChains(c), chains);
        },

        async getSupportedChains() {
          return page.evaluate(() => window.__TEST_HOST__.getSupportedChains());
        },

        async seedProductStorage(key: string, value: string) {
          await page.evaluate((args) => window.__TEST_HOST__.seedProductStorage(args.key, args.value), { key, value });
        },

        async getProductStorage() {
          return page.evaluate(() => window.__TEST_HOST__.getProductStorage());
        },

        async clearProductStorage() {
          await page.evaluate(() => window.__TEST_HOST__.clearProductStorage());
        },

        async waitForConnection(timeout = 30_000) {
          await page.waitForFunction(
            () => window.__TEST_HOST__?.getConnectionStatus() === 'connected',
            { timeout },
          );
        },

        async getConnectionStatus() {
          return page.evaluate(() => window.__TEST_HOST__.getConnectionStatus());
        },

        async getChainStatus() {
          return page.evaluate(() => window.__TEST_HOST__.getChainStatus());
        },
      };

      await use(testHost);

      await page.evaluate(() => window.__TEST_HOST__?.dispose());
      await server.close();
    },
  };
}

declare global {
  interface Window {
    __TEST_HOST__: TestHostAPI;
  }
}
