/**
 * The peer half of the SSO signing session, served in-page.
 *
 * The WASM core never signs. Every signing request is forwarded to the paired
 * wallet as an encrypted statement on the People chain. This SDK has no wallet
 * and no network, so the host mints both halves of the session and answers as
 * the peer here: decrypt the request off the loopback statement store, sign
 * with a dev account, publish the reply back on `sessionIdPeer`.
 *
 * Three details are load-bearing, all verified against
 * `../host-rust-core` at the `@parity/truapi 0.17.0` release tag:
 *
 * 1. Each entry of `StatementData.request.data` is a `RemoteMessageEnvelope`
 *    (`message_id` + versioned body), and every reply must echo that
 *    `message_id` as `respondingTo` — `reply_matcher` in
 *    `runtime/sso_remote.rs` discards anything else.
 * 2. Application replies travel as a `StatementData.request` frame, not a
 *    `response` frame. `StatementData.response` is only the transport
 *    acknowledgement (`response_code == 0`), and the core will not surface a
 *    reply until it has seen that ack for the request id it submitted. The
 *    responder therefore publishes an ack first, then the replies.
 * 3. `decode_sso_session_statement` treats a statement signed by `ssPublicKey`
 *    as the core's own echo and reads nothing but the ack from it. Application
 *    replies must be signed by the key behind `identityAccountId` — hence
 *    `session.identitySecret`.
 *
 * No handler here touches a chain. In particular `ResourceAllocationRequest`
 * is answered with granted allowance slots: a pairing host obtains allowances
 * by asking its peer, and only a signing host would submit
 * `Resources.set_statement_store_account`. Answering it locally is what keeps
 * "no network" true.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { TypeRegistry } from '@polkadot/types';
import { type HexString, scale } from '@parity/truapi';
import { ss58Address } from '@polkadot-labs/hdkd-helpers';
import { getPublicKey, sign } from '@scure/sr25519';
import { type DevKeypair, canonicalSecretKey, deriveDev } from '../dev-accounts.js';
import type { LoopbackStore } from '../loopback-chain.js';
import { type RawSignPayload, buildSignedV4Extrinsic, signRawBytes } from '../signing/index.js';
import { open, seal, sessionAeadKey } from './crypto.js';
import {
  RemoteMessageEnvelope,
  type RemoteMessagePayload,
  type RemoteMessageValue,
  StatementData,
} from './messages.js';
import type { ExternalSessionOptions } from './session-blob.js';
import { type Statement, matchesTopics, signStatement } from './statement.js';
import { type ResolveAccount, createRingVrfRegistry } from './ring-vrf.js';

/** One signing action observed by the control API. */
export interface SigningLogEntry {
  type: 'payload' | 'raw' | 'createTransaction';
  payload: unknown;
  timestamp: number;
}

export interface ResponderSession extends ExternalSessionOptions {
  /** The peer's X25519 secret — the other half of the channel the host minted. */
  peerEncSecret: Uint8Array;
  /**
   * 64-byte sr25519 secret whose public key is `identityAccountId`.
   *
   * Replies are signed with it, because the core only accepts application
   * messages from the peer identity (see the module note).
   */
  identitySecret: Uint8Array;
}

export interface ResponderOptions {
  store: LoopbackStore;
  session: ResponderSession;
  /**
   * Resolve the dev keypair behind one product account.
   *
   * `derivationIndex` is the SCALE `DerivationIndex` as decoded, or
   * `undefined` for `ProductSubtreeRequest`, which names a product's subtree
   * root and carries no index. Legacy accounts never reach this callback: they
   * name a bare `AccountId`, and only the session identity can answer for one.
   */
  resolveAccount: ResolveAccount;
}

export interface SsoResponder {
  getSigningLog(): SigningLogEntry[];
  clearSigningLog(): void;
  dispose(): void;
}

