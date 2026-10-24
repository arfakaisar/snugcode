// Defaults shared by everyone. Override with SNUGCODE_* env vars (legacy POCKETCODE_* is still read).
const env = (k) => process.env['SNUGCODE_' + k] || process.env['POCKETCODE_' + k];
// The public address (worker alias `snugcode`) forwards to the old relay worker, so PCs using the old
// URL stay connected to the same data. See README → Migrating from pocketcode.
export const DEFAULT_RELAY_URL = env('RELAY') || 'https://snugcode.dev';
export const GITHUB_CLIENT_ID = env('GITHUB_CLIENT_ID') || 'Ov23li0XcnRmm4PTofH2';
// No default router: a key snugcode doesn't recognize is never sent to an address the user didn't choose.
export const DEFAULT_ROUTER_URL = env('ROUTER') || '';
export const PACKAGE_SPEC = env('PACKAGE') || 'github:arfakaisar/snugcode';
