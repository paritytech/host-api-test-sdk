import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_ACCOUNTS } from './accounts.js';
import type { Account, NetworkConfig, FaultConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let bundleCache: string | null = null;

function getBundleScript(): string {
  if (!bundleCache) {
    bundleCache = readFileSync(join(__dirname, 'host-bundle.js'), 'utf-8');
  }
  return bundleCache;
}

interface HostPageConfig {
  productUrl: string;
  accounts: Account[];
  networks: NetworkConfig[];
  productAccounts?: Record<string, Account>;
  faults?: FaultConfig;
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

  // Resolve productAccounts map values to { name, uri }
  let productAccountConfigs: Record<string, { name: string; uri: string }> | undefined;
  if (config.productAccounts) {
    productAccountConfigs = {};
    for (const [key, value] of Object.entries(config.productAccounts)) {
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
    })),
    ...(productAccountConfigs && { productAccounts: productAccountConfigs }),
    ...(config.faults && { faults: config.faults }),
  });

  const bundleScript = getBundleScript();

  // Escape closing script tags to prevent breaking out of inline script
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
  <script>${bundleScript}</script>
</body>
</html>`;
}
