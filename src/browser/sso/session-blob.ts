/**
 * Codec for the core-owned persisted-session blob.
 *
 * Mirrors `SessionInfo` in
 * `../host-rust-core/rust/crates/truapi-server/src/host_logic/session.rs`.
 * The layout is positional and core-private; the leading version tag is what
 * turns an upstream layout change into a decode failure rather than silent
 * drift, so it must never be dropped.
 */
import { Bytes, Option, Struct, str, u8 } from 'scale-ts';

/** `PERSISTED_SESSION_V1`. */
const PERSISTED_SESSION_V1 = 1;

const Bytes32 = Bytes(32);
const Bytes64 = Bytes(64);

export const SsoSessionInfo = Struct({
  ss_secret: Bytes64,
  ss_public_key: Bytes32,
  enc_secret: Bytes32,
  peer_enc_pubkey: Bytes32,
  identity_account_id: Bytes32,
  session_id_own: Bytes32,
  session_id_peer: Bytes32,
  request_channel: Bytes32,
  response_channel: Bytes32,
  peer_request_channel: Bytes32,
});

export const SessionInfo = Struct({
  public_key: Bytes32,
  sso: Option(SsoSessionInfo),
  root_entropy_source: Option(Bytes32),
  identity_account_id: Option(Bytes32),
  identity_chat_private_key: Option(Bytes32),
  device_enc_public_key: Option(Bytes32),
  lite_username: Option(str),
  full_username: Option(str),
});

export function encodePersistedSession(
  info: Parameters<typeof SessionInfo.enc>[0],
): Uint8Array {
  const body = SessionInfo.enc(info);
  const blob = new Uint8Array(1 + body.length);
  blob[0] = u8.enc(PERSISTED_SESSION_V1)[0];
  blob.set(body, 1);
  return blob;
}

export interface ExternalSessionOptions {
  /** The signer's sr25519 root public key. */
  rootPublicKey: Uint8Array;
  identityAccountId: Uint8Array;
  rootEntropySource?: Uint8Array;
  /** Host's X25519 secret. */
  encSecret: Uint8Array;
  /** The local peer's X25519 public key. */
  peerEncPubkey: Uint8Array;
  /** Host's 64-byte statement-store signing secret. */
  ssSecret: Uint8Array;
  ssPublicKey: Uint8Array;
  /** Topic the host publishes requests on. */
  sessionIdOwn: Uint8Array;
  /** Topic the peer publishes replies on. */
  sessionIdPeer: Uint8Array;
}

/**
 * Encode an already-paired session, as `encode_external_paired_session` does.
 *
 * Usernames are deliberately absent: the runtime resolves and persists those
 * through its own identity lookup.
 */
export function encodeExternalPairedSession(
  options: ExternalSessionOptions,
): Uint8Array {
  const { rootEntropySource = new Uint8Array(32) } = options;
  return encodePersistedSession({
    public_key: options.rootPublicKey,
    sso: {
      ss_secret: options.ssSecret,
      ss_public_key: options.ssPublicKey,
      enc_secret: options.encSecret,
      peer_enc_pubkey: options.peerEncPubkey,
      identity_account_id: options.identityAccountId,
      session_id_own: options.sessionIdOwn,
      session_id_peer: options.sessionIdPeer,
      request_channel: new Uint8Array(32),
      response_channel: new Uint8Array(32),
      peer_request_channel: new Uint8Array(32),
    },
    root_entropy_source: rootEntropySource,
    identity_account_id: options.identityAccountId,
    identity_chat_private_key: undefined,
    device_enc_public_key: undefined,
    lite_username: undefined,
    full_username: undefined,
  });
}
