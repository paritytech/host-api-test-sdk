# Handler Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every host handler outside the account/signing/statement-store path a control-API override, so a product can be tested under any condition the handler surface can express.

**Architecture:** Two families, one shape each. Ambient data gets `get<Thing>()` / `set<Thing>(v)` / `seed<Thing>(...)` / `clear<Thing>()`; decisions get `set<Thing>Behavior(b)` where `b` is `'approve-all' | 'reject-all' | fn`. State lives in `HostState`; callbacks read it; `control-api.ts` writes it and pushes to live subscribers. Everything is additionally settable at fixture-construction time and applied before the product's first frame.

**Tech Stack:** TypeScript, `@parity/truapi` 0.17, `@parity/truapi-host` 0.17, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-18-handler-overrides-design.md`

## Global Constraints

- Out of scope entirely: `chain.connect` and `loopback-chain.ts`, `sso/**`, `signing/**`, `coreStorage`, `auth.authStateChanged`, and the `pocket` group. Do not touch them.
- Everything runs locally: no external process, no Docker, no network in tests.
- Root dev-account addresses must not move: `//Alice` is `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`.
- Types come from the real published typings on disk. `as any` / `as never` / `@ts-ignore` papering over a mismatch is a defect.
- `src/types.ts` is published and must not name a devDependency in its emitted output; `@parity/truapi` is a real dependency and may be imported.
- Comments carry only what the code cannot say, in one or two lines. No essays, no history narration.
- A `set…` on a subscribed value must notify live subscribers, not only change the next read.
- Gates after every task: `pnpm typecheck` (two projects), `pnpm vitest run`, `pnpm build` (exit 0, no warnings), `pnpm test`, `pnpm test:integration`.
- `@playwright/test` is a peerDependency — drive Playwright through `pnpm exec`. Local runs use system Chrome; do not change the CI path.
- CLAUDE.md requires `package.json`, `CHANGELOG.md`, `forum-post.md` and `README.md` to move with any public API change. Task 10 does this once for the whole feature; earlier tasks do not touch them.

---

### Task 1: Behavior vocabulary and the one rename

**Files:**
- Modify: `src/types.ts`
- Modify: `src/browser/control-api.ts`
- Modify: `src/playwright/fixture.ts`
- Modify: `test/integration.spec.ts`

**Interfaces:**
- Produces: `export type Behavior<Req, Res> = 'approve-all' | 'reject-all' | ((request: Req) => Res);` in `src/types.ts`, and `clearChat()` replacing `clearChatState()` on `TestHostAPI` and on the fixture.

`PermissionBehavior` already has this shape. Generalise it, keep `PermissionBehavior` as an alias so nothing else changes in this task.

- [ ] **Step 1: Add the generic type**

In `src/types.ts`, directly above the existing `PermissionBehavior`:

```ts
/**
 * How the host answers one kind of request. `fn` receives the request and
 * returns the answer, so a test can be selective without a matcher language.
 */
export type Behavior<Req, Res> = 'approve-all' | 'reject-all' | ((request: Req) => Res);
```

Then replace the body of `PermissionBehavior` with:

```ts
export type PermissionBehavior = Behavior<{ tag: string; value: unknown }, boolean>;
```

- [ ] **Step 2: Check the existing permission call site still compiles**

Run: `pnpm typecheck`
Expected: PASS. If `src/browser/callbacks/permissions.ts` calls the function form as `behavior(tag, value)` rather than `behavior({ tag, value })`, update that call site and its unit test to the object form — the generic takes one request argument.

- [ ] **Step 3: Rename `clearChatState` to `clearChat`**

Rename in all four places: the `TestHostAPI` member in `src/types.ts`, the implementation in `src/browser/control-api.ts`, the `TestHost` interface member and its implementation in `src/playwright/fixture.ts`, and every call in `test/integration.spec.ts`.

- [ ] **Step 4: Run the gates**

Run: `pnpm typecheck && pnpm vitest run && pnpm build && pnpm test && pnpm test:integration`
Expected: all PASS, integration count unchanged at 49.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/browser/control-api.ts src/playwright/fixture.ts test/integration.spec.ts
git commit -m "refactor: generalise the behavior type and normalise clearChat"
```

---

### Task 2: Locale override

**Files:**
- Modify: `src/types.ts`
- Modify: `src/browser/control-api.ts`
- Modify: `src/playwright/fixture.ts`
- Test: `src/browser/callbacks/passive.spec.ts` (create if absent)
- Test: `test/integration.spec.ts`

**Interfaces:**
- Consumes: `HostState.locale: string` and `HostState.localeSubscribers: Set<(locale: string) => void>`, both of which already exist and are already wired into `locale.subscribeLocale()`.
- Produces: `getLocale(): string` and `setLocale(languageTag: string): void` on `TestHostAPI`.

The locale is a BCP 47 language tag (`HostLocaleSubscribeItem.languageTag`): `en`, `pt-BR`, `zh-Hans`. The default is `'en'`.

- [ ] **Step 1: Write the failing unit test**

```ts
// src/browser/callbacks/passive.spec.ts
import { describe, expect, it } from 'vitest';
import { createLocaleCallbacks } from './passive.js';
import { createHostState } from './state.js';

describe('locale callbacks', () => {
  it('emits the current locale, then each change', async () => {
    const state = createHostState();
    const { subscribeLocale } = createLocaleCallbacks(state);
    const items = subscribeLocale()[Symbol.asyncIterator]();

    const first = await items.next();
    expect(first.value).toEqual({ value: { languageTag: 'en' } });

    state.locale = 'pt-BR';
    for (const notify of state.localeSubscribers) notify(state.locale);

    const second = await items.next();
    expect(second.value).toEqual({ value: { languageTag: 'pt-BR' } });
  });
});
```

If the existing `subscribeLocale` wraps items differently (a `Result` with an `ok`/`value` shape), match whatever `createThemeCallbacks` does in the same file — read it first and mirror its assertion shape exactly.

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run src/browser/callbacks/passive.spec.ts`
Expected: PASS if the callback is already correct — this test pins existing behaviour before the control API is added. If it fails, fix the assertion to match the real item shape, not the callback.

- [ ] **Step 3: Add the control members**

In `src/types.ts`, inside `TestHostAPI` next to `getTheme` / `setTheme`:

```ts
  /** The BCP 47 tag the host reports to products, e.g. `en`, `pt-BR`. */
  getLocale(): string;
  /** Replace the reported locale and push it to live subscribers. */
  setLocale(languageTag: string): void;
