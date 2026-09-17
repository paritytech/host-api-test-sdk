// src/browser/sso/responder.spec.ts
import { blake2b } from '@noble/hashes/blake2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { verify } from '@scure/sr25519';
import { scale } from '@parity/truapi';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSecretKey, deriveDev } from '../dev-accounts.js';
import { createLoopbackStore } from '../loopback-chain.js';
import { open, seal, sessionAeadKey } from './crypto.js';
import {
  RemoteMessageEnvelope,
  type RemoteMessagePayload,
  type RemoteMessageValue,
  StatementData,
} from './messages.js';
import { createSsoResponder } from './responder.js';
import { decodeStatement, encodeStatement, signStatement } from './statement.js';

const topic = (fill: number) => new Uint8Array(32).fill(fill);
const toHex = (bytes: Uint8Array) => scale.bytesToHex(bytes);
const fromHex = (value: string) => scale.hexToBytes(value);

const PRODUCT = 'test-product.dot';
const INDEX_0 = { tag: 'Index', value: 0 } as const;
const ACCOUNT = { dotNsIdentifier: PRODUCT, derivationIndex: INDEX_0 };

type ResolveAccountFn = (dotNsIdentifier: string, derivationIndex: unknown) => ReturnType<typeof deriveDev>;

function harness(failWith?: string, overrideResolve?: ResolveAccountFn) {
  const alice = deriveDev('Alice');
  const hostEncSecret = x25519.utils.randomSecretKey();
  const peerEncSecret = x25519.utils.randomSecretKey();
  const store = createLoopbackStore();
  const session = {
    rootPublicKey: alice.publicKey,
    identityAccountId: alice.publicKey,
    identitySecret: alice.secretKey,
    encSecret: hostEncSecret,
    peerEncPubkey: x25519.getPublicKey(peerEncSecret),
    peerEncSecret,
    ssSecret: deriveDev('Alice', 'ss').secretKey,
    ssPublicKey: deriveDev('Alice', 'ss').publicKey,
    sessionIdOwn: topic(1),
    sessionIdPeer: topic(2),
  };
  const accounts = new Map<string, ReturnType<typeof deriveDev>>();
  const resolveAccount = (dotNsIdentifier: string, derivationIndex: unknown) => {
    if (failWith) throw new Error(failWith);
    const key = `${dotNsIdentifier}/${JSON.stringify(derivationIndex ?? null)}`;
    let keypair = accounts.get(key);
    if (!keypair) {
      keypair = deriveDev('Alice', dotNsIdentifier.slice(0, 24), String(key.length));
      accounts.set(key, keypair);
    }
    return keypair;
  };
  const responder = createSsoResponder({
    store,
    session,
    resolveAccount: overrideResolve ?? resolveAccount,
  });
  const key = sessionAeadKey(hostEncSecret, session.peerEncPubkey);
  return { alice, store, session, responder, key, resolveAccount };
}

type Harness = ReturnType<typeof harness>;

/** Encode one correlated `RemoteMessage` the way the core frames it. */
function envelope<T extends RemoteMessageValue['tag']>(
  messageId: string,
  tag: T,
  value: RemoteMessagePayload<T>,
): Uint8Array {
  return RemoteMessageEnvelope.enc({
    messageId,
    data: { tag: 'V1', value: { tag, value } as RemoteMessageValue },
  });
}

/** A `SignRequest::Raw` for `test-product.dot` index 0. */
function buildSignRawMessage(messageId = 'm-raw'): Uint8Array {
  return envelope(messageId, 'SignRequest', {
    tag: 'raw',
    value: { account: ACCOUNT, payload: { tag: 'Payload', value: { payload: 'hello' } } },
  });
}

/** Submit an encrypted request batch the way the core would. */
function submitRequest(
  h: Harness,
  requestId: string,
  messages: Uint8Array[],
  topics: Uint8Array[] = [h.session.sessionIdOwn],
) {
  const data = StatementData.enc({ tag: 'request', value: { requestId, data: messages } });
  const statement = signStatement(h.session.ssSecret, { topics, data: seal(h.key, data) });
  const connection = h.store.connect(() => {});
  connection.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'statement_submit',
      params: [toHex(encodeStatement(statement))],
    }),
  );
}

