/**
 * Browser-side host runtime — bundled by esbuild into a single IIFE.
 *
 * Reads config from window.__TEST_HOST_CONFIG__, initialises crypto,
 * derives dev keypairs, creates a Spektr host-container for the product
 * iframe, and registers all required handlers (accounts, signing,
 * chain RPC, localStorage).
 *
 * Exposes window.__TEST_HOST__ for Playwright control.
 */

import {
  ChatMessagePostingErr,
  CreateProofErr,
  CreateTransactionErr,
  DeriveEntropyErr,
  GenericError,
  GetUserIdErr,
  LoginErr,
  NavigateToErr,
  PaymentRequestErr,
  PaymentTopUpErr,
  GetAliasErr,
  PreimageSubmitErr,
  RequestCredentialsErr,
  SigningErr,
} from "@novasamatech/host-api";
import type { CodecType, DerivationIndex } from "@novasamatech/host-api";
import type { Container } from "@novasamatech/host-container";
import {
  createContainer,
  deriveProductEntropy,
} from "@novasamatech/host-container";
import { Keyring } from "@polkadot/keyring";
import type { KeyringPair } from "@polkadot/keyring/types";
import { TypeRegistry } from "@polkadot/types";
import { compactToU8a, hexToU8a, u8aToHex } from "@polkadot/util";
import {
  blake2AsHex,
  blake2AsU8a,
  cryptoWaitReady,
} from "@polkadot/util-crypto";
import { ResultAsync } from "neverthrow";
import { getWsProvider } from "polkadot-api/ws";

import { createDualChannelIframeProvider } from "./truapi-port-handoff.js";
import type {
  ChatBot,
  ChatMessageLogEntry,
  ChatRoom,
  HexString,
  LoginBehavior,
  NavigationLogEntry,
  NotificationLogEntry,
  PaymentLogEntry,
  PaymentTopUpBehavior,
  PermissionBehavior,
  PermissionLogEntry,
  PreimageEntry,
  SigningLogEntry,
  StatementSubmissionLogEntry,
  TestHostAPI,
  Theme,
  ThemeInput,
} from "../types.js";

interface AccountConfig {
  name: string;
  uri: string;
}

interface ChainRuntimeConfig {
  genesisHash: string;
  rpcUrl: string;
  name: string;
}

interface HostConfig {
  productUrl: string;
  accounts: AccountConfig[];
  /** Networks the host can route, matched by genesis. First is the default. */
  networks: ChainRuntimeConfig[];
  /** Maps "dotnsId/index" → { name, uri } for product account overrides. */
  productAccounts?: Record<string, AccountConfig>;
  /** Post proof requests to the server for real ring-VRF proofs. */
  ringVrfProofs?: boolean;
}

declare global {
  interface Window {
    __TEST_HOST_CONFIG__: HostConfig;
    __TEST_HOST__: TestHostAPI;
  }
}