```

In `src/browser/control-api.ts`, beside `setTheme`:

```ts
    getLocale() {
      return state.locale;
    },

    setLocale(languageTag: string) {
      state.locale = languageTag;
      for (const notify of state.localeSubscribers) notify(state.locale);
    },
```

- [ ] **Step 4: Surface it on the fixture**

In `src/playwright/fixture.ts`, add to the `TestHost` interface:

```ts
  /** The BCP 47 tag the host reports to products. */
  getLocale(): Promise<string>;

  /** Replace the reported locale; live subscribers are notified. */
  setLocale(languageTag: string): Promise<void>;
```

and to the returned object:

```ts
        async getLocale() {
          return page.evaluate(() => window.__TEST_HOST__.getLocale());
        },

        async setLocale(languageTag: string) {
          await page.evaluate((tag) => window.__TEST_HOST__.setLocale(tag), languageTag);
        },
```

- [ ] **Step 5: Write the failing integration test**

The test product must expose what it received. Check `test/test-product.ts` for an existing locale subscription; if there is none, add one mirroring its theme subscription — `subscribeLocale()` collecting into an array, exposed as `getReceivedLocales()` on `window.__TEST_PRODUCT__`, and rebuild with `node test/build-test-product.mjs`.

```ts
// test/integration.spec.ts, in a new `test.describe('Locale', ...)`
test('a locale change reaches a subscribed product', async ({ page, testHost }) => {
  const product = page.frameLocator('#product-frame');
  await testHost.waitForConnection();

  expect(await testHost.getLocale()).toBe('en');
  await testHost.setLocale('pt-BR');

  await expect
    .poll(() => page.evaluate(() => window.__TEST_PRODUCT__.getReceivedLocales()))
    .toContain('pt-BR');
  expect(await testHost.getLocale()).toBe('pt-BR');
});
```

- [ ] **Step 6: Run the gates**

Run: `pnpm typecheck && pnpm vitest run && pnpm build && pnpm test && pnpm test:integration`
Expected: all PASS, integration count 50.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/browser/control-api.ts src/playwright/fixture.ts src/browser/callbacks/passive.spec.ts test/
git commit -m "feat: let tests set the locale the host reports"
```

---

### Task 3: User-confirmation behaviour

**Files:**
- Create: `src/browser/callbacks/user-confirmation.ts`
- Modify: `src/browser/callbacks/index.ts`
- Modify: `src/browser/callbacks/state.ts`
- Modify: `src/types.ts`, `src/browser/control-api.ts`, `src/playwright/fixture.ts`
- Test: `src/browser/callbacks/user-confirmation.spec.ts`, `test/integration.spec.ts`

**Interfaces:**
- Consumes: `Behavior` from Task 1.
- Produces: `createUserConfirmationCallbacks(state: HostState): { confirmUserAction(review: UserConfirmationReview): Promise<boolean> }`; `setUserConfirmationBehavior(b)`, `getUserConfirmationLog()`, `clearUserConfirmationLog()` on `TestHostAPI`; `HostState.userConfirmationBehavior` and `HostState.userConfirmationLog`.

`confirmUserAction` is currently inlined in `index.ts` and hardcoded to `true`, so a product's "user declined" path cannot be tested at all.

- [ ] **Step 1: Add the state fields**

In `src/browser/callbacks/state.ts`, add to the `HostState` interface:

```ts
  /** How `userConfirmation.confirmUserAction` answers; `'approve-all'` by default. */
  userConfirmationBehavior: UserConfirmationBehavior;
  /** Every review the core asked the host to confirm. */
  userConfirmationLog: UserConfirmationLogEntry[];
```

and to `createHostState()`'s returned object:

```ts
    userConfirmationBehavior: 'approve-all',
    userConfirmationLog: [],
```

Import the two types from `../../types.js`.

- [ ] **Step 2: Add the public types**

In `src/types.ts`:

```ts
/** One `confirmUserAction` review the host was asked to answer. */
export interface UserConfirmationLogEntry {
  /** The review's variant tag, e.g. `SignRaw`. */
  tag: string;
  approved: boolean;
  timestamp: number;
}

/** How the host answers `confirmUserAction`; `'approve-all'` is the default. */
export type UserConfirmationBehavior = Behavior<{ tag: string; value: unknown }, boolean>;
```

- [ ] **Step 3: Write the failing test**

```ts
// src/browser/callbacks/user-confirmation.spec.ts
import { describe, expect, it } from 'vitest';
import { createUserConfirmationCallbacks } from './user-confirmation.js';
import { createHostState } from './state.js';

const review = { tag: 'SignRaw', value: undefined } as const;

describe('user confirmation callbacks', () => {
  it('approves by default and logs the review', async () => {
    const state = createHostState();
    const { confirmUserAction } = createUserConfirmationCallbacks(state);

    expect(await confirmUserAction(review)).toBe(true);
    expect(state.userConfirmationLog).toEqual([
      { tag: 'SignRaw', approved: true, timestamp: expect.any(Number) },
    ]);
  });

  it('rejects every review under reject-all', async () => {
    const state = createHostState();
    state.userConfirmationBehavior = 'reject-all';
    const { confirmUserAction } = createUserConfirmationCallbacks(state);

    expect(await confirmUserAction(review)).toBe(false);
    expect(state.userConfirmationLog[0].approved).toBe(false);
  });

  it('asks the function form, which sees the review', async () => {
    const state = createHostState();
    const seen: string[] = [];
    state.userConfirmationBehavior = (request) => {
      seen.push(request.tag);
      return request.tag !== 'SignRaw';
    };
    const { confirmUserAction } = createUserConfirmationCallbacks(state);

    expect(await confirmUserAction(review)).toBe(false);
    expect(await confirmUserAction({ tag: 'CreateTransaction', value: undefined })).toBe(true);
    expect(seen).toEqual(['SignRaw', 'CreateTransaction']);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `pnpm vitest run src/browser/callbacks/user-confirmation.spec.ts`
Expected: FAIL — cannot resolve `./user-confirmation.js`.

- [ ] **Step 5: Implement**

```ts
// src/browser/callbacks/user-confirmation.ts
import type { UserConfirmationReview } from '@parity/truapi-host';
import type { HostState } from './state.js';