/** One entry of `ResourceAllocationResponse`'s outcome vector. */
type AllocationOutcome = Extract<
  RemoteMessagePayload<'ResourceAllocationResponse'>['payload'],
  { success: true }
>['value'][number];
type AllocatedResource = Extract<AllocationOutcome, { tag: 'allocated' }>['value'];

const allocated = (value: AllocatedResource): AllocationOutcome => ({ tag: 'allocated', value });

/** The `HostSignPayloadData` carried by `SignRequest::Payload`. */
type SignPayloadData = Extract<
  RemoteMessagePayload<'SignRequest'>,
  { tag: 'payload' }
>['value']['payload'];

/**
 * The response variant, and the error flavour, each request is refused with.
 *
 * A handler that throws would otherwise leave the core waiting for a reply
 * that never comes, so every request gets an answer either way. The three
 * flavours are the three error types `messages.ts` pairs with these variants:
 * a plain `String`, a `RingVrfError`, or a `HostAccountSignVrfError`.
 */
const FAILURE_ROUTES = {
  SignRequest: ['SignResponse', 'string'],
  CreateTransactionRequest: ['CreateTransactionResponse', 'string'],
  CreateTransactionWithLegacyAccountRequest: ['CreateTransactionResponse', 'string'],
  SignRawWithLegacyAccountRequest: ['SignRawWithLegacyAccountResponse', 'string'],
  ResourceAllocationRequest: ['ResourceAllocationResponse', 'string'],
  ProductSubtreeRequest: ['ProductSubtreeResponse', 'string'],
  GetAccountAliasRequest: ['GetAccountAliasResponse', 'ringVrf'],
  CreateAccountProofRequest: ['CreateAccountProofResponse', 'ringVrf'],
  SignVrfRequest: ['SignVrfResponse', 'signVrf'],
  RegisterRingVrfKeyRequest: ['RegisterRingVrfKeyResponse', 'ringVrf'],
  ListRingVrfKeysRequest: ['ListRingVrfKeysResponse', 'ringVrf'],
  RingVrfSignRequest: ['RingVrfSignResponse', 'ringVrf'],
} as const satisfies Partial<Record<RemoteMessageValue['tag'], readonly [string, string]>>;

/** The refusal for one request variant, or `undefined` if it takes no reply. */
function failureReply(
  requestTag: RemoteMessageValue['tag'],
  reason: string,
): RemoteMessageValue | undefined {
  const route = (FAILURE_ROUTES as Record<string, readonly [string, string] | undefined>)[
    requestTag
  ];
  if (!route) return undefined;
  const [tag, flavour] = route;
  const value =
    flavour === 'string'
      ? reason
      : flavour === 'ringVrf'
        ? { tag: 'unknown', value: { reason } }
        : { tag: 'Unknown', value: { reason } };
  return { tag, value: { respondingTo: '', payload: { success: false, value } } } as RemoteMessageValue;
}

const encoder = new TextEncoder();
/** `SsoResponseCode::Success`. */
const RESPONSE_ACCEPTED = 0;
/** sr25519's `MultiSignature` index — polkadot-js signers prefix it. */
const SR25519_SIGNATURE_TYPE = 0x01;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const digest = (...parts: Uint8Array[]) => blake2b(concat(parts), { dkLen: 32 });

/** `RawPayload` as the wire carries it, adapted to what `signRawBytes` takes. */
function rawPayload(
  payload: RemoteMessagePayload<'SignRawWithLegacyAccountRequest'>['data'],
): RawSignPayload {
  return payload.tag === 'Bytes'
    ? { tag: 'Bytes', value: scale.hexToBytes(payload.value.bytes) }
    : { tag: 'Payload', value: payload.value.payload };
}

/**
 * Deterministic contextual alias, byte-for-byte what the pre-migration
 * `handleAccountGetAlias` returned: blake2-256 over the account public key
 * with a role label. Stable across runs so tests can assert exact values.
 */
