import type { Page, FrameLocator } from '@playwright/test';
import { createTestHostServer } from '../server.js';
import { DEFAULT_CHAIN } from '../networks.js';
import type { ChatActionInput, ChatBot, ChatMessageLogEntry, ChatRoom, CreateTestHostOptions, DevAccountName, HexString, NavigationLogEntry, NotificationLogEntry, PermissionBehavior, PermissionLogEntry, PreimageEntry, SigningLogEntry, TestHostAPI, Theme, ThemeInput } from '../types.js';

export interface TestHost {
  /** The host page (contains the iframe) */
  page: Page;

  /** FrameLocator for the embedded product iframe */
  productFrame(): FrameLocator;

  /**
   * Re-mint the host session under a single account.
   *
   * The product iframe is NOT reloaded: its `MessagePort` is transferred once
   * at load and cannot be handed over again, so the session is re-installed
   * and the product's core connection replaced underneath it. The product
   * keeps running and is not told; reload the page yourself if a test needs
   * the product to re-initialise. `getConnectionStatus()` returns to
   * `'disconnected'` until the product's next frame arrives.
   */
  switchAccount(name: DevAccountName): Promise<void>;

  /** Re-mint the host session under several accounts. See `switchAccount`. */
  setAccounts(names: DevAccountName[]): Promise<void>;

  /** All auto-signed payloads since last clear */
  getSigningLog(): Promise<SigningLogEntry[]>;

  /** Clear the signing log */
  clearSigningLog(): Promise<void>;

  /** Set how the host responds to remote permission requests */
  setPermissionBehavior(behavior: PermissionBehavior): Promise<void>;

  /** Pre-grant a permission without the product requesting it */
  grantPermission(tag: string): Promise<void>;

  /** Revoke a previously granted permission */
  revokePermission(tag: string): Promise<void>;

  /** List currently granted permissions */
  getGrantedPermissions(): Promise<string[]>;

  /** Enable or disable permission enforcement on signing (default: enabled) */
  setEnforcePermissions(enforce: boolean): Promise<void>;

  /** Get the log of all permission requests and their outcomes */
  getPermissionLog(): Promise<PermissionLogEntry[]>;

  /** Clear the permission log */
  clearPermissionLog(): Promise<void>;

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
  clearChatState(): Promise<void>;

  /**
   * Inject an incoming chat action (peer message) into the product.
   *
   * Rejects if the action could not be delivered.
   */
  injectChatAction(action: ChatActionInput): Promise<void>;

  /** List preimages known to the test host (submitted + seeded) */
  getPreimages(): Promise<PreimageEntry[]>;

  /** Seed a preimage value; returns its key (blake2b-256 hash). */
  seedPreimage(value: Uint8Array): Promise<HexString>;

  /** Clear all preimages */
  clearPreimages(): Promise<void>;

  /**
   * Get the current theme as the upstream struct (`{ name, variant }`).
   * Use `theme.variant` for the light/dark sub-mode (`'Light' | 'Dark'`).
   */
  getTheme(): Promise<Theme>;

  /**
   * Set the theme and notify subscribers.
   *
   * Accepts `'light' | 'dark'` (mapped to the host's `Default` theme with
   * the matching variant) or the full `{ name, variant }` struct.
   */
  setTheme(theme: ThemeInput): Promise<void>;

  /**
   * Wait until the embedded product has actually talked to the host — the
   * first wire frame off its `MessagePort`. This is the readiness gate; the
   * presence of `window.__TEST_HOST__` says nothing about the product.
   */
  waitForConnection(timeout?: number): Promise<void>;
}

export interface TestHostFixtureOptions {
  /** URL of the product to test */
  productUrl: string;
  /** Initial accounts — dev names or custom { name, uri } (default: ['alice']) */
  accounts?: CreateTestHostOptions['accounts'];
  /** Networks the host can route (default: [PASEO_ASSET_HUB]) */
  networks?: CreateTestHostOptions['networks'];
  /** Map product account requests to specific accounts (see CreateTestHostOptions.productAccounts) */
  productAccounts?: CreateTestHostOptions['productAccounts'];
}

export function createTestHostFixture(defaults: TestHostFixtureOptions) {
  return {
    testHost: async ({ page }: { page: Page }, use: (fixture: TestHost) => Promise<void>) => {
      const server = await createTestHostServer({
        productUrl: defaults.productUrl,
        accounts: defaults.accounts ?? ['alice'],
        networks: defaults.networks ?? [DEFAULT_CHAIN],
        productAccounts: defaults.productAccounts,
      });

      await page.goto(server.url);

      // Wait for browser runtime to finish async init (cryptoWaitReady + container setup)
      await page.waitForFunction(() => !!window.__TEST_HOST__, { timeout: 30_000 });

      const testHost: TestHost = {
        page,

        productFrame() {
          return page.frameLocator('#product-frame');
        },

        async switchAccount(name: DevAccountName) {
          await page.evaluate((n) => window.__TEST_HOST__.switchAccount(n), name);
          // Wait for iframe to reload
          await page.frameLocator('#product-frame').locator('body').waitFor({ state: 'attached' });
        },

        async setAccounts(names: DevAccountName[]) {
          await page.evaluate((n) => window.__TEST_HOST__.setAccounts(n), names);
          await page.frameLocator('#product-frame').locator('body').waitFor({ state: 'attached' });
        },

        async getSigningLog() {
          return page.evaluate(() => window.__TEST_HOST__.getSigningLog());
        },

        async clearSigningLog() {
          await page.evaluate(() => window.__TEST_HOST__.clearSigningLog());
        },

        async setPermissionBehavior(behavior: PermissionBehavior) {
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

        async setEnforcePermissions(enforce: boolean) {
          await page.evaluate((e) => window.__TEST_HOST__.setEnforcePermissions(e), enforce);
        },

        async getPermissionLog() {
          return page.evaluate(() => window.__TEST_HOST__.getPermissionLog());
        },

        async clearPermissionLog() {
          await page.evaluate(() => window.__TEST_HOST__.clearPermissionLog());
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

        async clearChatState() {
          await page.evaluate(() => window.__TEST_HOST__.clearChatState());
        },

        async injectChatAction(action: ChatActionInput) {
          // The arrow returns the host's promise, so Playwright awaits it and
          // a delivery failure surfaces here rather than in the page console.
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

        async waitForConnection(timeout = 30_000) {
          await page.waitForFunction(
            () => window.__TEST_HOST__?.getConnectionStatus() === 'connected',
            { timeout },
          );
        },
      };

      await use(testHost);

      // Cleanup
      await page.evaluate(() => window.__TEST_HOST__?.dispose());
      await server.close();
    },
  };
}

// Augment Window type for Playwright evaluate calls
declare global {
  interface Window {
    __TEST_HOST__: TestHostAPI;
  }
}