const signingLog: SigningLogEntry[] = [];
const permissionLog: PermissionLogEntry[] = [];
const navigationLog: NavigationLogEntry[] = [];
const notificationLog: NotificationLogEntry[] = [];
const grantedPermissions = new Set<string>();
const chatRooms = new Map<string, ChatRoom>();
const chatBots = new Map<string, ChatBot>();
const chatMessageLog: ChatMessageLogEntry[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chatActionSubscribers = new Set<(payload: any) => void>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chatListSubscribers = new Set<(room: any) => void>();
let chatMessageCounter = 0;
/** preimages: hex key → entry */
const preimages = new Map<string, PreimageEntry>();
/** key → set of subscriber callbacks waiting for that preimage */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const preimageSubscribers = new Map<string, Set<(value: any) => void>>();
const statementStore: unknown[] = [];
const submittedStatements: StatementSubmissionLogEntry[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const statementSubscribers = new Set<{
  filter: { tag: string; value: Uint8Array[] };
  send: (s: any) => void;
}>();
const paymentLog: PaymentLogEntry[] = [];
let paymentBalance: bigint = 0n;
let paymentTopUpBehavior: PaymentTopUpBehavior = "ok";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const paymentBalanceSubscribers = new Set<(balance: any) => void>();
const paymentStatuses = new Map<string, { tag: string; value?: string }>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const paymentStatusSubscribers = new Map<string, Set<(status: any) => void>>();
let paymentCounter = 0;
let nextNotificationId = 1;
let currentTheme: Theme = {
  name: { tag: "Default", value: undefined },
  variant: "Light",
};
const themeSubscribers = new Set<(theme: Theme) => void>();

function normalizeTheme(input: ThemeInput): Theme {
  if (input === "light" || input === "dark") {
    return {
      name: { tag: "Default", value: undefined },
      variant: input === "light" ? "Light" : "Dark",
    };
  }
  return input;
}
let loginBehavior: LoginBehavior = "success";
let isAuthenticated = false;
let permissionBehavior: PermissionBehavior = "approve-all";
let enforcePermissions = true;
let connectionStatus = "connecting";
let chainStatus = "connecting";
let currentContainer: Container | null = null;
let keyring: Keyring;
const pairsByUri = new Map<string, KeyringPair>();
const urisByPair = new Map<KeyringPair, string>();

/** Maps host-api device permission names to Permissions Policy directives (matching dot.li). */
const DEVICE_PERMISSION_POLICY: Record<string, string> = {
  Camera: "camera",
  Microphone: "microphone",
  Location: "geolocation",
  Bluetooth: "bluetooth",
  NFC: "nfc",
  Clipboard: "clipboard-read",
  Biometrics: "publickey-credentials-get",
};

/** Normalize a genesis hash for comparison — handles different types and casing */
function normalizeHash(value: unknown): string {
  const str = String(value).toLowerCase().trim();
  return str.startsWith("0x") ? str : `0x${str}`;
}

function getPair(uri: string): KeyringPair {
  let pair = pairsByUri.get(uri);
  if (!pair) {
    pair = keyring.addFromUri(uri);
    pairsByUri.set(uri, pair);
    urisByPair.set(pair, uri);
  }
  return pair;
}

function getPairByPublicKey(pubkey: Uint8Array): KeyringPair | undefined {
  const target = u8aToHex(pubkey).toLowerCase();
  for (const pair of pairsByUri.values()) {
    if (u8aToHex(pair.publicKey).toLowerCase() === target) return pair;
  }
  return undefined;
}

/**
 * Build a v4 signed extrinsic from a SCALE-encoded call plus per-extension
 * `extra` / `additionalSigned` blobs, signed sr25519 by `pair`.
 *
 * Layout (with outer SCALE-compact length prefix — what RPC and polkadot-api
 * decoders expect on the wire):
 *   [compact len]                   length of the bytes that follow
 *   [0x84]                          version 4 + signed bit
 *   [0x00][AccountId32]             MultiAddress::Id
 *   [0x01][signature 64B]           MultiSignature::Sr25519
 *   [extras concat]                 each extension's `extra` in order
 *   [callData]
 *
 * Signing payload is `callData || extras || additionalSigned`; if longer than
 * 256 bytes, sign blake2_256(payload) per Substrate convention.
 */
function buildSignedV4Extrinsic(
  pair: KeyringPair,
  callData: Uint8Array,
  extensions: ReadonlyArray<{
    extra: Uint8Array;
    additionalSigned: Uint8Array;
  }>,
): Uint8Array {
  let extrasLen = 0;
  let addlLen = 0;
  for (const e of extensions) {
    extrasLen += e.extra.length;
    addlLen += e.additionalSigned.length;
  }
  const extras = new Uint8Array(extrasLen);
  const addls = new Uint8Array(addlLen);
  let o = 0;
  for (const e of extensions) {
    extras.set(e.extra, o);
    o += e.extra.length;
  }
  o = 0;
  for (const e of extensions) {
    addls.set(e.additionalSigned, o);
    o += e.additionalSigned.length;
  }

  const payload = new Uint8Array(
    callData.length + extras.length + addls.length,
  );
  payload.set(callData, 0);
  payload.set(extras, callData.length);
  payload.set(addls, callData.length + extras.length);

  const toSign = payload.length > 256 ? blake2AsU8a(payload, 256) : payload;
  const signature = pair.sign(toSign); // sr25519, 64 bytes

  const inner = new Uint8Array(
    1 + 1 + 32 + 1 + 64 + extras.length + callData.length,
  );
  let p = 0;
  inner[p++] = 0x84;
  inner[p++] = 0x00;
  inner.set(pair.publicKey, p);
  p += 32;
  inner[p++] = 0x01;
  inner.set(signature, p);
  p += 64;
  inner.set(extras, p);
  p += extras.length;
  inner.set(callData, p);

  const lenPrefix = compactToU8a(inner.length);
  const out = new Uint8Array(lenPrefix.length + inner.length);
  out.set(lenPrefix, 0);
  out.set(inner, lenPrefix.length);
  return out;
}

function getPairByAddress(address: string): KeyringPair | undefined {
  for (const pair of pairsByUri.values()) {
    if (pair.address === address) return pair;
  }
  // Try matching by public key hex (product-sdk sends 0x + hex(publicKey))
  const normalized = address.toLowerCase();
  for (const pair of pairsByUri.values()) {
    if (u8aToHex(pair.publicKey).toLowerCase() === normalized) return pair;
  }
  // Try matching by SS58 re-encoding (address might be in different SS58 format)
  for (const pair of pairsByUri.values()) {
    try {
      if (keyring.encodeAddress(pair.publicKey) === address) return pair;
    } catch {
      // ignore decoding errors
    }
  }
  return undefined;
}

/**
 * Canonical string form of an RFC-0022 account selector.
 *
 * `Index(n)` renders as the plain number, so `productAccounts` keys and the
 * derivation URIs this host builds are byte-identical to the pre-RFC-0022
 * ones — existing configs and derived addresses keep working. `Raw(bytes)`
 * renders as its hex, the form byte-valued selectors take everywhere else.
 */
function selectorKey(index: CodecType<typeof DerivationIndex>): string {
  return index.tag === "Index" ? String(index.value) : u8aToHex(index.value);
}

/** Ask the test-host server for a real ring-VRF proof over `message`. */
async function fetchServerRingProof(
  uri: string | undefined,
  productId: string,
  suffix: CodecType<typeof DerivationIndex>,
  message: Uint8Array,
) {
  if (!uri) throw new Error("No account connected to prove with");
  const response = await fetch("/__create-proof", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      uri,
      productId,
      suffix:
        suffix.tag === "Raw"
          ? { tag: "Raw", value: u8aToHex(suffix.value) }
          : suffix,
      message: u8aToHex(message),
    }),
  });
  const payload = (await response.json()) as {
    proof: `0x${string}`;
    context: `0x${string}`;
    alias: `0x${string}`;
    ringIndex: number;
    ringRevision: number;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? `proof request failed (${response.status})`);
  }
  return {
    proof: hexToU8a(payload.proof),
    contextualAlias: {
      context: hexToU8a(payload.context),
      alias: hexToU8a(payload.alias),
    },
    ringIndex: payload.ringIndex,
    ringRevision: payload.ringRevision,
  };
}

/** Resolve a product account [dotnsId, derivationIndex] to a keypair. */
function getPairForProductAccount(
  config: HostConfig,
  pairs: { pair: KeyringPair; name: string }[],
  dotnsId: string,
  index: CodecType<typeof DerivationIndex>,
): KeyringPair | undefined {
  const idx = selectorKey(index);
  const key = `${dotnsId}/${idx}`;
  const override = config.productAccounts?.[key];
  if (override) {
    return getPair(override.uri);
  }
  if (pairs.length === 0) return undefined;
  const selectedAccUri = urisByPair.get(pairs[0].pair);
  return getPair(`${selectedAccUri}//${dotnsId}/${idx}`);
}

