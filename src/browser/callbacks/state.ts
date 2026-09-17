/**
 * Mutable state backing the host callback groups.
 *
 * A plain object rather than a class: Task 14's control API (the
 * `window.__TEST_HOST__` surface) reads and mutates these fields directly —
 * pushing log entries, swapping `permissionBehavior`, replacing `theme` and
 * notifying `themeSubscribers` — the same way the pre-migration
 * `src/browser/host-runtime.ts` mutated its module-level `let`/`const`
 * state. Keeping it a bag of fields (not private closures) is what makes
 * that direct mutation possible.
 */

/**
 * Controls how the host answers `permissions.remotePermission` and
 * `permissions.devicePermission`. Ported from the pre-migration
 * `PermissionBehavior` semantics in `src/types.ts` / `host-runtime.ts`.
 */
export type PermissionBehavior = 'approve-all' | 'reject-all' | ((tag: string, value: unknown) => boolean);

export interface PermissionLogEntry {
  tag: string;
  value: unknown;
  approved: boolean;
  timestamp: number;
}

export interface NavigationLogEntry {
  url: string;
  timestamp: number;
}

export interface NotificationLogEntry {
  id: number;
  text: string;
  deeplink: string | undefined;
  scheduledAt: bigint | undefined;
  cancelled: boolean;
  timestamp: number;
}

/** Structurally identical to the generated `HostThemeSubscribeItem`. */
export interface Theme {
  name: { tag: 'Default'; value?: undefined } | { tag: 'Custom'; value: string };
  variant: 'Light' | 'Dark';
}

export interface PreimageEntry {
  /** Lowercased `0x`-hex blake2b-256 key. */
  key: string;
  value: Uint8Array;
  /** True when submitted by the product rather than seeded by a test. */
  fromProduct: boolean;
  timestamp: number;
}

export interface HostState {
  permissionBehavior: PermissionBehavior;
  grantedPermissions: Set<string>;
  permissionLog: PermissionLogEntry[];
  navigationLog: NavigationLogEntry[];
  notificationLog: NotificationLogEntry[];

  theme: Theme;
  /** Active `theme.subscribeTheme()` listeners; notified when `theme` changes. */
  themeSubscribers: Set<(theme: Theme) => void>;

  /** BCP 47 language tag. No pre-migration analogue — a single static default. */
  locale: string;
  /** Active `locale.subscribeLocale()` listeners; notified when `locale` changes. */
  localeSubscribers: Set<(locale: string) => void>;

  /** Known preimages, keyed the same way as `preimageSubscribers`. */
  preimages: Map<string, PreimageEntry>;
  /** Listeners waiting on one preimage key, keyed by lowercased `0x`-hex. */
  preimageSubscribers: Map<string, Set<(value: Uint8Array | undefined) => void>>;
}

export function createHostState(): HostState {
  return {
    permissionBehavior: 'approve-all',
    grantedPermissions: new Set(),
    permissionLog: [],
    navigationLog: [],
    notificationLog: [],

    theme: { name: { tag: 'Default', value: undefined }, variant: 'Light' },
    themeSubscribers: new Set(),

    locale: 'en',
    localeSubscribers: new Set(),

    preimages: new Map(),
    preimageSubscribers: new Map(),
  };
}