export function createUserConfirmationCallbacks(state: HostState): {
  confirmUserAction(review: UserConfirmationReview): Promise<boolean>;
} {
  return {
    async confirmUserAction(review: UserConfirmationReview): Promise<boolean> {
      const behavior = state.userConfirmationBehavior;
      const request = { tag: review.tag, value: review.value };
      const approved =
        behavior === 'approve-all'
          ? true
          : behavior === 'reject-all'
            ? false
            : behavior(request);

      state.userConfirmationLog.push({ tag: review.tag, approved, timestamp: Date.now() });
      return approved;
    },
  };
}
```

Confirm `UserConfirmationReview` is a tagged union with `tag` and `value` before relying on that shape; if `value` is absent on some variants, type `request.value` as `unknown` and read it defensively at the one place it is built.

- [ ] **Step 6: Run the test**

Run: `pnpm vitest run src/browser/callbacks/user-confirmation.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Wire it in**

In `src/browser/callbacks/index.ts`, replace the inline group:

```ts
    userConfirmation: {
      confirmUserAction: async () => true,
    },
```

with `userConfirmation: createUserConfirmationCallbacks(state),` and add the import. Remove the now-stale comment about unconditional approval in the module header.

- [ ] **Step 8: Add the control members**

`src/types.ts`, in `TestHostAPI`:

```ts
  /** Set how the host answers `confirmUserAction`. */
  setUserConfirmationBehavior(behavior: UserConfirmationBehavior): void;
  /** Every review the core asked the host to confirm. */
  getUserConfirmationLog(): UserConfirmationLogEntry[];
  /** Drop the confirmation log. */
  clearUserConfirmationLog(): void;
```

`src/browser/control-api.ts`:

```ts
    setUserConfirmationBehavior(behavior: UserConfirmationBehavior) {
      state.userConfirmationBehavior = behavior;
    },

    getUserConfirmationLog() {
      return [...state.userConfirmationLog];
    },

    clearUserConfirmationLog() {
      state.userConfirmationLog.length = 0;
    },
```

`src/playwright/fixture.ts` — same three, each wrapped in `page.evaluate`. Note the function form of a behaviour **cannot cross `page.evaluate`**: document on the fixture members that only `'approve-all'` and `'reject-all'` are accepted there, and type the fixture parameter as `'approve-all' | 'reject-all'`.

- [ ] **Step 9: Write the failing integration test**

```ts
// test/integration.spec.ts, in a new `test.describe('User confirmation', ...)`
test('a rejected confirmation fails the product call', async ({ page, testHost }) => {
  await testHost.waitForConnection();
  await testHost.setUserConfirmationBehavior('reject-all');

  const result = await page.evaluate(() =>
    window.__TEST_PRODUCT__.signRawProduct('test-product.dot', 0, '0x00'),
  );

  expect(result.ok).toBe(false);
  const log = await testHost.getUserConfirmationLog();
  expect(log.some((entry) => entry.approved === false)).toBe(true);
});
```

If the core does not route this particular call through `confirmUserAction`, find one that does by setting `'reject-all'` and reading `getUserConfirmationLog()` after each product call the suite already makes — then assert against that call instead. Report which call it turned out to be.

- [ ] **Step 10: Run the gates**

Run: `pnpm typecheck && pnpm vitest run && pnpm build && pnpm test && pnpm test:integration`
Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add src/browser/callbacks/user-confirmation.ts src/browser/callbacks/user-confirmation.spec.ts src/browser/callbacks/index.ts src/browser/callbacks/state.ts src/types.ts src/browser/control-api.ts src/playwright/fixture.ts test/integration.spec.ts
git commit -m "feat: let tests reject user confirmations"
```

---

### Task 4: Navigation and notification behaviours

**Files:**
- Modify: `src/browser/callbacks/navigation.ts`, `src/browser/callbacks/notifications.ts`, `src/browser/callbacks/state.ts`
- Modify: `src/types.ts`, `src/browser/control-api.ts`, `src/playwright/fixture.ts`
- Test: `src/browser/callbacks/navigation.spec.ts`, `src/browser/callbacks/notifications.spec.ts`, `test/integration.spec.ts`

**Interfaces:**
- Consumes: `Behavior` from Task 1.
- Produces: `setNavigationBehavior(b)` and `setNotificationBehavior(b)` on `TestHostAPI`; `HostState.navigationBehavior` and `HostState.notificationBehavior`.

Both handlers currently always succeed. A product cannot be tested against a host that refuses to navigate or cannot post a notification.

- [ ] **Step 1: Add state and public types**

`src/browser/callbacks/state.ts`, in `HostState` and `createHostState()`:

```ts
  navigationBehavior: NavigationBehavior;   // 'approve-all'
  notificationBehavior: NotificationBehavior; // 'approve-all'
```

`src/types.ts`:

```ts
/** How the host answers `navigateTo`; `'approve-all'` is the default. */
export type NavigationBehavior = Behavior<{ url: string }, boolean>;

/** How the host answers `pushNotification`; `'approve-all'` is the default. */
export type NotificationBehavior = Behavior<{ text: string }, boolean>;
```

- [ ] **Step 2: Write the failing navigation test**

```ts
// src/browser/callbacks/navigation.spec.ts
import { describe, expect, it } from 'vitest';
import { createNavigationCallbacks } from './navigation.js';
import { createHostState } from './state.js';

describe('navigation callbacks', () => {
  it('logs and accepts by default', async () => {
    const state = createHostState();
    await createNavigationCallbacks(state).navigateTo('https://example.com/a');
    expect(state.navigationLog).toHaveLength(1);
  });

  it('throws under reject-all, and still logs the attempt', async () => {
    const state = createHostState();
    state.navigationBehavior = 'reject-all';
    await expect(
      createNavigationCallbacks(state).navigateTo('https://example.com/a'),
    ).rejects.toThrow(/refused/i);
    expect(state.navigationLog).toHaveLength(1);
  });

  it('asks the function form, which sees the url', async () => {
    const state = createHostState();
    state.navigationBehavior = (request) => !request.url.includes('blocked');
    const { navigateTo } = createNavigationCallbacks(state);
    await expect(navigateTo('https://example.com/blocked')).rejects.toThrow(/refused/i);
    await navigateTo('https://example.com/ok');
    expect(state.navigationLog).toHaveLength(2);
  });
});
```

The attempt is logged either way: a test asserting "the product tried to navigate and was refused" needs both halves.

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run src/browser/callbacks/navigation.spec.ts`
Expected: FAIL — `navigationBehavior` is not read.

