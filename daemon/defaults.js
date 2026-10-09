// Nilai bawaan yang dibagikan ke semua teman. Bisa ditimpa lewat env SNUGCODE_* (POCKETCODE_* lama tetap dibaca).
const env = (k) => process.env['SNUGCODE_' + k] || process.env['POCKETCODE_' + k];
// URL relay tetap nama worker lama: mengganti nama worker berarti worker & database baru (akun dan PC
// tertaut hilang, callback OAuth GitHub harus diubah). Lihat README → Migrasi dari pocketcode.
export const DEFAULT_RELAY_URL = env('RELAY') || 'https://pocketcode-relay.arfak.workers.dev';
export const GITHUB_CLIENT_ID = env('GITHUB_CLIENT_ID') || 'Ov23li0XcnRmm4PTofH2';
export const DEFAULT_ROUTER_URL = env('ROUTER') || 'https://router.gemz.space/v1';
export const PACKAGE_SPEC = env('PACKAGE') || 'github:arfakaisar/snugcode';
