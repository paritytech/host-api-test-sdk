/**
 * In-memory ring-VRF key registry for the local SSO responder.
 *
 * A real Account Holder registers ring-VRF keys against an on-chain ring and
 * proves membership with a Bandersnatch ring proof. Nothing here touches a
 * chain: registration records the requested ring against a deterministic
 * stand-in key derived from the product account, listing replays what was
 * registered, and signing is an sr25519 signature over the message. That is
 * enough for a product to exercise the full request/response surface, and the
 * registry's behaviour (unknown handle → `keyNotRegistered`) is real.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { sign } from '@scure/sr25519';
import { scale } from '@parity/truapi';
import type { DevKeypair } from '../dev-accounts.js';
import type { RemoteMessagePayload } from './messages.js';

type RegisterRequest = RemoteMessagePayload<'RegisterRingVrfKeyRequest'>;
type ListRequest = RemoteMessagePayload<'ListRingVrfKeysRequest'>;
type SignRequest = RemoteMessagePayload<'RingVrfSignRequest'>;

type RegisterResult = RemoteMessagePayload<'RegisterRingVrfKeyResponse'>['payload'];
type ListResult = RemoteMessagePayload<'ListRingVrfKeysResponse'>['payload'];
type SignResult = RemoteMessagePayload<'RingVrfSignResponse'>['payload'];

type KeyHandle = RegisterResultHandle;
type RegisterResultHandle = Extract<ListResult, { success: true }>['value'][number]['handle'];
type RingLocation = Extract<ListResult, { success: true }>['value'][number]['rings'][number];

/** Resolves the dev keypair backing one product account. */
export type ResolveAccount = (dotNsIdentifier: string, derivationIndex: unknown) => DevKeypair;

interface RingVrfEntry {
  owner: string;
  handle: KeyHandle;
  rings: RingLocation[];
  publicKey: Uint8Array;
  keypair: DevKeypair;
}

export interface RingVrfRegistry {
  register(request: RegisterRequest): RegisterResult;
  list(request: ListRequest): ListResult;
  sign(request: SignRequest): SignResult;
}

const KEY_NOT_REGISTERED = {
  success: false,
  value: { tag: 'keyNotRegistered', value: undefined },
} as const;

/** Stable identity for one `(dotNsIdentifier, derivationIndex)` pair. */
function handleKey(handle: KeyHandle): string {
  const index = handle.derivationIndex;
  return `${handle.dotNsIdentifier}#${index.tag}:${String(index.value)}`;
}

/**
 * Deterministic 32-byte stand-in for the ring-VRF public key.
 *
 * Derived from the account public key so the same product account always
 * reports the same key, across runs and across responder instances.
 */
function ringVrfPublicKey(accountPublicKey: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode('ring-vrf');
  const input = new Uint8Array(accountPublicKey.length + label.length);
  input.set(accountPublicKey, 0);
  input.set(label, accountPublicKey.length);
  return blake2b(input, { dkLen: 32 });
}

export function createRingVrfRegistry(resolveAccount: ResolveAccount): RingVrfRegistry {
  const entries = new Map<string, RingVrfEntry>();

  return {
    register({ callingProductId, payload }) {
      const handle: KeyHandle = {
        dotNsIdentifier: callingProductId,
        derivationIndex: payload.index,
      };
      const key = handleKey(handle);
      const existing = entries.get(key);
      if (existing) {
        // Re-registering an existing handle widens it to the new ring rather
        // than replacing it, matching "a key may belong to several rings".
        existing.rings.push(payload.ring);
        return { success: true, value: existing.publicKey };
      }
      const keypair = resolveAccount(callingProductId, payload.index);
      const publicKey = ringVrfPublicKey(keypair.publicKey);
      entries.set(key, {
        owner: callingProductId,
        handle,
        rings: [payload.ring],
        publicKey,
        keypair,
      });
      return { success: true, value: publicKey };
    },

    list({ callingProductId, payload }) {
      // An empty `owner` means "whoever is asking".
      const owner = payload.owner === '' ? callingProductId : payload.owner;
      const disclosed = payload.disclosure === 'PublicKey';
      const keys = [...entries.values()]
        .filter((entry) => entry.owner === owner)
        .map((entry) => ({
          handle: entry.handle,
          rings: entry.rings,
          publicKey: disclosed ? scale.bytesToHex(entry.publicKey) : undefined,
        }));
      return { success: true, value: keys };
    },

    sign({ payload }) {
      const entry = entries.get(handleKey(payload.keyHandle));
      if (!entry) return KEY_NOT_REGISTERED;
      return { success: true, value: sign(entry.keypair.secretKey, scale.hexToBytes(payload.message)) };
    },
  };
}