- [ ] **Step 4: Implement navigation**

In `src/browser/callbacks/navigation.ts`, after the existing log push and before returning, decide and throw on refusal:

```ts
      const behavior = state.navigationBehavior;
      const allowed =
        behavior === 'approve-all'
          ? true
          : behavior === 'reject-all'
            ? false
            : behavior({ url });
      if (!allowed) throw new Error(`Navigation refused by the test host: ${url}`);
```

Check how the core surfaces a thrown host callback before settling on `throw`: if `navigateTo`'s generated signature declares an error response type, return that instead. Read `Navigation` in `node_modules/@parity/truapi-host/dist/generated/host-callbacks.d.ts` first and say in your report which it was.

- [ ] **Step 5: Write the failing notification test**

```ts
// src/browser/callbacks/notifications.spec.ts
import { describe, expect, it } from 'vitest';
import { createNotificationCallbacks } from './notifications.js';
import { createHostState } from './state.js';

const request = { text: 'hello' } as const;

describe('notification callbacks', () => {
  it('returns an incrementing id and logs by default', async () => {
    const state = createHostState();
    const { pushNotification } = createNotificationCallbacks(state);
    expect((await pushNotification(request)).id).toBe(1);
    expect((await pushNotification(request)).id).toBe(2);
    expect(state.notificationLog).toHaveLength(2);
  });

  it('refuses under reject-all and still logs the attempt', async () => {
    const state = createHostState();
    state.notificationBehavior = 'reject-all';
    const { pushNotification } = createNotificationCallbacks(state);
    await expect(pushNotification(request)).rejects.toThrow(/refused/i);
    expect(state.notificationLog).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `pnpm vitest run src/browser/callbacks/notifications.spec.ts`
Expected: FAIL on the second test.

- [ ] **Step 7: Implement notifications**

Same decision shape in `src/browser/callbacks/notifications.ts`, evaluated after the log push so a refused attempt is still recorded, with the id still allocated so ids never collide across refusals. Refuse with `throw new Error('Notification refused by the test host')` unless the generated `Notifications` signature declares an error response, in which case return that.

- [ ] **Step 8: Run both suites**

Run: `pnpm vitest run src/browser/callbacks`
Expected: PASS.

- [ ] **Step 9: Add the control members and the fixture surface**

`setNavigationBehavior(behavior: NavigationBehavior): void` and `setNotificationBehavior(behavior: NotificationBehavior): void` on `TestHostAPI`, assigning into `state`; the same two on the fixture restricted to `'approve-all' | 'reject-all'`, with the same note about functions not crossing `page.evaluate`.

- [ ] **Step 10: Write the failing integration test**

```ts
// test/integration.spec.ts, in the existing `Navigation` describe
test('a refused navigation surfaces to the product and is still logged', async ({ page, testHost }) => {
  await testHost.waitForConnection();
  await testHost.setNavigationBehavior('reject-all');

  const result = await page.evaluate(() =>
    window.__TEST_PRODUCT__.navigateTo('https://example.com/blocked'),
  );

  expect(result.ok).toBe(false);
  const log = await testHost.getNavigationLog();
  expect(log.some((entry) => entry.url.includes('blocked'))).toBe(true);
});
```

- [ ] **Step 11: Run the gates**

Run: `pnpm typecheck && pnpm vitest run && pnpm build && pnpm test && pnpm test:integration`
Expected: all PASS.

- [ ] **Step 12: Commit**

```bash
git add src/browser/callbacks/ src/types.ts src/browser/control-api.ts src/playwright/fixture.ts test/integration.spec.ts
git commit -m "feat: let tests refuse navigation and notifications"
```

---

### Task 5: Feature and chain-set overrides

**Files:**
- Modify: `src/browser/callbacks/features.ts`, `src/browser/callbacks/index.ts`, `src/browser/callbacks/state.ts`
- Modify: `src/types.ts`, `src/browser/control-api.ts`, `src/playwright/fixture.ts`
- Test: `src/browser/callbacks/features.spec.ts`, `test/integration.spec.ts`

**Interfaces:**
- Consumes: `createFeatureCallbacks(networks: ChainRuntimeConfig[])`, which this task changes to `createFeatureCallbacks(state: HostState, networks: ChainRuntimeConfig[])`.
- Produces: `setFeatureSupport(feature: string, supported: boolean | undefined): void`, `getFeatureSupport(): Record<string, boolean>`, `setSupportedChains(chains: HostChainEntry[] | undefined): void` on `TestHostAPI`; `HostState.featureOverrides: Map<string, boolean>` and `HostState.supportedChainsOverride?: HostChainEntry[]`.

Today `featureSupported` answers `{ supported: false }` for every non-`Chain` request and derives chain answers from the configured networks, so "this feature is unavailable" is untestable. An override keyed by the request's variant tag fixes both.

- [ ] **Step 1: Add state**

`src/browser/callbacks/state.ts`, in `HostState` and `createHostState()`:

```ts
  /** Feature tag → forced answer; absent means fall back to the derived one. */
  featureOverrides: Map<string, boolean>;   // new Map()
  /** Replaces the derived chain set entirely when set. */
  supportedChainsOverride?: HostChainEntry[];  // undefined
```

Import `HostChainEntry` from `@parity/truapi-host` — `state.ts` is bundled, not published, so a devDependency import is fine there.

- [ ] **Step 2: Write the failing test**

Append to `src/browser/callbacks/features.spec.ts`:

```ts
  it('lets an override force a feature answer either way', async () => {
    const state = createHostState();
    const { featureSupported } = createFeatureCallbacks(state, []);
    const chainRequest = { tag: 'Chain', value: { genesisHash: peopleHex } } as const;

    expect((await featureSupported(chainRequest)).supported).toBe(true);
    state.featureOverrides.set('Chain', false);
    expect((await featureSupported(chainRequest)).supported).toBe(false);

    const other = { tag: 'Camera', value: undefined } as const;
    expect((await featureSupported(other)).supported).toBe(false);
    state.featureOverrides.set('Camera', true);
    expect((await featureSupported(other)).supported).toBe(true);
  });

  it('replaces the whole chain set when overridden', async () => {
    const state = createHostState();
    const { supportedChains } = createFeatureCallbacks(state, []);
    expect((await supportedChains()).chains).toHaveLength(1);

    state.supportedChainsOverride = [];
    expect((await supportedChains()).chains).toEqual([]);
  });
