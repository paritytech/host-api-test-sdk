/**
 * Minimal @parity/truapi 0.4 product page for integration tests.
 *
 * Boots through `@parity/truapi/sandbox`: posts `truapi-ready` to the parent
 * window and waits for a `truapi-init` message carrying a transferred
 * MessagePort. All protocol traffic then flows over that port — nothing is
 * exchanged over direct window postMessage.
 *
 * Exercises a localStorage roundtrip and a product-account fetch, and writes
 * the results into the DOM for the Playwright spec to read back.
 */

import { getClientSync } from '@parity/truapi/sandbox';

const DOTNS_ID = 'test-product.dot';
// "hello" as hex — valid UTF-8 so the host's text-based storage roundtrips it exactly.
const STORAGE_VALUE = '0x68656c6c6f' as const;

function setResult(id: string, value: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.setAttribute('data-ready', 'true');
}

async function main(): Promise<void> {
  const client = getClientSync();
  if (!client) {
    setResult('status', 'no-host');
    return;
  }
  setResult('status', 'client-created');

  const written = await client.localStorage.write({
    key: 'truapi-e2e',
    value: STORAGE_VALUE,
  });
  if (written.isErr()) {
    setResult('storage', `write-error:${JSON.stringify(written.error)}`);
    return;
  }
  const read = await client.localStorage.read({ key: 'truapi-e2e' });
  if (read.isErr()) {
    setResult('storage', `read-error:${JSON.stringify(read.error)}`);
  } else {
    setResult('storage', `ok:${read.value.value ?? 'missing'}`);
  }

  const account = await client.account.getAccount({
    productAccountId: { dotNsIdentifier: DOTNS_ID, derivationIndex: 0 },
  });
  if (account.isErr()) {
    setResult('account', `error:${JSON.stringify(account.error)}`);
  } else {
    setResult('account', account.value.account.publicKey);
  }
}

main().catch((err) => {
  setResult('status', `boot-error:${err instanceof Error ? err.message : String(err)}`);
});
