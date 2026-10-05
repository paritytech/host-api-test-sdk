import { describe, expect, it } from 'vitest';
import { scale } from '@parity/truapi';
import {
  REMOTE_MESSAGE_VARIANTS,
  RemoteMessage,
  RemoteMessageEnvelope,
  StatementData,
  VersionedRemoteMessage,
} from './messages.js';

describe('sso messages', () => {
  it('round-trips a request envelope', () => {
    const value = { requestId: 'abc', data: [new Uint8Array([1, 2])] };
    const encoded = StatementData.enc({ tag: 'request', value });
    expect(StatementData.dec(encoded)).toEqual({ tag: 'request', value });
  });

  it('round-trips a response envelope with an accepted code', () => {
    const value = { requestId: 'abc', responseCode: 0 };
    expect(StatementData.dec(StatementData.enc({ tag: 'response', value }))).toEqual({
      tag: 'response',
      value,
    });
  });

  it('pins the RemoteMessage variant order to the Rust wire protocol', () => {
    expect(REMOTE_MESSAGE_VARIANTS.indexOf('Disconnected')).toBe(0);
    expect(REMOTE_MESSAGE_VARIANTS.indexOf('SignRequest')).toBe(1);
    expect(REMOTE_MESSAGE_VARIANTS.indexOf('SignVrfRequest')).toBe(14);
    expect(REMOTE_MESSAGE_VARIANTS.indexOf('ProductSubtreeRequest')).toBe(16);
    expect(REMOTE_MESSAGE_VARIANTS.indexOf('RingVrfSignResponse')).toBe(23);
    expect(REMOTE_MESSAGE_VARIANTS.indexOf('Cancel')).toBe(24);
  });

  // Every one of the 25 `v1::RemoteMessage` variants against its declared
  // position (14-24 are `#[codec(index = N)]`-pinned upstream), so a dropped or
  // reordered entry fails here instead of shifting every later wire index.
  it('pins every RemoteMessage variant to its exact wire index (all 25)', () => {
    const expectedIndexByVariant: Record<(typeof REMOTE_MESSAGE_VARIANTS)[number], number> = {
      Disconnected: 0,
      SignRequest: 1,
      SignResponse: 2,
      GetAccountAliasRequest: 3,
      GetAccountAliasResponse: 4,
      ResourceAllocationRequest: 5,
      ResourceAllocationResponse: 6,
      CreateTransactionRequest: 7,
      CreateTransactionResponse: 8,
      CreateTransactionWithLegacyAccountRequest: 9,
      SignRawWithLegacyAccountRequest: 10,
      SignRawWithLegacyAccountResponse: 11,
      CreateAccountProofRequest: 12,
      CreateAccountProofResponse: 13,
      SignVrfRequest: 14,
      SignVrfResponse: 15,
      ProductSubtreeRequest: 16,
      ProductSubtreeResponse: 17,
      RegisterRingVrfKeyRequest: 18,
      RegisterRingVrfKeyResponse: 19,
      ListRingVrfKeysRequest: 20,
      ListRingVrfKeysResponse: 21,
      RingVrfSignRequest: 22,
      RingVrfSignResponse: 23,
      Cancel: 24,
    };

    expect(Object.keys(expectedIndexByVariant)).toHaveLength(REMOTE_MESSAGE_VARIANTS.length);
    for (const [variant, expectedIndex] of Object.entries(expectedIndexByVariant)) {
      expect(REMOTE_MESSAGE_VARIANTS.indexOf(variant as never)).toBe(expectedIndex);
    }
  });

  // The same guard through the real codec, so it also catches a bug in how
  // `RemoteMessage` derives its key order rather than only an array reorder.
  it('encodes and round-trips every RemoteMessage variant at its exact wire index (all 25)', () => {
    const hex = (byteLen: number, byte = '11') => ('0x' + byte.repeat(byteLen)) as `0x${string}`;
    const productAccountId = (dotNsIdentifier: string) => ({
      dotNsIdentifier,
      derivationIndex: { tag: 'Index' as const, value: 0 },
    });
    const ringLocation = { chainId: hex(32), junctions: [] as never[] };

    const fixtures: Array<{ index: number; tag: string; value: unknown }> = [
      { index: 0, tag: 'Disconnected', value: undefined },
      {
        index: 1,
        tag: 'SignRequest',
        value: {
          tag: 'raw',
          value: {
            account: productAccountId('myapp.dot'),
            payload: { tag: 'Bytes', value: { bytes: hex(2) } },
          },
        },
      },
      {
        index: 2,
        tag: 'SignResponse',
        value: { respondingTo: 'm1', payload: { success: true, value: { signature: hex(1) } } },
      },
      {
        index: 3,
        tag: 'GetAccountAliasRequest',
        value: {
          callingProductId: 'caller.dot',
          payload: {
            keyHandle: productAccountId('peopl.dot'),
            context: { productId: 'voting.dot', suffix: { tag: 'Index', value: 0 } },
            ringLocation,
          },
        },
      },
      {
        index: 4,
        tag: 'GetAccountAliasResponse',
        value: {
          respondingTo: 'm-alias',
          payload: { success: true, value: { context: hex(32), alias: hex(2) } },
        },
      },
      {
        index: 5,
        tag: 'ResourceAllocationRequest',
        value: {
          callingProductId: 'truapi-playground.dot',
          resources: [{ tag: 'StatementStoreAllowance', value: undefined }],
          onExisting: { tag: 'ignore', value: undefined },
        },
      },
      {
        index: 6,
        tag: 'ResourceAllocationResponse',
        value: {
          respondingTo: 'm-resource',
          payload: { success: true, value: [{ tag: 'rejected', value: undefined }] },
        },
      },
      {
        index: 7,
        tag: 'CreateTransactionRequest',
        value: {
          payload: {
            tag: 'v1',
            value: {
              signer: productAccountId('truapi-playground.dot'),
              genesisHash: hex(32),
              callData: hex(2),
              extensions: [],
              txExtVersion: 0,
            },
          },
        },
      },
      {
        index: 8,
        tag: 'CreateTransactionResponse',
        value: { respondingTo: 'm-tx', payload: { success: true, value: new Uint8Array([1, 2, 3]) } },
      },
      {
        index: 9,
        tag: 'CreateTransactionWithLegacyAccountRequest',
        value: {
          payload: {
            tag: 'v1',
            value: {
              signer: hex(32),
              genesisHash: hex(32),
              callData: hex(2),
              extensions: [],
              txExtVersion: 0,
            },
          },
        },
      },
      {
        index: 10,
        tag: 'SignRawWithLegacyAccountRequest',
        value: { account: hex(32), data: { tag: 'Bytes', value: { bytes: hex(2) } } },
      },
      {
        index: 11,
        tag: 'SignRawWithLegacyAccountResponse',
        value: { respondingTo: 'm-legacy-raw', payload: { success: true, value: new Uint8Array([4, 5]) } },
      },
      {
        index: 12,
        tag: 'CreateAccountProofRequest',
        value: {
          callingProductId: 'caller.dot',
          payload: {
            keyHandle: productAccountId('peopl.dot'),
            context: { productId: 'voting.dot', suffix: { tag: 'Index', value: 0 } },
            ringLocation,
            message: hex(4),
          },
        },
      },
      {
        index: 13,
        tag: 'CreateAccountProofResponse',
        value: {
          respondingTo: 'm-proof',
          payload: {
            success: true,
            value: {
              proof: hex(2),
              contextualAlias: { context: hex(32), alias: hex(2) },
              ringIndex: 7,
              ringRevision: 9,
            },
          },
        },
      },
      {
        index: 14,
        tag: 'SignVrfRequest',
        value: {
          callingProductId: 'browse.dot',
          payload: {
            account: productAccountId('browse.dot'),
            transcriptLabel: hex(3),
            items: [{ label: hex(2), value: hex(1) }],
          },
        },
      },
      {
        index: 15,
        tag: 'SignVrfResponse',
        value: { respondingTo: 'req', payload: { success: true, value: { preOutput: hex(32), proof: hex(64) } } },
      },
      { index: 16, tag: 'ProductSubtreeRequest', value: { productId: 'browse.dot' } },
      {
        index: 17,
        tag: 'ProductSubtreeResponse',
        value: { respondingTo: 'request', payload: { success: true, value: new Uint8Array(32).fill(0xab) } },
      },
      {
        index: 18,
        tag: 'RegisterRingVrfKeyRequest',
        value: {
          callingProductId: 'game.dot',
          payload: { index: { tag: 'Index', value: 4 }, ring: ringLocation },
        },
      },
      {
        index: 19,
        tag: 'RegisterRingVrfKeyResponse',
        value: { respondingTo: 'r', payload: { success: true, value: new Uint8Array(32).fill(1) } },
      },
      {
        index: 20,
        tag: 'ListRingVrfKeysRequest',
        value: { callingProductId: 'game.dot', payload: { owner: 'peopl.dot', disclosure: 'PublicKey' } },
      },
      {
        index: 21,
        tag: 'ListRingVrfKeysResponse',
        value: { respondingTo: 'r', payload: { success: true, value: [] } },
      },
      {
        index: 22,
        tag: 'RingVrfSignRequest',
        value: {
          callingProductId: 'game.dot',
          payload: { keyHandle: productAccountId('peopl.dot'), message: hex(2) },
        },
      },
      {
        index: 23,
        tag: 'RingVrfSignResponse',
        value: {
          respondingTo: 'r1',
          payload: { success: false, value: { tag: 'notMember', value: undefined } },
        },
      },
      {
        index: 24,
        tag: 'Cancel',
        value: { messageId: 'm-withdrawn' },
      },
    ];

    expect(fixtures).toHaveLength(REMOTE_MESSAGE_VARIANTS.length);
    for (const { index, tag, value } of fixtures) {
      expect(REMOTE_MESSAGE_VARIANTS.indexOf(tag as never)).toBe(index);
      const encoded = RemoteMessage.enc({ tag, value } as never);
      expect(encoded[0]).toBe(index);
      expect(RemoteMessage.dec(encoded)).toEqual({ tag, value });
    }
  });

  it('round-trips the unit Disconnected variant at its pinned wire index', () => {
    const encoded = RemoteMessage.enc({ tag: 'Disconnected', value: undefined });
    expect(encoded).toEqual(new Uint8Array([0]));
    expect(RemoteMessage.dec(encoded)).toEqual({ tag: 'Disconnected', value: undefined });
  });

  it('round-trips a ProductSubtreeRequest at its pinned wire index (16)', () => {
    const value = { productId: 'browse.dot' };
    const encoded = RemoteMessage.enc({ tag: 'ProductSubtreeRequest', value });
    expect(encoded[0]).toBe(16);
    expect(RemoteMessage.dec(encoded)).toEqual({ tag: 'ProductSubtreeRequest', value });
  });

  it('round-trips a raw SignRequest', () => {
    const value = {
      tag: 'raw' as const,
      value: {
        account: {
          dotNsIdentifier: 'myapp.dot',
          derivationIndex: { tag: 'Index' as const, value: 7 },
        },
        payload: { tag: 'Bytes' as const, value: { bytes: '0xdead' as const } },
      },
    };
    const encoded = RemoteMessage.enc({ tag: 'SignRequest', value });
    expect(encoded[0]).toBe(1);
    expect(RemoteMessage.dec(encoded)).toEqual({ tag: 'SignRequest', value });
  });

  it('round-trips an Ok SignResponse Result envelope', () => {
    const value = {
      respondingTo: 'm1',
      payload: { success: true as const, value: { signature: '0xaa' as const } },
    };
    const encoded = RemoteMessage.enc({ tag: 'SignResponse', value });
    expect(encoded[0]).toBe(2);
    expect(RemoteMessage.dec(encoded)).toEqual({ tag: 'SignResponse', value });
  });

  it('round-trips an Err RingVrfSignResponse at its pinned wire index (23)', () => {
    const value = {
      respondingTo: 'r1',
      payload: { success: false as const, value: { tag: 'notMember' as const, value: undefined } },
    };
    const encoded = RemoteMessage.enc({ tag: 'RingVrfSignResponse', value });
    expect(encoded[0]).toBe(23);
    expect(RemoteMessage.dec(encoded)).toEqual({ tag: 'RingVrfSignResponse', value });
  });

  it('wraps RemoteMessage under the V1 version tag', () => {
    const message = { tag: 'Disconnected' as const, value: undefined };
    const encoded = VersionedRemoteMessage.enc({ tag: 'V1', value: message });
    expect(encoded[0]).toBe(0);
    expect(VersionedRemoteMessage.dec(encoded)).toEqual({ tag: 'V1', value: message });
  });

  // Byte-for-byte against the fixtures upstream pins in
  // `host_internal/sso_messages.rs`, generated from host-papp's own codec. A
  // product-account transaction crosses SSO without `contacts`: the pairing
  // host has already substituted them, so carrying truapi's
  // `ProductAccountTxPayload` here would append a byte the core rejects.
  describe('host-papp wire fixtures', () => {
    const envelope = (messageId: string, value: Parameters<typeof RemoteMessage.enc>[0]) =>
      RemoteMessageEnvelope.enc({ messageId, data: { tag: 'V1', value } });
    const sequential = (start: number) =>
      scale.bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => (start + i) & 0xff));
    const playground = {
      dotNsIdentifier: 'truapi-playground.dot',
      derivationIndex: { tag: 'Index' as const, value: 0 },
    };

    it('encodes a product-account CreateTransactionRequest without contacts', () => {
      const message = {
        tag: 'CreateTransactionRequest' as const,
        value: {
          payload: {
            tag: 'v1' as const,
            value: {
              signer: playground,
              genesisHash: sequential(32),
              callData: '0x0000' as const,
              extensions: [{ id: 'CheckNonce', extra: '0x01' as const, additionalSigned: '0x0203' as const }],
              txExtVersion: 0,
            },
          },
        },
      };
      const fixture =
        '0x306d2d70726f647563742d7478000700547472756170692d706c617967726f756e642e646f740000000000202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f0800000428436865636b4e6f6e6365040108020300';

      expect(scale.bytesToHex(envelope('m-product-tx', message))).toBe(fixture);
      expect(RemoteMessageEnvelope.dec(scale.hexToBytes(fixture))).toEqual({
        messageId: 'm-product-tx',
        data: { tag: 'V1', value: message },
      });
    });

    it('encodes the playground CreateTransactionRequest', () => {
      const message = {
        tag: 'CreateTransactionRequest' as const,
        value: {
          payload: {
            tag: 'v1' as const,
            value: {
              signer: playground,
              genesisHash: '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f' as const,
              callData: '0x0000' as const,
              extensions: [],
              txExtVersion: 0,
            },
          },
        },
      };

      expect(scale.bytesToHex(envelope('create-transaction-1', message))).toBe(
        '0x506372656174652d7472616e73616374696f6e2d31000700547472756170692d706c617967726f756e642e646f740000000000bf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f0800000000',
      );
    });

    it('encodes a legacy-account CreateTransactionWithLegacyAccountRequest', () => {
      const message = {
        tag: 'CreateTransactionWithLegacyAccountRequest' as const,
        value: {
          payload: {
            tag: 'v1' as const,
            value: {
              signer: sequential(0),
              genesisHash: sequential(32),
              callData: '0x0000' as const,
              extensions: [{ id: 'CheckNonce', extra: '0x01' as const, additionalSigned: '0x0203' as const }],
              txExtVersion: 0,
            },
          },
        },
      };

      expect(scale.bytesToHex(envelope('m-legacy-tx', message))).toBe(
        '0x2c6d2d6c65676163792d7478000900000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f0800000428436865636b4e6f6e6365040108020300',
      );
    });

    it('encodes a SignRawWithLegacyAccountRequest', () => {
      const message = {
        tag: 'SignRawWithLegacyAccountRequest' as const,
        value: { account: sequential(0), data: { tag: 'Bytes' as const, value: { bytes: '0x4869' as const } } },
      };

      expect(scale.bytesToHex(envelope('m-legacy-raw', message))).toBe(
        '0x306d2d6c65676163792d726177000a000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00084869',
      );
    });
  });
});