```

Reuse whatever `peopleHex` the existing tests in that file already build; do not introduce a second spelling of the People hash.

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run src/browser/callbacks/features.spec.ts`
Expected: FAIL — `createFeatureCallbacks` takes one argument.

- [ ] **Step 4: Implement**

Change the signature to `createFeatureCallbacks(state: HostState, networks: ChainRuntimeConfig[])`. In `featureSupported`, consult the override first:

```ts
      const override = state.featureOverrides.get(request.tag);
      if (override !== undefined) return { supported: override };
```

before the existing `Chain` handling. In `supportedChains`, return the override when set:

```ts
      if (state.supportedChainsOverride) {
        return { network: 'polkadot', chains: state.supportedChainsOverride };
      }
```

Update the call site in `src/browser/callbacks/index.ts` to `createFeatureCallbacks(state, networks)`.

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run src/browser/callbacks/features.spec.ts`
Expected: PASS, all tests including the pre-existing four.

- [ ] **Step 6: Add the control members and fixture surface**

`src/types.ts`:

```ts
  /** Force `featureSupported` for one feature tag; `undefined` restores the derived answer. */
  setFeatureSupport(feature: string, supported: boolean | undefined): void;
  /** The forced answers currently in effect. */
  getFeatureSupport(): Record<string, boolean>;
  /** Replace the advertised chain set; `undefined` restores the derived one. */
  setSupportedChains(chains: ChainEntry[] | undefined): void;
```

Add the public `ChainEntry` type to `src/types.ts` — `{ identifier: ChainIdentifier; genesisHash: HexString }` — rather than exporting `HostChainEntry` from the devDependency.

`src/browser/control-api.ts`:

```ts
    setFeatureSupport(feature: string, supported: boolean | undefined) {
      if (supported === undefined) state.featureOverrides.delete(feature);
      else state.featureOverrides.set(feature, supported);
    },

    getFeatureSupport() {
      return Object.fromEntries(state.featureOverrides);
    },

    setSupportedChains(chains: ChainEntry[] | undefined) {
      state.supportedChainsOverride = chains;
    },
```

Mirror all three on the fixture through `page.evaluate`.

- [ ] **Step 7: Write the failing integration test**

```ts
// test/integration.spec.ts, in the existing `Feature check` describe
test('an override flips a chain feature the host would otherwise support', async ({ page, testHost }) => {
  await testHost.waitForConnection();
  const probe = () =>
    page.evaluate(() =>
      window.__TEST_PRODUCT__.featureSupported('Chain', {
        genesisHash: window.__TEST_HOST_CONFIG__.networks[0].genesisHash,
      }),
    );

  expect((await probe()).supported).toBe(true);
  await testHost.setFeatureSupport('Chain', false);
  expect((await probe()).supported).toBe(false);
});
```

If `__TEST_HOST_CONFIG__` is not reachable from the product frame, read the genesis hash from `DEFAULT_CHAIN` imported in the spec instead.

- [ ] **Step 8: Run the gates**

Run: `pnpm typecheck && pnpm vitest run && pnpm build && pnpm test && pnpm test:integration`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/browser/callbacks/ src/types.ts src/browser/control-api.ts src/playwright/fixture.ts test/integration.spec.ts
git commit -m "feat: let tests override feature support and the chain set"
```

---

### Task 6: Product storage seeding and inspection

**Files:**
- Modify: `src/browser/callbacks/storage.ts`, `src/browser/callbacks/index.ts`, `src/browser/callbacks/state.ts`
- Modify: `src/types.ts`, `src/browser/control-api.ts`, `src/playwright/fixture.ts`
- Test: `src/browser/callbacks/storage.spec.ts`, `test/integration.spec.ts`

**Interfaces:**
- Consumes: `createProductStorageCallbacks()`, which this task changes to `createProductStorageCallbacks(state: HostState)`.
- Produces: `seedProductStorage(key: string, value: string): void`, `getProductStorage(): Record<string, string>`, `clearProductStorage(): void` on `TestHostAPI`; `HostState.productStorage: Map<string, Uint8Array>`.

The store is currently a `Map` private to the closure, so a test can neither pre-populate it nor read what a product wrote. Moving it into `HostState` is the whole change. Values cross `page.evaluate` as UTF-8 strings, because a `Uint8Array` does not survive that boundary usefully; the callbacks keep bytes.

Do **not** touch `createCoreStorageCallbacks` — core storage holds AutoSigning keys and is out of scope.

- [ ] **Step 1: Add state**

`src/browser/callbacks/state.ts`, in `HostState` and `createHostState()`:

```ts
  /** What `productStorage` serves; seedable so a product can resume from prior state. */
  productStorage: Map<string, Uint8Array>;   // new Map()
```

- [ ] **Step 2: Write the failing test**

```ts
// src/browser/callbacks/storage.spec.ts
import { describe, expect, it } from 'vitest';
import { createProductStorageCallbacks } from './storage.js';
import { createHostState } from './state.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('product storage callbacks', () => {
  it('serves what a test seeded before the product asks', async () => {
    const state = createHostState();
    state.productStorage.set('token', bytes('seeded'));
    const { read } = createProductStorageCallbacks(state);
    expect(await read('token')).toEqual(bytes('seeded'));
  });

  it('exposes what the product wrote, and honours clear', async () => {
    const state = createHostState();
    const { read, write, clear } = createProductStorageCallbacks(state);

    await write('k', bytes('v'));
    expect(state.productStorage.get('k')).toEqual(bytes('v'));
    expect(await read('k')).toEqual(bytes('v'));

    await clear('k');
    expect(state.productStorage.has('k')).toBe(false);
    expect(await read('k')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run src/browser/callbacks/storage.spec.ts`
Expected: FAIL — `createProductStorageCallbacks` takes no arguments.

- [ ] **Step 4: Implement**

