/**
 * Real ring-VRF proof generation for `createRingVRFProof`.
 *
 * Unlike a production host, this test host holds the raw account URIs, so it
 * can legitimately do what a host does internally. It derives the RFC-0022
 * personhood member entropy from the account mnemonic, reads the ring the
 * member sits in from the People chain, and produces a bandersnatch ring-VRF
 * proof with verifiablejs. When personhood is minted for that member on the
 * target network, the returned proof passes network verification. That is
 * what lets a product e2e exercise flows like registry publishing for real.
 *
 * Runs in the Node server, because verifiablejs is a wasm module and the ring
 * reads need chain clients. The browser runtime reaches it over the
 * `/__create-proof` route and resolves the signing URI itself, since account
 * precedence, including `setAccounts` overrides, lives in the browser.
 * Everything here is imported lazily so consumers that never enable
 * `ringVrfProofs` load none of it.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { mnemonicToEntropy } from '@polkadot/util-crypto';
import { createClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import {
  encodeMemberKeys,
  fullPersonRingVrfEntropy,
  productProofContext,
} from './ring-vrf-keys.js';
import type { HexString, ProofSuffix, RingVrfProofsOptions } from './types.js';

export interface RingProofRequest {
  /** Substrate URI of the account whose person the proof speaks for. */
  uri: string;
  productId: string;
  suffix: ProofSuffix;
  message: Uint8Array;
}

export interface RingProofResult {
  proof: Uint8Array;
  context: Uint8Array;
  alias: Uint8Array;
  ringIndex: number;
  ringRevision: number;
}

/** Decode a hex string with or without its `0x` prefix. */
export function bytesOfHex(hex: string): Uint8Array {
  return hexToBytes(hex.startsWith('0x') ? hex.slice(2) : hex);
}

/** Encode bytes as `0x`-prefixed hex. */
export function hexOfBytes(bytes: Uint8Array): HexString {
  return `0x${bytesToHex(bytes)}`;
}

/** Bytes of a chain value that arrives as `Binary` or as hex. */
function chainBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return bytesOfHex(value);
  const binary = value as { asBytes?: () => Uint8Array } | null;
  if (typeof binary?.asBytes === 'function') return binary.asBytes();
  throw new Error('cannot coerce chain value to bytes');
}

/**
 * The BIP-39 mnemonic inside a Substrate URI.
 *
 * A derivation suffix is ignored, because member keys hang off the root
 * entropy. Dev URIs like `//Alice` are rejected with guidance, since they
 * carry no entropy to be a person with.
 */
function mnemonicOfUri(uri: string): string {
  const mnemonic = uri.split('//')[0].trim();
  if (!/^(\w+ ){11,23}\w+$/.test(mnemonic)) {
    throw new Error(
      `Real ring-VRF proofs need a BIP-39 mnemonic account. "${uri.slice(0, 12)}…" has no entropy to derive a member key from`,
    );
  }
  return mnemonic;
}

/** Build a real ring-VRF proof for `request`, reading the ring from chain. */
export async function buildRingProof(
  options: RingVrfProofsOptions,
  request: RingProofRequest,
): Promise<RingProofResult> {
  const { member_from_entropy, one_shot, validate_with_commitment } =
    await import('verifiablejs/nodejs');

  const entropy = fullPersonRingVrfEntropy(
    mnemonicToEntropy(mnemonicOfUri(request.uri)),
    options.tld,
  );
  const memberKey = member_from_entropy(entropy) as Uint8Array;

  const context =
    options.context === undefined || options.context === 'product'
      ? productProofContext(request.productId, request.suffix)
      : bytesOfHex(options.context);
  if (context.length !== 32) {
    throw new Error(`Proof context must be 32 bytes, got ${context.length}`);
  }

  const peopleClient = createClient(getWsProvider(options.peopleRpcUrl));
  const ringRootsClient = createClient(getWsProvider(options.ringRootsRpcUrl));
  try {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const peopleApi = peopleClient.getUnsafeApi() as any;
    const ringRootsApi = ringRootsClient.getUnsafeApi() as any;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // The collection identifier keys the Members storage on the People chain
    // AND the RingRoots storage on the subscriber chain, so both queries
    // derive from the one chain constant rather than a baked-in copy of it.
    const [collection, exponent] = await Promise.all([
      ringRootsApi.constants.AliasAccounts.PeopleCollectionIdentifier(),
      ringRootsApi.constants.AliasAccounts.PeopleRingExponent(),
    ]);
    const identifier = hexOfBytes(chainBytes(collection));

    const position = await peopleApi.query.Members.Members.getValue(
      identifier,
      hexOfBytes(memberKey),
      { at: 'best' },
    );
    if (!position || position.type !== 'Included') {
      throw new Error(
        `Member key ${hexOfBytes(memberKey)} is not in a ring (${position?.type ?? 'absent'}). Mint personhood for it first`,
      );
    }
    const ringIndex = Number(position.value.ring_index);

    const [ringKeyEntries, ringRoots] = await Promise.all([
      peopleApi.query.Members.RingKeys.getEntries(identifier, ringIndex, {
        at: 'best',
      }),
      ringRootsApi.query.MembersSubscriber.RingRoots.getValue(
        0,
        collection,
        ringIndex,
        { at: 'best' },
      ),
    ]);
    if (!ringRoots || ringRoots.length === 0) {
      throw new Error(
        `No ring root for ring ${ringIndex} yet. The subscriber chain has not synced it`,
      );
    }
    const latest = ringRoots[ringRoots.length - 1];

    const members = encodeMemberKeys(
      ringKeyEntries
        .map((entry: { keyArgs: unknown[]; value: unknown[] }) => ({
          page: Number(entry.keyArgs[2]),
          keys: [...entry.value].map(chainBytes),
        }))
        .sort((a: { page: number }, b: { page: number }) => a.page - b.page)
        .flatMap(({ keys }: { keys: Uint8Array[] }) => keys),
    );

    const ringExponent = Number(
      String(exponent.type).replace('R2e', ''),
    ) as unknown as Parameters<typeof one_shot>[0];
    const proof = one_shot(
      ringExponent,
      entropy,
      members,
      context,
      request.message,
    ) as { proof: Uint8Array; alias: unknown };

    // Free pre-flight. A proof built against a revision that already fell out
    // of the RingRoots window fails here rather than in the product flow.
    validate_with_commitment(
      ringExponent,
      proof.proof,
      chainBytes(latest.root),
      context,
      request.message,
    );

    return {
      proof: proof.proof,
      context,
      alias: chainBytes(proof.alias),
      ringIndex,
      ringRevision: Number(latest.revision),
    };
  } finally {
    peopleClient.destroy();
    ringRootsClient.destroy();
  }
}