/**
 * Build the iframe `allow` attribute from granted device permissions.
 * Always includes clipboard directives; adds Permissions Policy directives
 * for each granted device permission — matching dot.li's buildAllowAttribute.
 */
function buildAllowAttribute(): string {
  const policies = ["clipboard-read", "clipboard-write"];
  for (const tag of grantedPermissions) {
    const directive = DEVICE_PERMISSION_POLICY[tag];
    if (directive) {
      policies.push(directive);
    }
  }
  return policies.join("; ");
}

/** Update the product iframe's `allow` attribute from current granted device permissions. */
function updateIframeAllow(): void {
  const iframeEl = document.getElementById(
    "product-frame",
  ) as HTMLIFrameElement;
  if (iframeEl) {
    iframeEl.allow = buildAllowAttribute();
  }
}

function setupContainer(
  iframe: HTMLIFrameElement,
  config: HostConfig,
  accountsOverride?: AccountConfig[],
): Container {
  // Reset permission and activity logs on container recreation — matches real
  // hosts where permissions are per-session, not carried across reconnects.
  grantedPermissions.clear();
  permissionLog.length = 0;
  navigationLog.length = 0;
  notificationLog.length = 0;
  chatRooms.clear();
  chatBots.clear();
  chatMessageLog.length = 0;
  chatActionSubscribers.clear();
  chatListSubscribers.clear();
  chatMessageCounter = 0;
  preimages.clear();
  preimageSubscribers.clear();
  statementStore.length = 0;
  submittedStatements.length = 0;
  statementSubscribers.clear();
  paymentLog.length = 0;
  paymentBalance = 0n;
  paymentTopUpBehavior = "ok";
  paymentBalanceSubscribers.clear();
  paymentStatuses.clear();
  paymentStatusSubscribers.clear();
  paymentCounter = 0;
  themeSubscribers.clear();

  const provider = createDualChannelIframeProvider({
    iframe,
    url: config.productUrl,
  });
  const container = createContainer(provider);

  // Derive keypairs for all requested accounts
  const accounts = accountsOverride ?? config.accounts;
  const pairs = accounts.map((acc) => {
    const pair = getPair(acc.uri);
    return { pair, name: acc.name };
  });

  // Also derive keypairs for product account overrides so signing works
  if (config.productAccounts) {
    for (const acc of Object.values(config.productAccounts)) {
      getPair(acc.uri); // registers in pairsByUri for signing lookups
    }
  }

  // Every network the host can route, matched by genesis. Apps that read more
  // than one chain (e.g. Asset Hub + People) need each genesis to resolve.
  const routableChains = config.networks;
  const findChain = (genesis: unknown): ChainRuntimeConfig | undefined => {
    const requested = normalizeHash(genesis);
    return routableChains.find(
      (c) => normalizeHash(c.genesisHash) === requested,
    );
  };

  container.handleFeatureSupported((params, { ok }) => {
    if (params.tag === "Chain") {
      const match = findChain(params.value);
      if (!match) {
        console.warn(
          `[test-host] Chain feature check MISMATCH:\n` +
            `  requested: ${String(params.value)} (type: ${typeof params.value})\n` +
            `  routable: ${routableChains.map((c) => c.genesisHash).join(", ")}`,
        );
      }
      return ok(!!match);
    }
    return ok(false);
  });

  container.handlePermission((params, { ok }) => {
    // params is a single RemotePermission { tag, value }
    let approved: boolean;
    if (permissionBehavior === "approve-all") {
      approved = true;
    } else if (permissionBehavior === "reject-all") {
      approved = false;
    } else {
      approved = permissionBehavior(params.tag, params.value);
    }

    if (approved) {
      grantedPermissions.add(params.tag);
    }

    permissionLog.push({
      tag: params.tag,
      value: params.value,
      approved,
      timestamp: Date.now(),
    });

    console.log(
      `[test-host] Permission ${approved ? "granted" : "denied"}:`,
      params.tag,
    );
    return ok(approved);
  });

  // Matches real host behavior: product must request device permissions
  // (Camera, Microphone, Location, Bluetooth). When granted, the iframe
  // `allow` attribute is updated and the iframe reloads (matching dot.li).

  container.handleDevicePermission((permission, { ok }) => {
    let approved: boolean;
    if (permissionBehavior === "approve-all") {
      approved = true;
    } else if (permissionBehavior === "reject-all") {
      approved = false;
    } else {
      approved = permissionBehavior(permission, undefined);
    }

    if (approved) {
      grantedPermissions.add(permission);
    }

    permissionLog.push({
      tag: permission,
      value: undefined,
      approved,
      timestamp: Date.now(),
    });

    console.log(
      `[test-host] Device permission ${approved ? "granted" : "denied"}:`,
      permission,
    );

    if (approved) {
      // Update iframe allow attribute. In dot.li the iframe reloads for the
      // new Permissions Policy to take effect; here we update the attribute
      // so it applies on the next navigation or container recreation.
      updateIframeAllow();
    }

    return ok(approved);
  });

  chainStatus = "idle";
  // One ws provider per routable network, created lazily on first connection
  // and keyed by normalized genesis so multiple chains coexist.
  const providerByGenesis = new Map<string, ReturnType<typeof getWsProvider>>();

  container.handleChainConnection((requestedGenesisHash) => {
    const match = findChain(requestedGenesisHash);
    if (!match) {
      console.warn(
        "[test-host] Unsupported chain requested:",
        requestedGenesisHash,
      );
      return null;
    }
    const key = normalizeHash(match.genesisHash);
    let provider = providerByGenesis.get(key);
    if (!provider) {
      provider = getWsProvider(match.rpcUrl);
      providerByGenesis.set(key, provider);
    }
    chainStatus = "connected";
    console.log("[test-host] Chain connection established for", match.name);
    return provider;
  });

  container.handleGetLegacyAccounts((_, { ok }) => {
    return ok(
      pairs.map(({ pair, name }) => ({
        publicKey: pair.publicKey,
        name,
      })),
    );
  });

  // Product accounts: when the product calls getProductAccount(dotnsId, index),
  // look up "dotnsId/index" in the productAccounts map. If found, return that
  // account. Otherwise derive as production: //Bob//dotnsId/index.
  //
  // This lets tests map product accounts to funded dev accounts:
  //   productAccounts: { 'myapp.dot/0': 'bob' }
  //   → getProductAccount("myapp.dot", 0) returns //Bob's keypair
  container.handleAccountGet((params, { ok, err }) => {
    const idx = selectorKey(params[1]);
    const key = `${params[0]}/${idx}`;
    const override = config.productAccounts?.[key];

    if (override) {
      const pair = getPair(override.uri);
      return ok({ publicKey: pair.publicKey });
    }

    if (pairs.length === 0) {
      return err(new RequestCredentialsErr.NotConnected(undefined));
    }

    // Default: derive from the selected account (production behavior)
    const selectedPair = pairs[0];
    const selectedAccUri = urisByPair.get(selectedPair.pair);
    const productPair = getPair(`${selectedAccUri}//${params[0]}/${idx}`);
    return ok({ publicKey: productPair.publicKey });
  });

  container.handleAccountConnectionStatusSubscribe((_, send) => {
    send(pairs.length > 0 ? "connected" : "disconnected");
    // No dynamic updates — static test accounts
    return () => {};
  });

  // Ring VRF alias: real hosts derive a context-specific alias via
  // session.getRingVrfAlias(). For test purposes, return a deterministic
  // (context, alias) pair derived from the product account — stable across
  // runs so tests can assert exact values if needed.
  container.handleAccountGetAlias((params, { ok, err }) => {
    // RFC-0022: the request is now [ProductProofContext, RingLocation], where
    // the context is [productId, suffix] — the same shape (and the identity
    // mapping) as a ProductAccountId, so the account lookup is unchanged.
    const [[productId, suffix]] = params;
    const idx = selectorKey(suffix);
    const key = `${productId}/${idx}`;
    const override = config.productAccounts?.[key];

    if (!override && pairs.length === 0) {
      return err(new GetAliasErr.Unknown({ reason: "No accounts connected" }));
    }

    const pair = override
      ? getPair(override.uri)
      : getPair(`${urisByPair.get(pairs[0].pair)}//${productId}/${idx}`);

    // Deterministic 32-byte context and alias from the account's public key.
    const context = blake2AsU8a(
      new Uint8Array([
        ...pair.publicKey,
        ...new TextEncoder().encode("context"),
      ]),
      256,
    );
    const alias = blake2AsU8a(
      new Uint8Array([...pair.publicKey, ...new TextEncoder().encode("alias")]),
      256,
    );
    return ok({ context, alias });
  });

  // Ring VRF proof. With `ringVrfProofs` configured, the server builds a real
  // bandersnatch proof, since it holds the wasm prover. Otherwise sign the
  // message with the product account sr25519 key as a stand-in.
  container.handleAccountCreateProof((params, { ok }) => {
    const [[productId, suffix], _ringLocation, message] = params;

    if (config.ringVrfProofs) {
      // Account precedence, including setAccounts overrides, lives here in
      // the browser, so the URI to prove with resolves here and the server
      // stays a pure prover.
      const key = `${productId}/${selectorKey(suffix)}`;
      const uri =
        config.productAccounts?.[key]?.uri ??
        (pairs.length > 0 ? urisByPair.get(pairs[0].pair) : undefined);
      return ResultAsync.fromPromise(
        fetchServerRingProof(uri, productId, suffix, message),
        (e) =>
          new CreateProofErr.Unknown({
            reason: e instanceof Error ? e.message : String(e),
          }),
      );
    }

    const pair = getPairForProductAccount(config, pairs, productId, suffix);
    const signature = pair ? pair.sign(message) : new Uint8Array(64);
    const publicKey = pair?.publicKey ?? new Uint8Array(32);
    const encoder = new TextEncoder();
    // RFC-0022: the proof now carries the contextual alias plus the ring
    // coordinates it was produced against. Deterministic stand-ins, matching
    // what handleAccountGetAlias returns for the same account.
    return ok({
      proof: signature,
      contextualAlias: {
        context: blake2AsU8a(
          new Uint8Array([...publicKey, ...encoder.encode("context")]),
          256,
        ),
        alias: blake2AsU8a(
          new Uint8Array([...publicKey, ...encoder.encode("alias")]),
          256,
        ),
      },
      ringIndex: 0,
      ringRevision: 0,
    });
  });

  container.handleCreateTransaction((params, { ok, err }) => {
    const [dotnsId, idx] = params.signer;
    const pair = getPairForProductAccount(config, pairs, dotnsId, idx);
    if (!pair) {
      return err(
        new CreateTransactionErr.Unknown({
          reason: `No keypair for product account: ${dotnsId}/${selectorKey(idx)}`,
        }),
      );
    }
    signingLog.push({
      type: "createTransaction",
      payload: params,
      timestamp: Date.now(),
    });
    return ok(buildSignedV4Extrinsic(pair, params.callData, params.extensions));
  });

  container.handleSignPayload((params, { ok, err }) => {
    // params.account is [dotnsId, derivationIndex]
    const [dotnsId, idx] = params.account;
    const pair = getPairForProductAccount(config, pairs, dotnsId, idx);
    if (!pair) {
      return err(
        new SigningErr.Unknown({
          reason: `No keypair for product account: ${dotnsId}/${selectorKey(idx)}`,
        }),
      );
    }

    signingLog.push({
      type: "payload",
      payload: params,
      timestamp: Date.now(),
    });

    return ResultAsync.fromPromise(
      (async () => {
        const registry = new TypeRegistry();
        registry.setSignedExtensions(params.payload.signedExtensions);
        const extrinsicPayload = registry.createType(
          "ExtrinsicPayload",
          params.payload,
          { version: params.payload.version },
        );

        const { signature } = extrinsicPayload.sign(pair);
        return {
          signature: signature as `0x${string}`,
          signedTransaction: undefined,
        };
      })(),
      (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[test-host] Sign error:", msg);
        return new SigningErr.Unknown({ reason: msg });
      },
    );
  });

  container.handleSignRaw((params, { ok, err }) => {
    // params.account is [dotnsId, derivationIndex]
    const [dotnsId, idx] = params.account;
    const pair = getPairForProductAccount(config, pairs, dotnsId, idx);
    if (!pair) {
      return err(
        new SigningErr.Unknown({
          reason: `No keypair for product account: ${dotnsId}/${selectorKey(idx)}`,
        }),
      );
    }

    signingLog.push({ type: "raw", payload: params, timestamp: Date.now() });

    let dataToSign: Uint8Array;
    if (params.payload.tag === "Bytes") {
      dataToSign = params.payload.value;
    } else {
      dataToSign = new TextEncoder().encode(params.payload.value);
    }

    const signature = pair.sign(dataToSign);
    return ok({
      signature: u8aToHex(signature) as `0x${string}`,
      signedTransaction: undefined,
    });
  });

  container.handleSignPayloadWithLegacyAccount((params, { ok, err }) => {
    const pair = getPairByAddress(params.signer);
    if (!pair) {
      return err(
        new SigningErr.Unknown({
          reason: `No keypair for signer: ${params.signer}`,
        }),
      );
    }

    signingLog.push({
      type: "payload",
      payload: params,
      timestamp: Date.now(),
    });

    return ResultAsync.fromPromise(
      (async () => {
        const registry = new TypeRegistry();
        registry.setSignedExtensions(params.payload.signedExtensions);
        const extrinsicPayload = registry.createType(
          "ExtrinsicPayload",
          params.payload,
          { version: params.payload.version },
        );
        const { signature } = extrinsicPayload.sign(pair);
        return {
          signature: signature as `0x${string}`,
          signedTransaction: undefined,
        };
      })(),
      (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        return new SigningErr.Unknown({ reason: msg });
      },
    );
  });

  container.handleSignRawWithLegacyAccount((params, { ok, err }) => {
    const pair = getPairByAddress(params.signer);
    if (!pair) {
      return err(
        new SigningErr.Unknown({
          reason: `No keypair for signer: ${params.signer}`,
        }),
      );
    }

    signingLog.push({ type: "raw", payload: params, timestamp: Date.now() });

    let dataToSign: Uint8Array;
    if (params.payload.tag === "Bytes") {
      dataToSign = params.payload.value;
    } else {
      dataToSign = new TextEncoder().encode(params.payload.value);
    }

    const signature = pair.sign(dataToSign);
    return ok({
      signature: u8aToHex(signature) as `0x${string}`,
      signedTransaction: undefined,
    });
  });

  container.handleCreateTransactionWithLegacyAccount((params, { ok, err }) => {
    const pair = getPairByPublicKey(params.signer);
    if (!pair) {
      return err(
        new CreateTransactionErr.Unknown({
          reason: `No keypair matching legacy signer pubkey ${u8aToHex(params.signer)}`,
        }),
      );
    }
    signingLog.push({
      type: "createTransaction",
      payload: params,
      timestamp: Date.now(),
    });
    return ok(buildSignedV4Extrinsic(pair, params.callData, params.extensions));
  });

  container.handleLocalStorageRead((key, { ok }) => {
    const storageKey = `test-host:${key}`;
    const raw = localStorage.getItem(storageKey);
    return ok(raw !== null ? new TextEncoder().encode(raw) : undefined);
  });

  container.handleLocalStorageWrite(([key, value], { ok }) => {
    const storageKey = `test-host:${key}`;
    localStorage.setItem(storageKey, new TextDecoder().decode(value));
    return ok(undefined);
  });

  container.handleLocalStorageClear((key, { ok }) => {
    const storageKey = `test-host:${key}`;
    localStorage.removeItem(storageKey);
    return ok(undefined);
  });

  // Real hosts parse dot.li URLs and route within the app or open externally.
  // The test host records intents so tests can assert what the product tried
  // to navigate to, without actually navigating.

  container.handleNavigateTo((url, { ok, err }) => {
    if (typeof url !== "string" || url.length === 0) {
      return err(new NavigateToErr.Unknown({ reason: "Empty URL" }));
    }
    navigationLog.push({ url, timestamp: Date.now() });
    console.log("[test-host] Navigation requested:", url);
    return ok(undefined);
  });

  // Real hosts surface system notifications with optional deeplink click handlers.
  // The test host records notifications so tests can assert what was sent.

  container.handlePushNotification((params, { ok }) => {
    const id = nextNotificationId++;
    notificationLog.push({
      id,
      text: params.text,
      deeplink: params.deeplink,
      scheduledAt: params.scheduledAt,
      cancelled: false,
      timestamp: Date.now(),
    });
    console.log(
      "[test-host] Notification:",
      `#${id}`,
      params.text,
      params.deeplink ? `(deeplink: ${params.deeplink})` : "",
      params.scheduledAt !== undefined
        ? `(scheduledAt: ${params.scheduledAt})`
        : "",
    );
    return ok(id);
  });

  container.handlePushNotificationCancel((id, { ok, err }) => {
    const entry = notificationLog.find((e) => e.id === id);
    if (!entry) {
      return err(
        new GenericError({ reason: `Notification id not found: ${id}` }),
      );
    }
    entry.cancelled = true;
    return ok(undefined);
  });

  // In-memory chat implementation: tracks product-created rooms and bots,
  // logs posted messages, and allows tests to inject incoming actions
  // through `injectChatAction`. Real hosts back these via Matrix.

  container.handleChatCreateRoom((params, { ok }) => {
    const exists = chatRooms.has(params.roomId);
    if (!exists) {
      const room: ChatRoom = {
        roomId: params.roomId,
        name: params.name,
        icon: params.icon,
        participatingAs: "RoomHost",
      };
      chatRooms.set(params.roomId, room);
      for (const subscriber of chatListSubscribers) {
        subscriber({
          roomId: room.roomId,
          participatingAs: room.participatingAs,
        });
      }
    }
    return ok({ status: exists ? "Exists" : "New" });
  });

  container.handleChatBotRegistration((params, { ok }) => {
    const exists = chatBots.has(params.botId);
    if (!exists) {
      chatBots.set(params.botId, {
        botId: params.botId,
        name: params.name,
        icon: params.icon,
      });
    }
    return ok({ status: exists ? "Exists" : "New" });
  });

  container.handleChatListSubscribe((_, send) => {
    for (const room of chatRooms.values()) {
      send({ roomId: room.roomId, participatingAs: room.participatingAs });
    }
    chatListSubscribers.add(send);
    return () => {
      chatListSubscribers.delete(send);
    };
  });

  container.handleChatPostMessage((params, { ok, err }) => {
    if (!chatRooms.has(params.roomId)) {
      return err(
        new ChatMessagePostingErr.Unknown({
          reason: `Room does not exist: ${params.roomId}`,
        }),
      );
    }
    chatMessageCounter += 1;
    const messageId = `msg-${chatMessageCounter}`;
    chatMessageLog.push({
      roomId: params.roomId,
      messageId,
      payload: params.payload,
      timestamp: Date.now(),
    });
    return ok({ messageId });
  });

  container.handleChatActionSubscribe((_, send) => {
    chatActionSubscribers.add(send);
    return () => {
      chatActionSubscribers.delete(send);
    };
  });

  // In-memory preimage storage. Key = blake2b-256(value), matching how
  // preimages are identified on Polkadot. Real hosts submit via Bulletin
  // chain + fetch via IPFS; this is a simple lookup table.

  container.handlePreimageLookupSubscribe((key, send) => {
    const keyStr = String(key).toLowerCase();
    const existing = preimages.get(keyStr);
    send(existing ? existing.value : null);

    let subs = preimageSubscribers.get(keyStr);
    if (!subs) {
      subs = new Set();
      preimageSubscribers.set(keyStr, subs);
    }
    subs.add(send);

    return () => {
      const s = preimageSubscribers.get(keyStr);
      if (s) {
        s.delete(send);
        if (s.size === 0) preimageSubscribers.delete(keyStr);
      }
    };
  });

  container.handlePreimageSubmit((value, { ok, err }) => {
    try {
      const key = blake2AsHex(value, 256) as HexString;
      const entry: PreimageEntry = {
        key,
        value,
        fromProduct: true,
        timestamp: Date.now(),
      };
      preimages.set(key.toLowerCase(), entry);

      // Notify any subscribers waiting for this key
      const subs = preimageSubscribers.get(key.toLowerCase());
      if (subs) {
        for (const subscriber of subs) subscriber(value);
      }

      return ok(key);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(new PreimageSubmitErr.Unknown({ reason }));
    }
  });

  // In-memory statement storage. Topics are Uint8Array[]; a statement
  // matches a subscription if the subscription topics are a subset of the
  // statement's topics (simple filter). Real hosts back this via the
  // @novasamatech/statement-store SDK.

  container.handleStatementStoreSubscribe((topicFilter, send) => {
    // topicFilter: { tag: 'MatchAll' | 'MatchAny', value: Uint8Array[] }
    const matchesFilter = (statement: unknown): boolean => {
      const filterTopics = topicFilter.value;
      if (filterTopics.length === 0) return true;
      const stmt = statement as { topics?: Uint8Array[] };
      if (!stmt.topics) return false;
      const stmtTopicsHex = stmt.topics.map((t) => u8aToHex(t));
      if (topicFilter.tag === "MatchAll") {
        return filterTopics.every((ft) => stmtTopicsHex.includes(u8aToHex(ft)));
      }
      // MatchAny
      return filterTopics.some((ft) => stmtTopicsHex.includes(u8aToHex(ft)));
    };

    // Send as SignedStatementsPage { statements, isComplete }
    const pageSend = (statement: unknown) => {
      send({ statements: [statement], isComplete: true } as never);
    };

    // Send current matching statements as initial dump
    const current = statementStore.filter(matchesFilter);
    send({ statements: current, isComplete: true } as never);

    const subscriber = { filter: topicFilter, send: pageSend };
    statementSubscribers.add(subscriber);

    return () => {
      statementSubscribers.delete(subscriber);
    };
  });

  container.handleStatementStoreCreateProof((params, { ok }) => {
    // Resolve the product account's keypair, then sign the raw statement
    // data with sr25519. This produces a valid Sr25519 proof shape that
    // downstream verification can check.
    const [[dotnsId, idx], statement] = params;
    const key = `${dotnsId}/${idx}`;
    const override = config.productAccounts?.[key];
    const pair = override
      ? getPair(override.uri)
      : getPair(`${urisByPair.get(pairs[0].pair)}//${dotnsId}/${idx}`);

    // Canonical message: for test purposes, sign the data field (or empty).
    const dataToSign =
      (statement as { data?: Uint8Array }).data ?? new Uint8Array();
    const signature = pair.sign(dataToSign);

    return ok({
      tag: "Sr25519",
      value: {
        signature,
        signer: pair.publicKey,
      },
    });
  });

  // Authorized proof: uses the first account (host-internal allowance, no product account needed)
  container.handleStatementStoreCreateProofAuthorized((statement, { ok }) => {
    const pair = pairs[0]?.pair;
    const dataToSign =
      (statement as { data?: Uint8Array }).data ?? new Uint8Array();
    const signature = pair ? pair.sign(dataToSign) : new Uint8Array(64);

    return ok({
      tag: "Sr25519",
      value: {
        signature,
        signer: pair?.publicKey ?? new Uint8Array(32),
      },
    });
  });

  container.handleStatementStoreSubmit((statement, { ok }) => {
    statementStore.push(statement);
    submittedStatements.push({
      statement,
      timestamp: Date.now(),
    });

    // Deliver to matching subscribers using TopicFilter semantics
    const stmt = statement as { topics?: Uint8Array[] };
    const stmtTopicsHex = (stmt.topics ?? []).map((t) => u8aToHex(t));
    for (const sub of statementSubscribers) {
      const filterTopics = sub.filter.value;
      let matches: boolean;
      if (filterTopics.length === 0) {
        matches = true;
      } else if (sub.filter.tag === "MatchAll") {
        matches = filterTopics.every((t) =>
          stmtTopicsHex.includes(u8aToHex(t)),
        );
      } else {
        matches = filterTopics.some((t) => stmtTopicsHex.includes(u8aToHex(t)));
      }
      if (matches) sub.send(statement as never);
    }

    return ok(undefined);
  });

  container.handleThemeSubscribe((_, send) => {
    send(currentTheme);
    themeSubscribers.add(send);
    return () => {
      themeSubscribers.delete(send);
    };
  });

  container.handleDeriveEntropy((key, { ok, err }) => {
    try {
      // Use the first account's mini-secret as the root entropy source.
      // Real hosts use BIP-39 entropy; for test purposes, derive from the
      // account's raw seed (which is stable for dev accounts).
      const rootPair = pairs[0]?.pair;
      if (!rootPair) {
        return err(
          new DeriveEntropyErr.Unknown({ reason: "No accounts available" }),
        );
      }
      // Use the public key as a stable stand-in for root account secret
      // (real hosts use BIP-39 entropy, but test dev accounts don't have it)
      const entropy = deriveProductEntropy(
        rootPair.publicKey,
        "test-product",
        key,
      );
      return ok(entropy);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(new DeriveEntropyErr.Unknown({ reason }));
    }
  });

  container.handleGetUserId((_, { ok, err }) => {
    if (!isAuthenticated) {
      return err(new GetUserIdErr.NotConnected());
    }
    if (pairs.length === 0) {
      return err(new GetUserIdErr.NotConnected());
    }
    // Return first account name as primaryUsername
    return ok({
      primaryUsername: pairs[0].name ?? "alice",
    });
  });

  container.handleRequestLogin((reason, { ok, err }) => {
    if (isAuthenticated) {
      return ok("alreadyConnected" as const);
    }

    let result: "success" | "rejected";
    if (loginBehavior === "success") {
      result = "success";
    } else if (loginBehavior === "reject") {
      result = "rejected";
    } else {
      result = loginBehavior(reason) ? "success" : "rejected";
    }

    if (result === "success") {
      isAuthenticated = true;
    } else {
      isAuthenticated = false;
    }

    return ok(result as never);
  });

  container.handlePaymentBalanceSubscribe((_, send) => {
    send({ available: paymentBalance });
    paymentBalanceSubscribers.add(send);
    return () => {
      paymentBalanceSubscribers.delete(send);
    };
  });

  container.handlePaymentTopUp((params, { ok, err }) => {
    paymentLog.push({
      type: "top-up",
      amount: params.amount,
      source: params.source,
      purse: params.into,
      timestamp: Date.now(),
    });

    const behavior = paymentTopUpBehavior;
    const credit = (amount: bigint) => {
      paymentBalance += amount;
      for (const sub of paymentBalanceSubscribers) {
        sub({ available: paymentBalance });
      }
    };

    if (behavior === "ok") {
      credit(params.amount);
      return ok(undefined);
    }
    if (behavior.type === "partial") {
      credit(behavior.credited);
      return err(
        new PaymentTopUpErr.PartialPayment({ credited: behavior.credited }),
      );
    }
    // behavior.type === 'reject'
    if (behavior.reason === "InvalidSource") {
      return err(new PaymentTopUpErr.InvalidSource());
    }
    return err(new PaymentTopUpErr.InsufficientFunds());
  });

  container.handlePaymentRequest((params, { ok, err }) => {
    if (params.amount > paymentBalance) {
      return err(new PaymentRequestErr.InsufficientBalance());
    }

    paymentCounter += 1;
    const paymentId = `pay-${paymentCounter}`;
    paymentBalance -= params.amount;

    paymentLog.push({
      type: "request",
      amount: params.amount,
      destination: params.destination,
      paymentId,
      purse: params.from,
      timestamp: Date.now(),
    });

    // Notify balance subscribers
    for (const sub of paymentBalanceSubscribers) {
      sub({ available: paymentBalance });
    }

    // Auto-complete the payment
    paymentStatuses.set(paymentId, { tag: "Completed" });

    return ok({ id: paymentId });
  });

  container.handlePaymentStatusSubscribe((paymentId, send) => {
    const status = paymentStatuses.get(paymentId);
    if (status) {
      send(status as never);
    } else {
      send({ tag: "Processing", value: undefined } as never);
    }

    let subs = paymentStatusSubscribers.get(paymentId);
    if (!subs) {
      subs = new Set();
      paymentStatusSubscribers.set(paymentId, subs);
    }
    subs.add(send);

    return () => {
      const s = paymentStatusSubscribers.get(paymentId);
      if (s) {
        s.delete(send);
        if (s.size === 0) paymentStatusSubscribers.delete(paymentId);
      }
    };
  });

  container.handleRequestResourceAllocation((resources, { ok }) => {
    // Auto-allocate all requested resources for test purposes
    const outcomes = resources.map(() => ({
      tag: "Allocated" as const,
      value: undefined,
    }));
    return ok(outcomes);
  });

  container.subscribeProductConnectionStatus((status) => {
    connectionStatus = status;
  });

  return container;
}