interface CapturedFrame {
  signer?: Uint8Array;
  data: ReturnType<typeof StatementData.dec>;
}

/** Subscribe to the peer topic and decrypt everything published on it. */
function listen(h: Harness): CapturedFrame[] {
  const frames: CapturedFrame[] = [];
  const connection = h.store.connect((json) => {
    // The store delivers subscription items in the statement-store's own
    // `newStatements` envelope, which is what the core decodes.
    const message = JSON.parse(json) as {
      params?: { result?: { event?: string; data?: { statements?: string[] } } };
    };
    const result = message.params?.result;
    if (result?.event !== 'newStatements') return;
    for (const encoded of result.data?.statements ?? []) {
      const statement = decodeStatement(fromHex(encoded));
      frames.push({
        signer: statement.proof?.signer,
        data: StatementData.dec(open(h.key, statement.data as Uint8Array)),
      });
    }
  });
  connection.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'statement_subscribeStatement',
      params: [{ matchAll: [toHex(h.session.sessionIdPeer)] }],
    }),
  );
  return frames;
}

/** The application messages published in reply, in order. */
function repliesIn(frames: CapturedFrame[]) {
  return frames
    .filter((frame) => frame.data.tag === 'request')
    .flatMap((frame) =>
      (frame.data.value as { data: Uint8Array[] }).data.map((entry) =>
        RemoteMessageEnvelope.dec(entry),
      ),
    );
}

const replyValues = (frames: CapturedFrame[]) =>
  repliesIn(frames).map((reply) => reply.data.value);

/** The signature bytes out of a `SignResponse`. */
const signatureOf = (reply: { value: unknown }) =>
  scale.hexToBytes(
    (reply.value as { payload: { value: { signature: string } } }).payload.value.signature,
  );

const utf8 = (text: string) => new TextEncoder().encode(text);
const watermark = (text: string) => utf8(`<Bytes>${text}</Bytes>`);
const identityOf = (h: Harness) => scale.bytesToHex(h.session.identityAccountId);

