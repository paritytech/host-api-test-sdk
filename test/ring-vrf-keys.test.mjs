import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullPersonRingVrfEntropy } from '../dist/ring-vrf-keys.js';

// Ground truth is host-rust-core, which every host runs. The vector is copied
// verbatim from its pinned person_ring_vrf_entropy_matches_ios_vectors test
// in host_logic/product_account.rs, and it exercises the whole chain: the
// keyed root hash, the SCALE junction chain code, and the derivation index
// magic. A drift anywhere derives a member key that belongs to nobody, and
// this assertion fails instead.
test('full-person member entropy matches the host derivation vector', () => {
  const entropy = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  assert.equal(
    Buffer.from(fullPersonRingVrfEntropy(entropy, 'dot')).toString('hex'),
    'c47086f94a7f4c05b7afd9f2339d3fea168f3823b5424ba1f7b31043d8ef60af',
  );
});