function contextualAlias(publicKey: Uint8Array) {
  return {
    context: scale.bytesToHex(digest(publicKey, encoder.encode('context'))),
    alias: scale.bytesToHex(digest(publicKey, encoder.encode('alias'))),
  };
}

/**
 * Sign a Substrate signer payload.
 *
 * `HostSignPayloadData` is the classic `SignerPayloadJSON`: hex fields whose
 * assembly into `method || extra || additionalSigned` depends on the named
 * signed extensions. `@polkadot/types` owns that table, so the pre-migration
 * `ExtrinsicPayload` path is kept rather than hand-rolled — only `pair.sign`
 * becomes `@scure/sr25519`, with the type prefix and the >256-byte blake2
 * hashing that polkadot-js applies reproduced here.
 */
function signPayloadData(keypair: DevKeypair, payload: SignPayloadData): HexString {
  const registry = new TypeRegistry();
  registry.setSignedExtensions(payload.signedExtensions);
  const bytes = registry
    .createType('ExtrinsicPayload', payload, { version: payload.version })
    .toU8a({ method: true });
  const signature = sign(keypair.secretKey, bytes.length > 256 ? digest(bytes) : bytes);
  return scale.bytesToHex(concat([new Uint8Array([SR25519_SIGNATURE_TYPE]), signature]));
}

