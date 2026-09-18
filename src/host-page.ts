import { DEV_ACCOUNTS } from './accounts.js';
import type { Account, NetworkConfig, ProductExecutionKind } from './types.js';

interface HostPageConfig {
  productUrl: string;
  accounts: Account[];
  networks: NetworkConfig[];
  productAccounts?: Record<string, Account>;
  /** Omitted means the browser runtime's own default, `'App'`. */
  executionKind?: ProductExecutionKind;
}

function resolveAccount(entry: Account): { name: string; uri: string } {
  if (typeof entry === 'string') {
    const info = DEV_ACCOUNTS[entry];
    return { name: info.name, uri: info.uri };
  }
  return { name: entry.name, uri: entry.uri };
}

export function generateHostPage(config: HostPageConfig): string {
  const { productUrl, accounts, networks } = config;

  const accountConfigs = accounts.map(resolveAccount);

  let productAccountConfigs: Record<string, { name: string; uri: string }> | undefined;
  if (config.productAccounts) {
    productAccountConfigs = {};
    for (const [key, value] of Object.entries(config.productAccounts)) {
      // A per-index key cannot move an address — the core never asks the host
      // for an indexed account — so it is refused rather than silently ignored.
      if (key.includes('/')) {
        throw new Error(
          `productAccounts keys are product identifiers, not "dotnsId/index": ` +
            `use "${key.split('/')[0]}" to move the whole product subtree. ` +
            `The core derives every indexed account from that subtree itself.`,
        );
      }
      productAccountConfigs[key] = resolveAccount(value);
    }
  }

  const configJson = JSON.stringify({
    productUrl,
    accounts: accountConfigs,
    networks: networks.map((n) => ({
      genesisHash: n.genesisHash,
      rpcUrl: n.rpcUrl,
      name: n.name,
      ...(n.chain && { chain: n.chain }),
    })),
    ...(productAccountConfigs && { productAccounts: productAccountConfigs }),
    // The browser runtime owns the default, so it is not repeated here.
    ...(config.executionKind && { executionKind: config.executionKind }),
  });

  // Otherwise the product URL could break out of the inline script.
  const safeConfigJson = configJson.replace(/<\//g, '<\\/');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Test Host</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    iframe { width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe id="product-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" allow="clipboard-read; clipboard-write"></iframe>
  <script>window.__TEST_HOST_CONFIG__ = ${safeConfigJson};</script>
  <script type="module" src="/host-runtime.js"></script>
</body>
</html>`;
}
