/**
 * Synthetic genesis marking the connection the in-page loopback store answers.
 * Distinct from the all-zero hash, which declares an absent chain.
 */
export const PEOPLE_GENESIS_HASH = new Uint8Array(32).fill(1);

/** All-zero hash — declares a chain this host deliberately does not have. */
export const ZERO_HASH = new Uint8Array(32);
