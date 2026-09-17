/**
 * Genesis hash identifying the in-page loopback statement store.
 *
 * The core opens its SSO channel by asking the host to connect to the People
 * chain. Nothing real is behind it here, so a fixed synthetic hash marks the
 * connection the loopback store answers — distinct from the all-zero hash,
 * which declares "this host has no such chain".
 */
export const PEOPLE_GENESIS_HASH = new Uint8Array(32).fill(1);

/** All-zero hash — declares a chain this host deliberately does not have. */
export const ZERO_HASH = new Uint8Array(32);