export function createSsoResponder(options: ResponderOptions): SsoResponder {
  const { store, session, resolveAccount } = options;
  const channelKey = sessionAeadKey(session.encSecret, session.peerEncPubkey);
  const signingLog: SigningLogEntry[] = [];
  const ringVrf = createRingVrfRegistry(resolveAccount);
  let active = true;
  let nextMessageId = 0;

  if (!bytesEqual(getPublicKey(session.identitySecret), session.identityAccountId)) {
    throw new Error('identitySecret does not match identityAccountId');
  }

  const record = (type: SigningLogEntry['type'], payload: unknown) => {
    signingLog.push({ type, payload, timestamp: Date.now() });
  };

  const account = (handle: { dotNsIdentifier: string; derivationIndex: unknown }) =>
    resolveAccount(handle.dotNsIdentifier, handle.derivationIndex);
  /** The product's hard-subtree root — the key `ProductSubtreeRequest` reports. */
  const productSubtree = (productId: string) => resolveAccount(productId, undefined);

  const identityKeypair: DevKeypair = {
    secretKey: session.identitySecret,
    publicKey: session.identityAccountId,
    address: ss58Address(session.identityAccountId, 42),
  };

  /**
   * The keypair for a bare `AccountId`.
   *
   * A legacy account is the wallet's own identity account, and this host holds
   * exactly one. Refusing anything else is what stops a mismatched
   * `resolveAccount` from signing — and attributing, since `buildExtrinsic`
   * embeds the public key — a transaction with an unrelated key. Mirrors
   * `sign_raw`/`create_transaction` in
   * `../host-rust-core/rust/crates/truapi-server/src/runtime/signing_host.rs`,
   * which error when the resolved public key is not the requested account.
   */
  const legacyAccount = (accountId: string): DevKeypair => {
    if (accountId !== scale.bytesToHex(session.identityAccountId)) {
      throw new Error(`the requested legacy account is not available to this host: ${accountId}`);
    }
    return identityKeypair;
  };

  // ---- per-variant handlers -------------------------------------------------

  function answerSign(request: RemoteMessagePayload<'SignRequest'>): RemoteMessageValue {
    const signature = (() => {
      switch (request.tag) {
        case 'payload': {
          record('payload', request.value);
          return signPayloadData(account(request.value.account), request.value.payload);
        }
        // Only `Raw` is watermarked; the two `…UnwatermarkedDeprecated`
        // variants exist precisely to skip the `<Bytes>` wrapper.
        case 'raw':
        case 'rawUnwatermarkedDeprecated': {
          record('raw', request.value);
          const keypair = account(request.value.account);
          const payload = rawPayload(request.value.payload);
          return scale.bytesToHex(signRawBytes(keypair, payload, request.tag === 'raw'));
        }
        case 'rawWithLegacyAccountUnwatermarkedDeprecated': {
          record('raw', request.value);
          const keypair = legacyAccount(request.value.account);
          return scale.bytesToHex(signRawBytes(keypair, rawPayload(request.value.data), false));
        }
      }
    })();
    return reply('SignResponse', {
      success: true,
      value: { signature, signedTransaction: undefined },
    });
  }

  function answerCreateTransaction(
    request: RemoteMessagePayload<'CreateTransactionRequest'>,
  ): RemoteMessageValue {
    record('createTransaction', request.payload.value);
    return reply('CreateTransactionResponse', {
      success: true,
      value: buildExtrinsic(account(request.payload.value.signer), request.payload.value),
    });
  }

  function answerCreateTransactionWithLegacyAccount(
    request: RemoteMessagePayload<'CreateTransactionWithLegacyAccountRequest'>,
  ): RemoteMessageValue {
    record('createTransaction', request.payload.value);
    // The legacy signer is an `AccountId`; `legacyAccount` refuses any account
    // this host does not hold rather than signing with a diverging key.
    return reply('CreateTransactionResponse', {
      success: true,
      value: buildExtrinsic(legacyAccount(request.payload.value.signer), request.payload.value),
    });
  }

  function answerSignRawWithLegacyAccount(
    request: RemoteMessagePayload<'SignRawWithLegacyAccountRequest'>,
  ): RemoteMessageValue {
    record('raw', request);
    const keypair = legacyAccount(request.account);
    // The top-level request is the watermarked flavour.
    return reply('SignRawWithLegacyAccountResponse', {
      success: true,
      value: signRawBytes(keypair, rawPayload(request.data), true),
    });
  }

  /**
   * Grant every requested allowance slot, locally.
   *
   * `slotAccountKey` is a 64-byte sr25519 secret the core adopts as the slot's
   * signer (`StatementStoreAllowanceKey::from_secret_bytes`), so it is derived
   * deterministically per product and resource rather than invented. The
   * AutoSigning grant hands over the product subtree secret itself, which is
   * why it must be the same key `ProductSubtreeRequest` reports — the core
   * rejects a capability whose secret does not match the subtree it cached.
   */
  function answerResourceAllocation(
    request: RemoteMessagePayload<'ResourceAllocationRequest'>,
  ): RemoteMessageValue {
    const product = request.callingProductId;
    const outcomes = request.resources.map((resource) => {
      switch (resource.tag) {
        case 'StatementStoreAllowance':
          return allocated({
            tag: 'statementStoreAllowance',
            value: { slotAccountKey: allowanceSlotSecret('statement-store', product) },
          });
        case 'BulletinAllowance':
          return allocated({
            tag: 'bulletinAllowance',
            value: { slotAccountKey: allowanceSlotSecret('bulletin', product) },
          });
        case 'SmartContractAllowance':
          return allocated({ tag: 'smartContractAllowance', value: undefined });
        case 'AutoSigning': {
          const subtree = productSubtree(product);
          return allocated({
            tag: 'autoSigning',
            value: {
              // Canonical form: the core validates this one with
              // `SecretKey::from_bytes`, which refuses the ed25519-shifted
              // encoding `@scure/sr25519` hands out. See `canonicalSecretKey`.
              productRootPrivateKey: canonicalSecretKey(subtree.secretKey),
              ringVrfDomainEntropy: digest(
                subtree.publicKey,
                encoder.encode('ring-vrf-domain-entropy'),
              ),
            },
          });
        }
      }
    });
    return reply('ResourceAllocationResponse', { success: true, value: outcomes });
  }

  function answerProductSubtree(
    request: RemoteMessagePayload<'ProductSubtreeRequest'>,
  ): RemoteMessageValue {
    return reply('ProductSubtreeResponse', {
      success: true,
      value: productSubtree(request.productId).publicKey,
    });
  }

  function answerGetAccountAlias(
    request: RemoteMessagePayload<'GetAccountAliasRequest'>,
  ): RemoteMessageValue {
    const keypair = account(request.payload.keyHandle);
    return reply('GetAccountAliasResponse', {
      success: true,
      value: contextualAlias(keypair.publicKey),
    });
  }

  function answerCreateAccountProof(
    request: RemoteMessagePayload<'CreateAccountProofRequest'>,
  ): RemoteMessageValue {
    const keypair = account(request.payload.keyHandle);
    const proof = sign(keypair.secretKey, scale.hexToBytes(request.payload.message));
    return reply('CreateAccountProofResponse', {
      success: true,
      value: {
        proof: scale.bytesToHex(proof),
        contextualAlias: contextualAlias(keypair.publicKey),
        ringIndex: 0,
        ringRevision: 0,
      },
    });
  }

  /**
   * RFC-0023 VRF stand-in: `preOutput` is a deterministic digest of the
   * account key and the transcript, `proof` an sr25519 signature over the same
   * transcript. Same shape and same determinism as the alias stand-in.
   */
  function answerSignVrf(request: RemoteMessagePayload<'SignVrfRequest'>): RemoteMessageValue {
    const keypair = account(request.payload.account);
    const transcript = concat([
      scale.hexToBytes(request.payload.transcriptLabel),
      ...request.payload.items.flatMap((item) => [
        scale.hexToBytes(item.label),
        scale.hexToBytes(item.value),
      ]),
    ]);
    return reply('SignVrfResponse', {
      success: true,
      value: {
        preOutput: scale.bytesToHex(digest(keypair.publicKey, transcript)),
        proof: scale.bytesToHex(sign(keypair.secretKey, transcript)),
      },
    });
  }

  // ---- dispatch -------------------------------------------------------------

  /** The reply for one request, or `undefined` for anything not a request. */
  function answer(message: RemoteMessageValue): RemoteMessageValue | undefined {
    switch (message.tag) {
      case 'SignRequest':
        return answerSign(message.value);
      case 'CreateTransactionRequest':
        return answerCreateTransaction(message.value);
      case 'CreateTransactionWithLegacyAccountRequest':
        return answerCreateTransactionWithLegacyAccount(message.value);
      case 'SignRawWithLegacyAccountRequest':
        return answerSignRawWithLegacyAccount(message.value);
      case 'ResourceAllocationRequest':
        return answerResourceAllocation(message.value);
      case 'ProductSubtreeRequest':
        return answerProductSubtree(message.value);
      case 'GetAccountAliasRequest':
        return answerGetAccountAlias(message.value);
      case 'CreateAccountProofRequest':
        return answerCreateAccountProof(message.value);
      case 'SignVrfRequest':
        return answerSignVrf(message.value);
      case 'RegisterRingVrfKeyRequest':
        return reply('RegisterRingVrfKeyResponse', ringVrf.register(message.value));
      case 'ListRingVrfKeysRequest':
        return reply('ListRingVrfKeysResponse', ringVrf.list(message.value));
      case 'RingVrfSignRequest':
        return reply('RingVrfSignResponse', ringVrf.sign(message.value));
      default:
        // `Disconnected` is handled by the caller; every `*Response` variant is
        // the peer's own traffic and is not a request.
        return undefined;
    }
  }

  const unsubscribe = store.onSubmit((statement) => {
    if (!active) return;
    if (!statement.data) return;
    if (!matchesTopics(statement, 'MatchAll', [session.sessionIdOwn])) return;

    let frame: ReturnType<typeof StatementData.dec>;
    try {
      frame = StatementData.dec(open(channelKey, statement.data));
    } catch (error) {
      console.error('[sso-responder] could not read the submitted statement:', error);
      return;
    }
    // `response` is a transport acknowledgement, never a request.
    if (frame.tag !== 'request') return;

    const replies: Array<Parameters<typeof RemoteMessageEnvelope.enc>[0]> = [];
    for (const encoded of frame.value.data) {
      let envelope: ReturnType<typeof RemoteMessageEnvelope.dec>;
      try {
        envelope = RemoteMessageEnvelope.dec(encoded);
      } catch (error) {
        console.error('[sso-responder] could not decode a remote message:', error);
        continue;
      }
      const message = envelope.data.value;
      if (message.tag === 'Disconnected') {
        // The peer ended the session; stop answering on it entirely.
        active = false;
        unsubscribe();
        return;
      }
      let answered: RemoteMessageValue | undefined;
      try {
        answered = answer(message);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[sso-responder] ${message.tag} failed:`, error);
        answered = failureReply(message.tag, reason);
      }
      if (!answered) continue;
      replies.push({
        messageId: `sso-responder-${++nextMessageId}`,
        // Correlation: the core drops any reply not addressed to its request.
        data: { tag: 'V1', value: withRespondingTo(answered, envelope.messageId) },
      });
    }

    // The ack first: the core holds a decoded reply back until it has seen one.
    const requestId = frame.value.requestId;
    publish({ tag: 'response', value: { requestId, responseCode: RESPONSE_ACCEPTED } });
    if (replies.length > 0) {
      publish({
        tag: 'request',
        value: { requestId, data: replies.map((reply) => RemoteMessageEnvelope.enc(reply)) },
      });
    }
  });

  // ---- transport ------------------------------------------------------------

  function publish(data: Parameters<typeof StatementData.enc>[0]): void {
    const statement: Statement = {
      topics: [session.sessionIdPeer],
      data: seal(channelKey, StatementData.enc(data)),
    };
    store.publish(signStatement(session.identitySecret, statement));
  }

  function reply<T extends RemoteMessageValue['tag']>(
    tag: T,
    payload: RemoteMessagePayload<T> extends { payload: infer P } ? P : never,
  ): RemoteMessageValue {
    // `respondingTo` is filled in by the dispatch loop, which knows the id.
    return { tag, value: { respondingTo: '', payload } } as RemoteMessageValue;
  }

  return {
    getSigningLog: () => [...signingLog],
    clearSigningLog: () => {
      signingLog.length = 0;
    },
    dispose: () => {
      active = false;
      unsubscribe();
    },
  };
}

/** Stamp the correlation id the core matches replies on. */
function withRespondingTo(message: RemoteMessageValue, respondingTo: string): RemoteMessageValue {
  return {
    ...message,
    value: { ...(message.value as object), respondingTo },
  } as RemoteMessageValue;
}

/**
 * The 64-byte sr25519 secret handed over as an allowance slot's signer.
 *
 * Derived, not random, so a product that re-requests the same allowance gets
 * the same slot account. The product id is folded in as a hashed junction
 * because a derivation junction label may not exceed 31 bytes.
 */
function allowanceSlotSecret(kind: 'statement-store' | 'bulletin', productId: string): Uint8Array {
  const tag = scale.bytesToHex(digest(encoder.encode(`${kind}:${productId}`))).slice(2, 26);
  // Canonical form for the same reason as the AutoSigning subtree secret: the
  // core adopts these bytes as a signer verbatim.
  return canonicalSecretKey(deriveDev('allowance', tag).secretKey);
}

function buildExtrinsic(
  keypair: DevKeypair,
  payload: {
    callData: string;
    extensions: ReadonlyArray<{ extra: string; additionalSigned: string }>;
  },
): Uint8Array {
  return buildSignedV4Extrinsic(
    keypair,
    scale.hexToBytes(payload.callData),
    payload.extensions.map((extension) => ({
      extra: scale.hexToBytes(extension.extra),
      additionalSigned: scale.hexToBytes(extension.additionalSigned),
    })),
  );
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);
