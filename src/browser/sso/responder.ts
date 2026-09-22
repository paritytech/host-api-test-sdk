/**
 * The peer half of the SSO signing session, served in-page: decrypt the request
 * off the loopback statement store, sign with a dev account, publish the reply
 * back on `sessionIdPeer`. No handler here touches a chain.
 *
 * Three rules are load-bearing, all from `../host-rust-core`:
 *
 * 1. Every reply must echo the request envelope's `message_id` as
 *    `respondingTo` — `reply_matcher` (`runtime/sso_remote.rs`) discards
 *    anything else.
 * 2. Replies travel as a `request` frame; `StatementData.response` is only the
 *    transport ack, and the core surfaces no reply before it. Ack goes first.
 * 3. Replies must be signed by `identitySecret`, NOT `ssSecret`:
 *    `decode_sso_session_statement` reads an `ssPublicKey`-signed statement as
 *    the core's own echo and takes nothing but the ack from it.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { TypeRegistry } from '@polkadot/types';
import { type HexString, type ProductAccountId, scale } from '@parity/truapi';
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
import type { AllocatableResourceTag } from '../../types.js';

/** One signing action observed by the control API. */
export interface SigningLogEntry {
  type: 'payload' | 'raw' | 'createTransaction';
  payload: unknown;
  timestamp: number;
}

export interface ResponderSession extends ExternalSessionOptions {
  /** The peer's X25519 secret — the other half of the channel the host minted. */
  peerEncSecret: Uint8Array;
  /** 64-byte sr25519 secret whose public key is `identityAccountId`; signs every reply. */
  identitySecret: Uint8Array;
}

/**
 * Which resources this host allocates, and where the answers are recorded.
 * Injected rather than read off `HostState` so the responder keeps depending on
 * nothing above `sso/`.
 */
export interface ResourcePolicy {
  allows(resource: { tag: AllocatableResourceTag; productId: string }): boolean;
  record(entry: { productId: string; resource: AllocatableResourceTag; granted: boolean }): void;
}

export interface ResponderOptions {
  store: LoopbackStore;
  session: ResponderSession;
  /**
   * `derivationIndex` is `undefined` for `ProductSubtreeRequest`. Legacy
   * accounts never reach this callback — only the session identity answers those.
   */
  resolveAccount: ResolveAccount;
  /** Absent allocates everything, which is what every release before 0.15 did. */
  resourcePolicy?: ResourcePolicy;
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

/**
 * `Rejected`, not `NotAvailable`: the host can serve every one of these and is
 * declining this request, which is what a user refusing a prompt looks like.
 */
const REJECTED: AllocationOutcome = { tag: 'rejected', value: undefined };

/** The `HostSignPayloadData` carried by `SignRequest::Payload`. */
type SignPayloadData = Extract<
  RemoteMessagePayload<'SignRequest'>,
  { tag: 'payload' }
>['value']['payload'];

/**
 * How each request is refused. A handler that threw with no reply would leave
 * the core waiting forever, so every request is answered either way.
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

/** Stand-in alias, stable across runs so tests can assert exact values. */
function contextualAlias(publicKey: Uint8Array) {
  return {
    context: scale.bytesToHex(digest(publicKey, encoder.encode('context'))),
    alias: scale.bytesToHex(digest(publicKey, encoder.encode('alias'))),
  };
}

/**
 * Assembling `method || extra || additionalSigned` depends on the named signed
 * extensions, and `@polkadot/types` owns that table — hence `ExtrinsicPayload`
 * rather than hand-rolling it. The type prefix and the >256-byte blake2 hashing
 * are what polkadot-js signers apply, reproduced here.
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
  const { store, session, resolveAccount, resourcePolicy } = options;
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

  const account = (handle: ProductAccountId) =>
    resolveAccount(handle.dotNsIdentifier, handle.derivationIndex);
  /** The product's hard-subtree root — the key `ProductSubtreeRequest` reports. */
  const productSubtree = (productId: string) => resolveAccount(productId, undefined);

