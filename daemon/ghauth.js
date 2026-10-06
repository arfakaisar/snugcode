// Status login GitHub milik daemon + login ulang dari HP/terminal.
//
// Token OAuth App tidak kedaluwarsa, tapi bisa dicabut (dari pengaturan GitHub,
// "Revoke all user tokens", tidak dipakai setahun, atau terdeteksi bocor).
// Daemon mengecek token secara berkala; bila tidak berlaku, HP & terminal
// diberi tahu dan bisa memulai device flow — kodenya tampil di layar mereka.
import { EventEmitter } from 'node:events';
import { gh, deviceFlowStart, deviceFlowWait, TOKEN_INVALID } from './github.js';
import { saveConfig } from './config.js';
import { GITHUB_CLIENT_ID } from './defaults.js';

const CHECK_EVERY = 6 * 60 * 60 * 1000;

export class GithubAuth extends EventEmitter {
  constructor(daemon) {
    super();
    this.d = daemon;
    this.state = daemon.secrets.githubToken ? 'unknown' : 'missing'; // ok | invalid | missing | unknown
    this.login = daemon.config.githubLogin || null;
    this.pending = null; // { code, uri, expiresAt, error? }
  }

  status() {
    const p = this.pending && Date.now() < this.pending.expiresAt ? this.pending : null;
    return { state: this.state, login: this.login, pending: p && { code: p.code, uri: p.uri, expiresAt: p.expiresAt, error: p.error || null } };
  }

  set(state) {
    if (state === this.state) return;
    this.state = state;
    if (state !== 'ok') this.d.log(`! GitHub: ${state === 'missing' ? 'belum login' : 'token tidak berlaku'} — login ulang dari HP, /login di terminal, atau \`pocketcode login\`.`);
    this.emit('change', this.status());
  }

  startChecks() {
    setTimeout(() => this.check(), 3000);
    this.timer = setInterval(() => this.check(), CHECK_EVERY);
    this.timer.unref?.();
  }

  async check() {
    const token = this.d.secrets.githubToken;
    if (!token) {
      this.set('missing');
      return this.status();
    }
    try {
      const me = await gh(token, 'GET', '/user');
      this.login = me.login;
      this.set('ok');
    } catch (e) {
      if (e.message === TOKEN_INVALID) this.set('invalid');
      // Gangguan jaringan: status tidak diubah.
    }
    return this.status();
  }

  markInvalid() {
    if (this.state !== 'invalid') this.set('invalid');
  }

  // Mulai device flow (atau pakai ulang kode yang masih berlaku).
  async begin() {
    if (!GITHUB_CLIENT_ID) throw new Error('GITHUB_CLIENT_ID belum diatur di pocketcode.');
    if (this.pending && Date.now() < this.pending.expiresAt - 30000 && !this.pending.error) return this.status();
    const start = await deviceFlowStart(GITHUB_CLIENT_ID);
    const pending = { code: start.user_code, uri: start.verification_uri, expiresAt: Date.now() + (start.expires_in || 900) * 1000 };
    this.pending = pending;
    this.emit('change', this.status());
    deviceFlowWait(GITHUB_CLIENT_ID, start)
      .then(async (token) => {
        const me = await gh(token, 'GET', '/user');
        // secrets dipakai bersama SessionManager & RPC: token baru langsung berlaku, tanpa restart.
        this.d.secrets.githubToken = token;
        this.d.saveSecrets();
        this.d.config.githubLogin = me.login;
        this.d.config.githubId = me.id;
        saveConfig(this.d.config);
        this.login = me.login;
        if (this.pending === pending) this.pending = null;
        this.d.log(`✓ GitHub login ulang: @${me.login}`);
        this.state = 'ok';
        this.emit('change', this.status());
      })
      .catch((e) => {
        if (this.pending !== pending) return;
        pending.error = e.message;
        this.emit('change', this.status());
      });
    return this.status();
  }
}