async function init(): Promise<void> {
  const config = window.__TEST_HOST_CONFIG__;
  if (!config) {
    console.error("[test-host] No __TEST_HOST_CONFIG__ found");
    return;
  }

  // Wait for WASM crypto (sr25519 signing)
  await cryptoWaitReady();

  keyring = new Keyring({ type: "sr25519", ss58Format: 42 });

  const iframe = document.getElementById("product-frame") as HTMLIFrameElement;

  currentContainer = setupContainer(iframe, config);

  // Forward the host page's path/search/hash to the product iframe so that
  // deep links like /n?id=...#key=... work when navigating via the test host URL.
  // Must come after setupContainer so createIframeProvider does not overwrite it.
  iframe.src = new URL(
    window.location.pathname + window.location.search + window.location.hash,
    config.productUrl,
  ).href;

  window.__TEST_HOST__ = {
    async switchAccount(name: string) {
      await this.setAccounts([name]);
    },

    async setAccounts(names: string[]) {
      const accounts = names.map((n) => ({
        name: n.charAt(0).toUpperCase() + n.slice(1).toLowerCase(),
        uri: `//${n.charAt(0).toUpperCase()}${n.slice(1).toLowerCase()}`,
      }));

      // Dispose current container
      if (currentContainer) {
        currentContainer.dispose();
        currentContainer = null;
      }

      // Recreate container with new accounts (triggers iframe reload)
      const iframe = document.getElementById(
        "product-frame",
      ) as HTMLIFrameElement;
      iframe.src = config.productUrl;

      currentContainer = setupContainer(iframe, config, accounts);
    },

    getSigningLog() {
      return [...signingLog];
    },

    clearSigningLog() {
      signingLog.length = 0;
    },

    getConnectionStatus() {
      return connectionStatus;
    },

    getChainStatus() {
      return chainStatus;
    },

    setPermissionBehavior(behavior: PermissionBehavior) {
      permissionBehavior = behavior;
    },

    grantPermission(tag: string) {
      grantedPermissions.add(tag);
      if (DEVICE_PERMISSION_POLICY[tag]) updateIframeAllow();
    },

    revokePermission(tag: string) {
      grantedPermissions.delete(tag);
      if (DEVICE_PERMISSION_POLICY[tag]) updateIframeAllow();
    },

    getGrantedPermissions() {
      return [...grantedPermissions];
    },

    setEnforcePermissions(enforce: boolean) {
      enforcePermissions = enforce;
    },

    getPermissionLog() {
      return [...permissionLog];
    },

    clearPermissionLog() {
      permissionLog.length = 0;
    },

    getNavigationLog() {
      return [...navigationLog];
    },

    clearNavigationLog() {
      navigationLog.length = 0;
    },

    getNotificationLog() {
      return [...notificationLog];
    },

    clearNotificationLog() {
      notificationLog.length = 0;
    },

    getChatRooms() {
      return [...chatRooms.values()];
    },

    getChatBots() {
      return [...chatBots.values()];
    },

    getChatMessageLog() {
      return [...chatMessageLog];
    },

    clearChatState() {
      chatRooms.clear();
      chatBots.clear();
      chatMessageLog.length = 0;
      chatActionSubscribers.clear();
      chatListSubscribers.clear();
      chatMessageCounter = 0;
    },

    injectChatAction(action: {
      roomId: string;
      peer: string;
      payload: unknown;
    }) {
      for (const subscriber of chatActionSubscribers) {
        subscriber(action);
      }
    },

    getPreimages() {
      return [...preimages.values()];
    },

    seedPreimage(value: Uint8Array) {
      const key = blake2AsHex(value, 256) as HexString;
      preimages.set(key.toLowerCase(), {
        key,
        value,
        fromProduct: false,
        timestamp: Date.now(),
      });
      const subs = preimageSubscribers.get(key.toLowerCase());
      if (subs) {
        for (const s of subs) s(value);
      }
      return key;
    },

    clearPreimages() {
      preimages.clear();
    },

    getSubmittedStatements() {
      return [...submittedStatements];
    },

    injectStatement(statement: unknown) {
      statementStore.push(statement);
      const stmt = statement as { topics?: Uint8Array[] };
      const stmtTopicsHex = (stmt.topics ?? []).map((t) => u8aToHex(t));
      for (const sub of statementSubscribers) {
        const filterTopics = sub.filter.value;
        let matches: boolean;
        if (filterTopics.length === 0) {
          matches = true;
        } else if (sub.filter.tag === "MatchAll") {
          matches = filterTopics.every((t) =>
            stmtTopicsHex.includes(u8aToHex(t)),
          );
        } else {
          matches = filterTopics.some((t) =>
            stmtTopicsHex.includes(u8aToHex(t)),
          );
        }
        if (matches) sub.send(statement as never);
      }
    },

    clearStatements() {
      statementStore.length = 0;
      submittedStatements.length = 0;
    },

    getTheme() {
      return currentTheme;
    },

    setTheme(theme: ThemeInput) {
      currentTheme = normalizeTheme(theme);
      for (const sub of themeSubscribers) {
        sub(currentTheme);
      }
    },

    setLoginBehavior(behavior: LoginBehavior) {
      loginBehavior = behavior;
    },

    getIsAuthenticated() {
      return isAuthenticated;
    },

    simulateDisconnect() {
      isAuthenticated = false;
    },

    simulateReconnect() {
      isAuthenticated = true;
    },

    setPaymentBalance(amount: bigint) {
      paymentBalance = amount;
      for (const sub of paymentBalanceSubscribers) {
        sub({ available: paymentBalance });
      }
    },

    getPaymentLog() {
      return [...paymentLog];
    },

    clearPaymentLog() {
      paymentLog.length = 0;
    },

    setPaymentTopUpBehavior(behavior: PaymentTopUpBehavior) {
      paymentTopUpBehavior = behavior;
    },

    simulatePaymentStatus(
      paymentId: string,
      status: { tag: string; value?: string },
    ) {
      paymentStatuses.set(paymentId, status);
      const subs = paymentStatusSubscribers.get(paymentId);
      if (subs) {
        for (const sub of subs) sub(status as never);
      }
    },

    dispose() {
      if (currentContainer) {
        currentContainer.dispose();
        currentContainer = null;
      }
    },
  };

  console.log(
    "[test-host] Initialized:",
    "\n  networks:",
    config.networks
      .map((n) => `${n.name} (${n.genesisHash.slice(0, 18)}...) ${n.rpcUrl}`)
      .join("\n            "),
    "\n  accounts:",
    config.accounts.map((a) => a.name).join(", "),
  );
}

init().catch((err) => {
  console.error("[test-host] Init failed:", err);
});