  const identityKeypair: DevKeypair = {
    secretKey: session.identitySecret,
    publicKey: session.identityAccountId,
    address: ss58Address(session.identityAccountId, 42),
  };

  /**
   * A legacy account is the wallet's own identity and this host holds exactly
   * one; refusing anything else stops a transaction being signed, and
   * attributed, to an unrelated key. Mirrors `runtime/signing_host.rs`.
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
   * Granted locally — asking a peer is how a pairing host gets allowances, and
   * answering in-page is what keeps "no network" true. `slotAccountKey` is a
   * secret the core adopts as the slot's signer verbatim, and the AutoSigning
   * grant must hand over the same subtree secret `ProductSubtreeRequest`
   * reports, or the core rejects the capability against its cached subtree.
   */
  function answerResourceAllocation(
    request: RemoteMessagePayload<'ResourceAllocationRequest'>,
  ): RemoteMessageValue {
    const product = request.callingProductId;
    const outcomes = request.resources.map((resource) => {
      const tag = resource.tag as AllocatableResourceTag;
      const granted = resourcePolicy?.allows({ tag, productId: product }) ?? true;
      resourcePolicy?.record({ productId: product, resource: tag, granted });
      // A refused resource is answered, not skipped: the core reads one outcome
      // per requested resource and a short vector desynchronises the pairing.
      if (!granted) return REJECTED;

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
              // `SecretKey::from_bytes` refuses the encoding `@scure/sr25519`
              // hands out. See `canonicalSecretKey`.
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

  /** RFC-0023 VRF stand-in: right shape, deterministic, not a real VRF. */
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

    const replies: Uint8Array[] = [];
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
      const wire = encodeReply(answered, envelope.messageId, message.tag);
      if (wire) replies.push(wire);
    }

    // The ack first: the core holds a decoded reply back until it has seen one.
    const requestId = frame.value.requestId;
    publish({ tag: 'response', value: { requestId, responseCode: RESPONSE_ACCEPTED } });
    if (replies.length > 0) {
      publish({ tag: 'request', value: { requestId, data: replies } });
    }
  });

  // ---- transport ------------------------------------------------------------

  /**
   * Encoding must happen here, before the ack is published: a throw later is
   * swallowed by the store's listener isolation and the core then waits forever
   * with nothing on the console. A failure reply is a fixed shape, so it
   * encodes where a mis-shaped success payload did not.
   */
  function encodeReply(
    answered: RemoteMessageValue,
    respondingTo: string,
    requestTag: RemoteMessageValue['tag'],
  ): Uint8Array | undefined {
    const envelope = (value: RemoteMessageValue): Parameters<typeof RemoteMessageEnvelope.enc>[0] => ({
      messageId: `sso-responder-${++nextMessageId}`,
      // Correlation: the core drops any reply not addressed to its request.
      data: { tag: 'V1', value: withRespondingTo(value, respondingTo) },
    });

    try {
      return RemoteMessageEnvelope.enc(envelope(answered));
    } catch (error) {
      console.error(`[sso-responder] could not encode the ${requestTag} reply:`, error);
      const reason = error instanceof Error ? error.message : String(error);
      const failure = failureReply(requestTag, `reply could not be encoded: ${reason}`);
      if (!failure) return undefined;
      try {
        return RemoteMessageEnvelope.enc(envelope(failure));
      } catch (fallbackError) {
        console.error(
          `[sso-responder] could not encode the ${requestTag} failure reply either:`,
          fallbackError,
        );
        return undefined;
      }
    }
  }

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
 * Derived, not random, so re-requesting an allowance yields the same slot
 * account. The product id is folded in hashed because a junction label may not
 * exceed 31 bytes.
 */
function allowanceSlotSecret(kind: 'statement-store' | 'bulletin', productId: string): Uint8Array {
  const tag = scale.bytesToHex(digest(encoder.encode(`${kind}:${productId}`))).slice(2, 26);
  // Canonical for the same reason as the AutoSigning subtree secret.
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
