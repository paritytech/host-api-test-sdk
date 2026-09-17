// src/browser/sso/statement.ts
/**
 * Statement-store `Statement` codec and sr25519 proof.
 *
 * A statement is a SCALE `Vec` of index-tagged fields, ordered by index. The
 * proof covers the encoded unsigned statement with its outer compact length
 * prefix removed — signing the prefixed form yields a statement the store
 * rejects.
 */
import { getPublicKey, sign } from '@scure/sr25519';
import { Bytes, Enum, Struct, Vector, u64 } from 'scale-ts';

const Bytes32 = Bytes(32);
const Bytes64 = Bytes(64);

/** Declaration order is the wire index — see the note above. */
const Field = Enum({
  proof: Enum({
    sr25519: Struct({ signature: Bytes64, signer: Bytes32 }),
    ed25519: Struct({ signature: Bytes64, signer: Bytes32 }),
    ecdsa: Struct({ signature: Bytes(65), signer: Bytes(33) }),
    onChain: Struct({ who: Bytes32, blockHash: Bytes32, event: u64 }),
  }),
  decryptionKey: Bytes32,
  expiry: u64,
  channel: Bytes32,
  topic1: Bytes32,
  topic2: Bytes32,
  topic3: Bytes32,
  topic4: Bytes32,
  data: Bytes(),
});

const StatementFields = Vector(Field);

export interface StatementProof {
  signature: Uint8Array;
  signer: Uint8Array;
}

export interface Statement {
  proof?: StatementProof;
  decryptionKey?: Uint8Array;
  expiry?: bigint;
  channel?: Uint8Array;
  topics?: Uint8Array[];
  data?: Uint8Array;
}

export type TopicFilterKind = 'MatchAll' | 'MatchAny';

const TOPIC_TAGS = ['topic1', 'topic2', 'topic3', 'topic4'] as const;

export function encodeStatement(statement: Statement): Uint8Array {
  const fields: Array<{ tag: string; value: unknown }> = [];

  if (statement.proof) {
    fields.push({ tag: 'proof', value: { tag: 'sr25519', value: statement.proof } });
  }
  if (statement.decryptionKey) {
    fields.push({ tag: 'decryptionKey', value: statement.decryptionKey });
  }
  if (statement.expiry !== undefined) {
    fields.push({ tag: 'expiry', value: statement.expiry });
  }
  if (statement.channel) {
    fields.push({ tag: 'channel', value: statement.channel });
  }
  const topics = statement.topics ?? [];
  if (topics.length > 4) {
    throw new Error(`max topics length is 4, received ${topics.length}`);
  }
  topics.forEach((topic, index) => {
    fields.push({ tag: TOPIC_TAGS[index], value: topic });
  });
  if (statement.data) {
    fields.push({ tag: 'data', value: statement.data });
  }

  return StatementFields.enc(fields as never);
}

export function decodeStatement(bytes: Uint8Array): Statement {
  const statement: Statement = {};
  for (const field of StatementFields.dec(bytes) as Array<{ tag: string; value: never }>) {
    if (field.tag === 'proof') {
      const proof = field.value as unknown as { tag: string; value: StatementProof };
      if (proof.tag !== 'sr25519') {
        throw new Error(`unsupported proof type: ${proof.tag}`);
      }
      statement.proof = proof.value;
    } else if (field.tag.startsWith('topic')) {
      (statement.topics ??= []).push(field.value);
    } else {
      (statement as Record<string, unknown>)[field.tag] = field.value;
    }
  }
  return statement;
}

/** Sign the unsigned form and return the statement with its proof attached. */
export function signStatement(secretKey: Uint8Array, statement: Statement): Statement {
  const { proof: _drop, ...unsigned } = statement;
  const encoded = encodeStatement(unsigned);
  const signature = sign(secretKey, stripCompactPrefix(encoded));
  return { ...statement, proof: { signature, signer: getPublicKey(secretKey) } };
}

/**
 * Length of a SCALE compact-encoded integer's prefix, in bytes.
 *
 * The big-integer mode (marker `0b11`) stores `byteCount - 4` in the upper
 * six bits of the mode byte, so the total prefix is the mode byte itself,
 * plus the implied 4, plus that remainder: `1 + 4 + (encoded[0] >> 2)`.
 */
export function stripCompactPrefix(encoded: Uint8Array): Uint8Array {
  const marker = encoded[0] & 0b11;
  const prefixLen = marker === 0 ? 1 : marker === 1 ? 2 : marker === 2 ? 4 : 5 + (encoded[0] >> 2);
  return encoded.subarray(prefixLen);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

export function matchesTopics(
  statement: Statement,
  kind: TopicFilterKind,
  topics: Uint8Array[],
): boolean {
  const present = statement.topics ?? [];
  const has = (topic: Uint8Array) => present.some((candidate) => sameBytes(candidate, topic));
  return kind === 'MatchAll' ? topics.every(has) : topics.some(has);
}