Change the signature to `createProductStorageCallbacks(state: HostState)` and replace the closure `const store = new Map<string, Uint8Array>();` with `state.productStorage`; the three method bodies are otherwise unchanged. Update the call site in `src/browser/callbacks/index.ts` to `createProductStorageCallbacks(state)`.

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run src/browser/callbacks/storage.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Add the control members and fixture surface**

`src/types.ts`:

```ts
  /** Pre-populate one product-storage entry; the value is stored as UTF-8. */
  seedProductStorage(key: string, value: string): void;
  /** Every product-storage entry, decoded as UTF-8. */
  getProductStorage(): Record<string, string>;
  /** Drop every product-storage entry. */
  clearProductStorage(): void;
```

`src/browser/control-api.ts`:

```ts
    seedProductStorage(key: string, value: string) {
      state.productStorage.set(key, new TextEncoder().encode(value));
    },

    getProductStorage() {
      const out: Record<string, string> = {};
      for (const [key, value] of state.productStorage) out[key] = new TextDecoder().decode(value);
      return out;
    },

    clearProductStorage() {
      state.productStorage.clear();
    },
```

Mirror all three on the fixture.

- [ ] **Step 7: Write the failing integration test**

```ts
// test/integration.spec.ts, in the existing `Local storage` describe
test('a product reads what the test seeded, and the test sees what it wrote', async ({ page, testHost }) => {
  await testHost.waitForConnection();
  await testHost.seedProductStorage('resume-token', 'abc');

  const read = await page.evaluate(() => window.__TEST_PRODUCT__.localStorageRead('resume-token'));
  expect(read.value).toBe('abc');

  await page.evaluate(() => window.__TEST_PRODUCT__.localStorageWrite('written', 'xyz'));
  await expect.poll(() => testHost.getProductStorage()).toMatchObject({ written: 'xyz' });
});
```

If the product's `localStorageRead` returns bytes rather than a string, assert on the decoded form the product already exposes rather than changing the product.

- [ ] **Step 8: Run the gates**

Run: `pnpm typecheck && pnpm vitest run && pnpm build && pnpm test && pnpm test:integration`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/browser/callbacks/ src/types.ts src/browser/control-api.ts src/playwright/fixture.ts test/integration.spec.ts
git commit -m "feat: let tests seed and inspect product storage"
```

---

### Task 7: Chat seeding

**Files:**
- Modify: `src/types.ts`, `src/browser/control-api.ts`, `src/playwright/fixture.ts`
- Test: `src/browser/callbacks/chat.spec.ts`, `test/integration.spec.ts`

**Interfaces:**
- Consumes: `HostState.chatRooms`, `HostState.chatBots`, and the `chatRoomSubscribers` push already used by `createChatCallbacks`.
- Produces: `seedChatRoom(room: ChatRoom): void` and `seedChatBot(bot: ChatBot): void` on `TestHostAPI`.

Chat state can only be created by driving the product today. A test that wants a product to *open* onto an existing room has no way to arrange it.

- [ ] **Step 1: Write the failing test**

Append to `src/browser/callbacks/chat.spec.ts`:

```ts
  it('a seeded room reaches a subscriber that is already listening', async () => {
    const state = createHostState();
    const { subscribeChatRooms } = createChatCallbacks(state);
    const items = subscribeChatRooms(product)[Symbol.asyncIterator]();
    await items.next();

    state.chatRooms.set('seeded', { roomId: 'seeded', name: 'Seeded', icon: 'https://example.com/i.png' });
    for (const notify of state.chatRoomSubscribers) notify([...state.chatRooms.values()]);

    const next = await items.next();
    expect(JSON.stringify(next.value)).toContain('seeded');
  });
```

Match the existing tests' assertion shape in that file for the subscription item rather than guessing; read them first.

- [ ] **Step 2: Run it**

Run: `pnpm vitest run src/browser/callbacks/chat.spec.ts`
Expected: PASS — this pins the mechanism the control members will use. If it fails, the push shape differs; fix the test to match `createChatCallbacks`, not the other way round.

- [ ] **Step 3: Add the control members**

`src/types.ts`:

```ts
  /** Add a chat room without the product creating it; live subscribers are notified. */
  seedChatRoom(room: ChatRoom): void;
  /** Add a chat bot without the product registering it. */
  seedChatBot(bot: ChatBot): void;
```

`src/browser/control-api.ts`:

```ts
    seedChatRoom(room: ChatRoom) {
      state.chatRooms.set(room.roomId, room);
      const rooms = [...state.chatRooms.values()];
      for (const notify of state.chatRoomSubscribers) notify(rooms);
    },

    seedChatBot(bot: ChatBot) {
      state.chatBots.set(bot.botId, bot);
    },
```

Match the real key fields and the real notify signature used by `createChatCallbacks` — read it rather than assuming `roomId` / `botId`.

Mirror both on the fixture.

- [ ] **Step 4: Write the failing integration test**

```ts
// test/integration.spec.ts, in the existing `Chat` describe
test('a product sees a room the test seeded', async ({ page, testHost }) => {
  await testHost.waitForConnection();
  await page.evaluate(() => window.__TEST_PRODUCT__.subscribeChatRooms?.());
  await testHost.seedChatRoom({ roomId: 'seeded', name: 'Seeded', icon: 'https://example.com/i.png' });

  await expect.poll(() => testHost.getChatRooms()).toContainEqual(
    expect.objectContaining({ roomId: 'seeded' }),
  );
});
```

Chat requires `executionKind: 'Worker'` — this test must be inside a describe that configures it, as the existing chat tests do.

- [ ] **Step 5: Run the gates**

Run: `pnpm typecheck && pnpm vitest run && pnpm build && pnpm test && pnpm test:integration`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/browser/callbacks/chat.spec.ts src/types.ts src/browser/control-api.ts src/playwright/fixture.ts test/integration.spec.ts
git commit -m "feat: let tests seed chat rooms and bots"
```

---

### Task 8: The permissionStatus group

**Files:**
- Create: `src/browser/callbacks/permission-status.ts`
- Modify: `src/browser/callbacks/index.ts`, `src/browser/callbacks/state.ts`
- Modify: `src/types.ts`, `src/browser/control-api.ts`, `src/playwright/fixture.ts`
- Test: `src/browser/callbacks/permission-status.spec.ts`