describe('sso responder', () => {
  it('starts with an empty signing log', () => {
    expect(harness().responder.getSigningLog()).toEqual([]);
  });

  it('publishes an encrypted reply on the peer topic for a sign request', async () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-1', [buildSignRawMessage()]);
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));

    const [reply] = replyValues(frames);
    expect(reply.tag).toBe('SignResponse');
  });

  it('records signing activity in the log', async () => {
    const h = harness();
    submitRequest(h, 'req-2', [buildSignRawMessage()]);
    await vi.waitFor(() => expect(h.responder.getSigningLog()).toHaveLength(1));
    expect(h.responder.getSigningLog()[0].type).toBe('raw');
  });

  it('clears the signing log on request', async () => {
    const h = harness();
    submitRequest(h, 'req-3', [buildSignRawMessage()]);
    await vi.waitFor(() => expect(h.responder.getSigningLog()).toHaveLength(1));
    h.responder.clearSigningLog();
    expect(h.responder.getSigningLog()).toEqual([]);
  });

  it('acknowledges the statement before answering it', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-ack', [buildSignRawMessage()]);

    expect(frames[0].data).toEqual({
      tag: 'response',
      value: { requestId: 'req-ack', responseCode: 0 },
    });
    expect(frames[1].data.tag).toBe('request');
  });

  it('signs replies with the peer identity key, not the statement-store key', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-signer', [buildSignRawMessage()]);

    for (const frame of frames) {
      expect(frame.signer).toEqual(h.session.identityAccountId);
      expect(frame.signer).not.toEqual(h.session.ssPublicKey);
    }
  });

  it('addresses each reply to the message id it answers', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-correlate', [
      buildSignRawMessage('m-first'),
      buildSignRawMessage('m-second'),
    ]);

    expect(
      repliesIn(frames).map((reply) => (reply.data.value.value as { respondingTo: string }).respondingTo),
    ).toEqual(['m-first', 'm-second']);
  });

  it('ignores statements published on another topic', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-elsewhere', [buildSignRawMessage()], [topic(9)]);

    expect(frames).toEqual([]);
    expect(h.responder.getSigningLog()).toEqual([]);
  });

  it('ignores the response variant rather than treating it as a request', () => {
    const h = harness();
    const frames = listen(h);
    const data = StatementData.enc({
      tag: 'response',
      value: { requestId: 'req-ignored', responseCode: 0 },
    });
    const statement = signStatement(h.session.ssSecret, {
      topics: [h.session.sessionIdOwn],
      data: seal(h.key, data),
    });
    const connection = h.store.connect(() => {});
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'statement_submit',
        params: [toHex(encodeStatement(statement))],
      }),
    );

    expect(frames).toEqual([]);
  });

  it('signs a raw payload with the resolved product account', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-raw', [buildSignRawMessage()]);

    const [reply] = replyValues(frames);
    const value = reply.value as { payload: { success: boolean; value: { signature: string } } };
    expect(value.payload.success).toBe(true);
    // 64-byte sr25519 signature, unprefixed — what the pre-migration raw path returned.
    expect(scale.hexToBytes(value.payload.value.signature)).toHaveLength(64);
  });

  it('signs an extrinsic payload and logs it as a payload signature', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-payload', [
      envelope('m-payload', 'SignRequest', {
        tag: 'payload',
        value: {
          account: ACCOUNT,
          payload: {
            blockHash: toHex(topic(3)),
            blockNumber: '0x01',
            era: '0x00',
            genesisHash: toHex(topic(4)),
            method: '0x0400',
            nonce: '0x00',
            specVersion: '0x01',
            tip: '0x00',
            transactionVersion: '0x01',
            signedExtensions: ['CheckMortality', 'CheckNonce', 'ChargeTransactionPayment'],
            version: 4,
            assetId: undefined,
            metadataHash: undefined,
            mode: undefined,
            withSignedTransaction: undefined,
          },
        },
      }),
    ]);

    expect(h.responder.getSigningLog()[0].type).toBe('payload');
    const [reply] = replyValues(frames);
    const value = reply.value as { payload: { success: boolean; value: { signature: string } } };
    // polkadot-js signers prefix the sr25519 MultiSignature index.
    expect(scale.hexToBytes(value.payload.value.signature)).toHaveLength(65);
    expect(scale.hexToBytes(value.payload.value.signature)[0]).toBe(0x01);
  });

  it('builds a signed extrinsic for a create-transaction request', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-tx', [
      envelope('m-tx', 'CreateTransactionRequest', {
        payload: {
          tag: 'v1',
          value: {
            signer: ACCOUNT,
            genesisHash: toHex(topic(4)),
            callData: '0x0400aabb',
            extensions: [{ id: 'CheckNonce', extra: '0x00', additionalSigned: '0x01000000' }],
            txExtVersion: 0,
          },
        },
      }),
    ]);

    expect(h.responder.getSigningLog()[0].type).toBe('createTransaction');
    const [reply] = replyValues(frames);
    expect(reply.tag).toBe('CreateTransactionResponse');
    const value = reply.value as { payload: { success: boolean; value: Uint8Array } };
    expect(value.payload.success).toBe(true);
    // [compact len][0x84][0x00][pubkey 32][0x01][sig 64] … — v4 signed extrinsic.
    // The body is 104 bytes here, so the compact length prefix is two bytes.
    expect(value.payload.value[2]).toBe(0x84);
    expect(value.payload.value.subarray(4, 36)).toEqual(
      h.resolveAccount(PRODUCT, INDEX_0).publicKey,
    );
  });

  it('grants allowance slots without building any extrinsic', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-alloc', [
      envelope('m-alloc', 'ResourceAllocationRequest', {
        callingProductId: PRODUCT,
        resources: [
          { tag: 'StatementStoreAllowance', value: undefined },
          { tag: 'BulletinAllowance', value: undefined },
          { tag: 'AutoSigning', value: undefined },
        ],
        onExisting: { tag: 'ignore', value: undefined },
      }),
    ]);

    const [reply] = replyValues(frames);
    expect(reply.tag).toBe('ResourceAllocationResponse');
    const outcomes = (
      reply.value as { payload: { success: boolean; value: Array<{ tag: string; value: unknown }> } }
    ).payload;
    expect(outcomes.success).toBe(true);
    expect(outcomes.value.map((outcome) => outcome.tag)).toEqual([
      'allocated',
      'allocated',
      'allocated',
    ]);
    const [statementStore, bulletin, autoSigning] = outcomes.value.map(
      (outcome) => outcome.value as { tag: string; value: Record<string, Uint8Array> },
    );
    expect(statementStore.tag).toBe('statementStoreAllowance');
    // The core adopts the slot key as a 64-byte sr25519 secret.
    expect(statementStore.value.slotAccountKey).toHaveLength(64);
    expect(bulletin.value.slotAccountKey).toHaveLength(64);
    expect(bulletin.value.slotAccountKey).not.toEqual(statementStore.value.slotAccountKey);
    // AutoSigning hands over the very subtree secret ProductSubtreeRequest
    // reports — in the canonical encoding, which is the only one the core's
    // `validate_auto_signing_key` accepts.
    const subtreeSecret = h.resolveAccount(PRODUCT, undefined).secretKey;
    expect(autoSigning.value.productRootPrivateKey).toEqual(canonicalSecretKey(subtreeSecret));
    expect(autoSigning.value.productRootPrivateKey).not.toEqual(subtreeSecret);
    expect(autoSigning.value.ringVrfDomainEntropy).toHaveLength(32);
    expect(h.responder.getSigningLog()).toEqual([]);
  });

  it('reports the product subtree public key resolveAccount derives', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-subtree', [
      envelope('m-subtree', 'ProductSubtreeRequest', { productId: PRODUCT }),
    ]);

    const [reply] = replyValues(frames);
    expect(reply.tag).toBe('ProductSubtreeResponse');
    expect((reply.value as { payload: { value: Uint8Array } }).payload.value).toEqual(
      h.resolveAccount(PRODUCT, undefined).publicKey,
    );
  });

  it('derives a deterministic contextual alias from the account public key', () => {
    const h = harness();
    const frames = listen(h);
    const proofContext = { productId: PRODUCT, suffix: INDEX_0 };
    const ring = { chainId: toHex(topic(5)), junctions: [] };

    submitRequest(h, 'req-alias', [
      envelope('m-alias', 'GetAccountAliasRequest', {
        callingProductId: PRODUCT,
        payload: { keyHandle: ACCOUNT, context: proofContext, ringLocation: ring },
      }),
    ]);

    const publicKey = h.resolveAccount(PRODUCT, INDEX_0).publicKey;
    const label = (text: string) => {
      const suffix = new TextEncoder().encode(text);
      const input = new Uint8Array(publicKey.length + suffix.length);
      input.set(publicKey, 0);
      input.set(suffix, publicKey.length);
      return toHex(blake2b(input, { dkLen: 32 }));
    };
    const [reply] = replyValues(frames);
    expect((reply.value as { payload: { value: unknown } }).payload.value).toEqual({
      context: label('context'),
      alias: label('alias'),
    });
  });

  it('registers, lists and signs with ring-VRF keys from an in-memory registry', () => {
    const h = harness();
    const frames = listen(h);
    const ring = { chainId: toHex(topic(6)), junctions: [] };
    const productRequest = <T>(payload: T) => ({ callingProductId: PRODUCT, payload });

    submitRequest(h, 'req-ring', [
      envelope('m-register', 'RegisterRingVrfKeyRequest', productRequest({ index: INDEX_0, ring })),
      envelope(
        'm-list',
        'ListRingVrfKeysRequest',
        productRequest({ owner: PRODUCT, disclosure: 'PublicKey' as const }),
      ),
      envelope(
        'm-sign',
        'RingVrfSignRequest',
        productRequest({ keyHandle: ACCOUNT, message: '0xdeadbeef' }),
      ),
    ]);

    const [registered, listed, signed] = replyValues(frames);
    expect(registered.tag).toBe('RegisterRingVrfKeyResponse');
    const registeredKey = (registered.value as { payload: { value: Uint8Array } }).payload.value;
    expect(registeredKey).toHaveLength(32);

    expect(listed.tag).toBe('ListRingVrfKeysResponse');
    const keys = (
      listed.value as {
        payload: { value: Array<{ handle: unknown; rings: unknown[]; publicKey?: string }> };
      }
    ).payload.value;
    expect(keys).toHaveLength(1);
    expect(keys[0].handle).toEqual(ACCOUNT);
    expect(keys[0].rings).toEqual([ring]);
    expect(keys[0].publicKey).toBe(toHex(registeredKey));

    expect(signed.tag).toBe('RingVrfSignResponse');
    expect((signed.value as { payload: { value: Uint8Array } }).payload.value).toHaveLength(64);
  });

  it('refuses to sign with a ring-VRF key that was never registered', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-ring-missing', [
      envelope('m-sign', 'RingVrfSignRequest', {
        callingProductId: PRODUCT,
        payload: { keyHandle: ACCOUNT, message: '0x00' },
      }),
    ]);

    const [reply] = replyValues(frames);
    expect((reply.value as { payload: { success: boolean; value: { tag: string } } }).payload)
      .toMatchObject({ success: false, value: { tag: 'keyNotRegistered' } });
  });

  it('stops answering once the peer disconnects', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-bye', [envelope('m-bye', 'Disconnected', undefined)]);
    submitRequest(h, 'req-after', [buildSignRawMessage()]);

    expect(frames).toEqual([]);
    expect(h.responder.getSigningLog()).toEqual([]);
  });

  it('stops answering after dispose', () => {
    const h = harness();
    const frames = listen(h);
    h.responder.dispose();

    submitRequest(h, 'req-disposed', [buildSignRawMessage()]);

    expect(frames).toEqual([]);
  });

  it('watermarks a product raw signature and skips it for the deprecated variant', () => {
    const h = harness();
    const frames = listen(h);
    const account = ACCOUNT;
    const payload = { tag: 'Payload' as const, value: { payload: 'hello' } };

    submitRequest(h, 'req-watermark', [
      envelope('m-watermarked', 'SignRequest', { tag: 'raw', value: { account, payload } }),
      envelope('m-plain', 'SignRequest', {
        tag: 'rawUnwatermarkedDeprecated',
        value: { account, payload },
      }),
    ]);

    const publicKey = h.resolveAccount(PRODUCT, INDEX_0).publicKey;
    const [watermarked, plain] = replyValues(frames);
    expect(verify(watermark('hello'), signatureOf(watermarked), publicKey)).toBe(true);
    expect(verify(utf8('hello'), signatureOf(watermarked), publicKey)).toBe(false);
    expect(verify(utf8('hello'), signatureOf(plain), publicKey)).toBe(true);
  });

  it('decodes a 0x-prefixed text payload as hex before signing it', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-ishex', [
      envelope('m-ishex', 'SignRequest', {
        tag: 'raw',
        value: { account: ACCOUNT, payload: { tag: 'Payload', value: { payload: '0xdeadbeef' } } },
      }),
    ]);

    const [reply] = replyValues(frames);
    const wrapped = new Uint8Array([
      ...utf8('<Bytes>'),
      0xde,
      0xad,
      0xbe,
      0xef,
      ...utf8('</Bytes>'),
    ]);
    expect(verify(wrapped, signatureOf(reply), h.resolveAccount(PRODUCT, INDEX_0).publicKey)).toBe(
      true,
    );
  });

  it('signs a legacy raw request with the session identity, watermarked', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-legacy-raw', [
      envelope('m-legacy-raw', 'SignRawWithLegacyAccountRequest', {
        account: identityOf(h),
        data: { tag: 'Payload', value: { payload: 'hello' } },
      }),
    ]);

    expect(h.responder.getSigningLog()[0].type).toBe('raw');
    const [reply] = replyValues(frames);
    expect(reply.tag).toBe('SignRawWithLegacyAccountResponse');
    const signature = (reply.value as { payload: { value: Uint8Array } }).payload.value;
    expect(verify(watermark('hello'), signature, h.session.identityAccountId)).toBe(true);
  });

  it('skips the watermark on the deprecated legacy raw variant', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-legacy-plain', [
      envelope('m-legacy-plain', 'SignRequest', {
        tag: 'rawWithLegacyAccountUnwatermarkedDeprecated',
        value: { account: identityOf(h), data: { tag: 'Payload', value: { payload: 'hello' } } },
      }),
    ]);

    const [reply] = replyValues(frames);
    expect(reply.tag).toBe('SignResponse');
    expect(verify(utf8('hello'), signatureOf(reply), h.session.identityAccountId)).toBe(true);
  });

  it('builds a legacy transaction attributed to the session identity', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-legacy-tx', [
      envelope('m-legacy-tx', 'CreateTransactionWithLegacyAccountRequest', {
        payload: {
          tag: 'v1',
          value: {
            signer: identityOf(h),
            genesisHash: toHex(topic(4)),
            callData: '0x0400aabb',
            extensions: [{ id: 'CheckNonce', extra: '0x00', additionalSigned: '0x01000000' }],
            txExtVersion: 0,
          },
        },
      }),
    ]);

    expect(h.responder.getSigningLog()[0].type).toBe('createTransaction');
    const [reply] = replyValues(frames);
    expect(reply.tag).toBe('CreateTransactionResponse');
    const extrinsic = (reply.value as { payload: { value: Uint8Array } }).payload.value;
    expect(extrinsic.subarray(4, 36)).toEqual(h.session.identityAccountId);
  });

  it('refuses a legacy request for an account it cannot sign for', () => {
    const h = harness();
    const frames = listen(h);
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stranger = toHex(new Uint8Array(32).fill(0xee));

    submitRequest(h, 'req-stranger', [
      envelope('m-stranger', 'SignRawWithLegacyAccountRequest', {
        account: stranger,
        data: { tag: 'Payload', value: { payload: 'hello' } },
      }),
    ]);
    reported.mockRestore();

    const [reply] = replyValues(frames);
    expect(reply.tag).toBe('SignRawWithLegacyAccountResponse');
    const payload = (reply.value as { payload: { success: boolean; value: string } }).payload;
    expect(payload.success).toBe(false);
    expect(payload.value).toContain(stranger);
  });

  it('answers a VRF request with a deterministic pre-output and a signature', () => {
    const h = harness();
    const frames = listen(h);
    const items: Array<{ label: `0x${string}`; value: `0x${string}` }> = [
      { label: '0x01', value: '0x02' },
    ];

    submitRequest(h, 'req-vrf', [
      envelope('m-vrf', 'SignVrfRequest', {
        callingProductId: PRODUCT,
        payload: { account: ACCOUNT, transcriptLabel: '0xaa', items },
      }),
      envelope('m-vrf-again', 'SignVrfRequest', {
        callingProductId: PRODUCT,
        payload: { account: ACCOUNT, transcriptLabel: '0xaa', items },
      }),
    ]);

    const [first, second] = replyValues(frames);
    expect(first.tag).toBe('SignVrfResponse');
    const signatureFor = (reply: { value: unknown }) =>
      (reply.value as { payload: { success: boolean; value: { preOutput: string; proof: string } } })
        .payload;
    expect(signatureFor(first).success).toBe(true);
    expect(scale.hexToBytes(signatureFor(first).value.preOutput)).toHaveLength(32);
    expect(scale.hexToBytes(signatureFor(first).value.proof)).toHaveLength(64);
    // The pre-output is a digest, so it is stable for the same transcript.
    expect(signatureFor(second).value.preOutput).toBe(signatureFor(first).value.preOutput);
    const transcript = new Uint8Array([0xaa, 0x01, 0x02]);
    expect(
      verify(
        transcript,
        scale.hexToBytes(signatureFor(first).value.proof),
        h.resolveAccount(PRODUCT, INDEX_0).publicKey,
      ),
    ).toBe(true);
  });

  it('answers an account-proof request with a signature over the message', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-proof', [
      envelope('m-proof', 'CreateAccountProofRequest', {
        callingProductId: PRODUCT,
        payload: {
          keyHandle: ACCOUNT,
          context: { productId: PRODUCT, suffix: INDEX_0 },
          ringLocation: { chainId: toHex(topic(5)), junctions: [] },
          message: '0xc0ffee',
        },
      }),
    ]);

    const [reply] = replyValues(frames);
    expect(reply.tag).toBe('CreateAccountProofResponse');
    const proof = (
      reply.value as {
        payload: {
          success: boolean;
          value: { proof: string; contextualAlias: { alias: string }; ringIndex: number; ringRevision: number };
        };
      }
    ).payload;
    expect(proof.success).toBe(true);
    const publicKey = h.resolveAccount(PRODUCT, INDEX_0).publicKey;
    expect(
      verify(new Uint8Array([0xc0, 0xff, 0xee]), scale.hexToBytes(proof.value.proof), publicKey),
    ).toBe(true);
    expect(proof.value.ringIndex).toBe(0);
    expect(proof.value.ringRevision).toBe(0);
    // The alias matches what GetAccountAliasRequest reports for the same account.
    const suffix = utf8('alias');
    const input = new Uint8Array(publicKey.length + suffix.length);
    input.set(publicKey, 0);
    input.set(suffix, publicKey.length);
    expect(proof.value.contextualAlias.alias).toBe(toHex(blake2b(input, { dkLen: 32 })));
  });

  it('grants a smart-contract allowance as the unit variant', () => {
    const h = harness();
    const frames = listen(h);

    submitRequest(h, 'req-contract', [
      envelope('m-contract', 'ResourceAllocationRequest', {
        callingProductId: PRODUCT,
        resources: [{ tag: 'SmartContractAllowance', value: INDEX_0 }],
        onExisting: { tag: 'increase', value: undefined },
      }),
    ]);

    const [reply] = replyValues(frames);
    const outcomes = (
      reply.value as { payload: { value: Array<{ tag: string; value: { tag: string } }> } }
    ).payload.value;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].tag).toBe('allocated');
    expect(outcomes[0].value.tag).toBe('smartContractAllowance');
  });

  it('refuses a request whose handler throws instead of leaving the core waiting', () => {
    const h = harness('no such account');
    const frames = listen(h);
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

    submitRequest(h, 'req-broken', [buildSignRawMessage()]);
    reported.mockRestore();

    expect(frames[0].data.tag).toBe('response');
    const [reply] = replyValues(frames);
    expect(reply.tag).toBe('SignResponse');
    expect((reply.value as { payload: unknown }).payload).toEqual({
      success: false,
      value: 'no such account',
    });
  });

  it('answers with a failure when a reply will not encode, instead of dropping it', () => {
    // Fault injection: a subtree answer with no public key. `Bytes(32)` throws
    // on it, which is the class of defect that used to escape the reply loop —
    // the ack was published, the encode threw outside every `try`, the store
    // swallowed it, and the core waited forever with nothing in the console.
    const withoutPublicKey: ResolveAccountFn = () => ({
      ...deriveDev('Alice'),
      publicKey: undefined as unknown as Uint8Array,
    });
    const h = harness(undefined, withoutPublicKey);
    const frames = listen(h);
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

    submitRequest(h, 'req-unencodable', [
      envelope('m-subtree', 'ProductSubtreeRequest', { productId: PRODUCT }),
    ]);

    const logged = reported.mock.calls.map((call) => String(call[0]));
    reported.mockRestore();

    // The ack still goes out first, and the reply is a refusal rather than
    // silence — so the core fails the call instead of hanging on it.
    expect(frames[0].data.tag).toBe('response');
    const [reply] = replyValues(frames);
    expect(reply.tag).toBe('ProductSubtreeResponse');
    const payload = (reply.value as { payload: { success: boolean; value: string } }).payload;
    expect(payload.success).toBe(false);
    expect(payload.value).toMatch(/reply could not be encoded/);
    expect(logged.some((line) => line.includes('could not encode'))).toBe(true);
  });

  it('rejects a session whose identity secret does not match its account id', () => {
    const h = harness();
    expect(() =>
      createSsoResponder({
        store: h.store,
        session: { ...h.session, identitySecret: deriveDev('Bob').secretKey },
        resolveAccount: h.resolveAccount,
      }),
    ).toThrow(/identitySecret/);
  });
});
