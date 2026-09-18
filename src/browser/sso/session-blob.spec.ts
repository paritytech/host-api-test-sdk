import { describe, expect, it } from 'vitest';
import { SessionInfo, SsoSessionInfo, encodeExternalPairedSession } from './session-blob.js';

const bytes = (fill: number, length = 32) => new Uint8Array(length).fill(fill);

describe('session blob', () => {
  const options = {
    rootPublicKey: bytes(1),
    identityAccountId: bytes(2),
    encSecret: bytes(3),
    peerEncPubkey: bytes(4),
    ssSecret: bytes(5, 64),
    ssPublicKey: bytes(6),
    sessionIdOwn: bytes(7),
    sessionIdPeer: bytes(8),
  };

  it('prefixes the blob with the v1 layout tag', () => {
    expect(encodeExternalPairedSession(options)[0]).toBe(1);
  });

  it('round-trips through the SessionInfo codec', () => {
    const decoded = SessionInfo.dec(encodeExternalPairedSession(options).slice(1));
    expect(decoded.public_key).toEqual(options.rootPublicKey);
    expect(decoded.sso?.session_id_own).toEqual(options.sessionIdOwn);
    expect(decoded.sso?.peer_enc_pubkey).toEqual(options.peerEncPubkey);
    expect(decoded.identity_account_id).toEqual(options.identityAccountId);
  });

  it('leaves usernames unset so the runtime resolves them itself', () => {
    const decoded = SessionInfo.dec(encodeExternalPairedSession(options).slice(1));
    expect(decoded.lite_username).toBeUndefined();
    expect(decoded.full_username).toBeUndefined();
  });

  it('consumes the blob exactly, with no trailing bytes', () => {
    const body = encodeExternalPairedSession(options).slice(1);
    expect(SessionInfo.enc(SessionInfo.dec(body))).toEqual(body);
  });

  it('encodes the SSO block to exactly 352 bytes (mirrors Rust SSO_ENCODED_LEN)', () => {
    const ssoData = {
      ss_secret: bytes(5, 64),
      ss_public_key: bytes(6),
      enc_secret: bytes(3),
      peer_enc_pubkey: bytes(4),
      identity_account_id: bytes(2),
      session_id_own: bytes(7),
      session_id_peer: bytes(8),
      request_channel: bytes(9),
      response_channel: bytes(10),
      peer_request_channel: bytes(11),
    };
    const encoded = SsoSessionInfo.enc(ssoData);
    expect(encoded.length).toBe(352);
  });

  it('encodes the full blob to exactly 456 bytes with standard shape', () => {
    const blob = encodeExternalPairedSession(options);
    // 1 tag + 32 public_key + (1+352) sso + (1+32) root_entropy_source + (1+32) identity_account_id + 4 None tags
    expect(blob.length).toBe(456);
  });

  it('throws on wrong-width input', () => {
    expect(() =>
      encodeExternalPairedSession({
        ...options,
        ssSecret: new Uint8Array(32), // Wrong: should be 64
      }),
    ).toThrow('ssSecret must be exactly 64 bytes');

    expect(() =>
      encodeExternalPairedSession({
        ...options,
        rootPublicKey: new Uint8Array(31), // Wrong: should be 32
      }),
    ).toThrow('rootPublicKey must be exactly 32 bytes');
  });
});