**Interfaces:**
- Produces: `createPermissionStatusCallbacks(state: HostState): { devicePermissionStatus(request: HostDevicePermissionRequest): Promise<DevicePermissionStatus> }`; `setDevicePermissionStatus(type: string, status: string): void` and `getDevicePermissionStatuses(): Record<string, string>` on `TestHostAPI`; `HostState.devicePermissionStatuses: Map<string, DevicePermissionStatus>`.

`permissionStatus` is an optional group this host has never wired. It answers "what is the current state of this device permission" without prompting — distinct from `permissions.devicePermission`, which asks.

- [ ] **Step 1: Read the real types**

Read `PermissionStatusHost` and `DevicePermissionStatus` in `node_modules/@parity/truapi-host/dist/generated/host-callbacks.d.ts`. `DevicePermissionStatus` is a fixed union — use the real variant spellings in the test below rather than the placeholders, and say in your report what they are.

- [ ] **Step 2: Add state**

`src/browser/callbacks/state.ts`, in `HostState` and `createHostState()`:

```ts
  /** Device-permission type → reported status; unset types report the default. */
  devicePermissionStatuses: Map<string, DevicePermissionStatus>;   // new Map()
```

- [ ] **Step 3: Write the failing test**

```ts
// src/browser/callbacks/permission-status.spec.ts
import { describe, expect, it } from 'vitest';
import { createPermissionStatusCallbacks } from './permission-status.js';
import { createHostState } from './state.js';

describe('permission status callbacks', () => {
  it('reports the default until a test sets one', async () => {
    const state = createHostState();
    const { devicePermissionStatus } = createPermissionStatusCallbacks(state);
    const request = { permission: { tag: 'Camera', value: undefined } } as const;

    const before = await devicePermissionStatus(request);
    state.devicePermissionStatuses.set('Camera', 'Denied');
    const after = await devicePermissionStatus(request);

    expect(after).not.toEqual(before);
    expect(after).toBe('Denied');
  });
});
```

Correct `'Denied'`, the request shape and the default to whatever the real types say — step 1 is what tells you.

- [ ] **Step 4: Run it and watch it fail**

Run: `pnpm vitest run src/browser/callbacks/permission-status.spec.ts`
Expected: FAIL — cannot resolve `./permission-status.js`.

- [ ] **Step 5: Implement**

```ts
// src/browser/callbacks/permission-status.ts
import type { DevicePermissionStatus, HostDevicePermissionRequest } from '@parity/truapi-host';
import type { HostState } from './state.js';

const DEFAULT_STATUS: DevicePermissionStatus = 'Granted';

export function createPermissionStatusCallbacks(state: HostState): {
  devicePermissionStatus(request: HostDevicePermissionRequest): Promise<DevicePermissionStatus>;
} {
  return {
    async devicePermissionStatus(
      request: HostDevicePermissionRequest,
    ): Promise<DevicePermissionStatus> {
      return state.devicePermissionStatuses.get(request.permission.tag) ?? DEFAULT_STATUS;
    },
  };
}
```

`DEFAULT_STATUS` must agree with `permissions.devicePermission`'s default answer — this host grants device permissions by default, so a status of anything else would contradict it. Check `permissions.ts` and match.

- [ ] **Step 6: Wire it in**

Add `permissionStatus: createPermissionStatusCallbacks(state),` to the object in `src/browser/callbacks/index.ts`. It is an optional member of `RequiredHostCallbacks`, so this is additive.

- [ ] **Step 7: Add the control members and fixture surface**

`setDevicePermissionStatus(type: string, status: string): void` and `getDevicePermissionStatuses(): Record<string, string>` on `TestHostAPI`, writing into and reading out of the map; both mirrored on the fixture.

- [ ] **Step 8: Run the gates**

Run: `pnpm typecheck && pnpm vitest run && pnpm build && pnpm test && pnpm test:integration`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/browser/callbacks/permission-status.ts src/browser/callbacks/permission-status.spec.ts src/browser/callbacks/index.ts src/browser/callbacks/state.ts src/types.ts src/browser/control-api.ts src/playwright/fixture.ts
git commit -m "feat: wire the permission-status group with a test override"
```

---

### Task 9: Initial configuration

**Files:**
- Modify: `src/types.ts`, `src/host-page.ts`, `src/browser/host-runtime.ts`, `src/playwright/fixture.ts`
- Test: `test/integration.spec.ts`, `test-exports-esm.mjs`, `test-exports-cjs.cjs`

**Interfaces:**
- Consumes: every `HostState` field added in Tasks 2–8.
- Produces: `CreateTestHostOptions.initialState?: InitialState` and `CreateTestHostOptions.behaviors?: InitialBehaviors`, plus the same two on `TestHostFixtureOptions`.

A product that reads the theme or locale during startup exercises a different path from one mutated after boot. Only the second is testable today. This applies the overrides to `HostState` **before** `createIframeHost` runs, so the product's first frame already sees them.

Only the serialisable subset is configurable here — behaviours are `'approve-all' | 'reject-all'` only, since a function cannot cross into the page config.

- [ ] **Step 1: Add the option types**

`src/types.ts`:

```ts
/** Host state applied before the product's first frame. */
export interface InitialState {
  theme?: ThemeInput;
  locale?: string;
  /** Feature tag → forced `featureSupported` answer. */
  features?: Record<string, boolean>;
  /** Product-storage entries, stored as UTF-8. */
  productStorage?: Record<string, string>;
  /** Device-permission type → reported status. */
  devicePermissionStatuses?: Record<string, string>;
  grantedPermissions?: string[];
}

/** Decision policies applied before the product's first frame. */
export interface InitialBehaviors {
  permission?: 'approve-all' | 'reject-all';
  userConfirmation?: 'approve-all' | 'reject-all';
  navigation?: 'approve-all' | 'reject-all';
  notification?: 'approve-all' | 'reject-all';
}
```

and on `CreateTestHostOptions`:

```ts
  /** Host state applied before the product loads. */
  initialState?: InitialState;
  /** Decision policies applied before the product loads. */
  behaviors?: InitialBehaviors;
