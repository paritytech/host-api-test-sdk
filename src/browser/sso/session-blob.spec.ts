import { describe, expect, it } from 'vitest';
import { SessionInfo, encodeExternalPairedSession } from './session-blob.js';

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
});
