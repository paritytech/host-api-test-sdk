// src/browser/sso/messages.spec.ts
import { describe, expect, it } from 'vitest';
import { REMOTE_MESSAGE_VARIANTS, RemoteMessage, StatementData, VersionedRemoteMessage } from './messages.js';

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
});