```

- [ ] **Step 2: Serialise them into the page config**

In `src/host-page.ts`, add `initialState` and `behaviors` to the `HostPageConfig` interface and include them in the `JSON.stringify` payload, omitting each key when unset — the same `...(x && { x })` shape the file already uses for `productAccounts`.

- [ ] **Step 3: Apply them at boot**

In `src/browser/host-runtime.ts`, immediately after `const state = createHostState();` and **before** the runtime is created, add one function and call it:

```ts
/** Apply the page config's overrides before the product can observe anything. */
function applyInitialConfig(state: HostState, config: HostConfig): void {
  const initial = config.initialState;
  if (initial?.theme) state.theme = normalizeTheme(initial.theme);
  if (initial?.locale) state.locale = initial.locale;
  for (const [feature, supported] of Object.entries(initial?.features ?? {})) {
    state.featureOverrides.set(feature, supported);
  }
  for (const [key, value] of Object.entries(initial?.productStorage ?? {})) {
    state.productStorage.set(key, new TextEncoder().encode(value));
  }
  for (const [type, status] of Object.entries(initial?.devicePermissionStatuses ?? {})) {
    state.devicePermissionStatuses.set(type, status as DevicePermissionStatus);
  }
  for (const tag of initial?.grantedPermissions ?? []) state.grantedPermissions.add(tag);

  const behaviors = config.behaviors;
  if (behaviors?.permission) state.permissionBehavior = behaviors.permission;
  if (behaviors?.userConfirmation) state.userConfirmationBehavior = behaviors.userConfirmation;
  if (behaviors?.navigation) state.navigationBehavior = behaviors.navigation;
  if (behaviors?.notification) state.notificationBehavior = behaviors.notification;
}
```

`normalizeTheme` already exists in `src/browser/control-api.ts` but is module-private — export it there and import it here rather than writing a second one, so `initialState.theme` and `setTheme` cannot diverge on what `'dark'` means. `state.grantedPermissions` is a `Set<string>`, so `add` is correct. The `status as DevicePermissionStatus` cast is the one place a string from JSON meets the typed union; validate it against the union's members and throw on an unknown value rather than casting blindly.

- [ ] **Step 4: Add the fixture options**

In `src/playwright/fixture.ts`, add `initialState?: InitialState` and `behaviors?: InitialBehaviors` to `TestHostFixtureOptions` and pass both straight through to `createTestHostServer`.

- [ ] **Step 5: Write the failing integration test**

```ts
// test/integration.spec.ts — a new describe with its own fixture configuration
test.describe('Initial configuration', () => {
  const testHost = createTestHostFixture({
    productUrl: PRODUCT_URL,
    initialState: { locale: 'pt-BR', theme: 'dark' },
    behaviors: { userConfirmation: 'reject-all' },
  });

  test('the product boots into the configured condition', async ({ page, testHost: host }) => {
    await host.waitForConnection();
    expect(await host.getLocale()).toBe('pt-BR');
    expect((await host.getTheme()).variant).toBe('Dark');
  });
});
```

Match however the existing suite builds a fixture with non-default options — the chat describe already configures `executionKind`, so follow that shape exactly rather than inventing one.

- [ ] **Step 6: Extend the export smoke tests**

In `test-exports-esm.mjs` and `test-exports-cjs.cjs`, extend the existing `productAccounts config` test (do not add a new one — the count stays at 22) to also pass `initialState` and `behaviors` to `createTestHostServer` and assert the generated HTML contains the configured locale.

- [ ] **Step 7: Run the gates**

Run: `pnpm typecheck && pnpm vitest run && pnpm build && pnpm test && pnpm test:integration`
Expected: all PASS, `pnpm test` still 22.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/host-page.ts src/browser/host-runtime.ts src/playwright/fixture.ts test/ test-exports-esm.mjs test-exports-cjs.cjs
git commit -m "feat: configure host state and behaviours before the product loads"
```

---

### Task 10: Exports, documentation and the release unit

**Files:**
- Modify: `src/index.ts`, `src/playwright/index.ts`
- Modify: `package.json`, `CHANGELOG.md`, `forum-post.md`, `README.md`

**Interfaces:**
- Consumes: every public type added in Tasks 1–9.

CLAUDE.md requires the four release files to move with the code as one atomic unit. 0.13.0 is unreleased, so this feature folds into it rather than taking its own version.

- [ ] **Step 1: Export the new types**

Add to `src/index.ts`'s type exports: `Behavior`, `UserConfirmationBehavior`, `UserConfirmationLogEntry`, `NavigationBehavior`, `NotificationBehavior`, `ChainEntry`, `InitialState`, `InitialBehaviors`. Add to `src/playwright/index.ts` the subset a test file needs directly: `InitialState`, `InitialBehaviors`, `UserConfirmationBehavior`.

- [ ] **Step 2: Verify the published types still resolve**

Run: `pnpm build && pnpm test`
Expected: PASS. Then run `grep -n "@parity/truapi-host" dist/*.d.ts dist/**/*.d.ts` — expected: no matches. `src/types.ts` must not name the devDependency in emitted output; if it does, mirror the offending type locally with a drift guard as `ProductExecutionKind` already does.

- [ ] **Step 3: Document the override surface in the README**

Add one "Overriding host conditions" section with the two families stated once, a table of every override member, and one worked example using `initialState`. Do not document each member in prose — the table plus the naming rule is the point.

- [ ] **Step 4: Update the CHANGELOG**

Under the existing `## 0.13.0`, add to **Added** every new control member and option by name so an upgrader can grep, and to **Breaking changes** the `clearChatState` → `clearChat` rename.

- [ ] **Step 5: Update the forum post**

Add a short section to the 0.13.0 entry: what conditions a product can now be tested under, the two families, and the `initialState` example. Keep it to a few paragraphs.

- [ ] **Step 6: Full verification**

```bash
pnpm typecheck && pnpm vitest run && pnpm build && pnpm test && pnpm test:integration
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/playwright/index.ts package.json CHANGELOG.md forum-post.md README.md
git commit -m "docs: document the handler override surface"
```

---

## Notes for the executor

- Tasks 2–8 are independent of each other and all depend only on Task 1. Task 9 depends on all of them; Task 10 depends on Task 9.
- Every task adds state to `src/browser/callbacks/state.ts`. Expect to touch that file in most tasks; it is the intended seam, not a smell.
- Where a plan step names a type shape (`UserConfirmationReview`, `DevicePermissionStatus`, the chat key fields), read the real typing on disk first and correct the step. The plan's job is to name the file and the intent; the typings are the authority.
