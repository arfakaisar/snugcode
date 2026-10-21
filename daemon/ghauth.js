// The daemon's GitHub login status + re-login from the phone/terminal.
//
// OAuth App tokens don't expire, but can be revoked (from GitHub settings,
// "Revoke all user tokens", unused for a year, or detected as leaked).
// The daemon checks the token periodically; if it's no longer valid, the phone & terminal
// are told and can start a device flow — the code is shown on their screens.
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
    if (state !== 'ok') this.d.log(`! GitHub: ${state === 'missing' ? 'not signed in' : 'token no longer valid'} — sign in again from the phone, /login in the terminal, or \`snugcode login\`.`);
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
      // Network trouble: status unchanged.
    }
    return this.status();
  }

  markInvalid() {
    if (this.state !== 'invalid') this.set('invalid');
  }

  // Start a device flow (or reuse a code that's still valid).
  async begin() {
    if (!GITHUB_CLIENT_ID) throw new Error('GITHUB_CLIENT_ID is not set in snugcode.');
    if (this.pending && Date.now() < this.pending.expiresAt - 30000 && !this.pending.error) return this.status();
    const start = await deviceFlowStart(GITHUB_CLIENT_ID);
    const pending = { code: start.user_code, uri: start.verification_uri, expiresAt: Date.now() + (start.expires_in || 900) * 1000 };
    this.pending = pending;
    this.emit('change', this.status());
    deviceFlowWait(GITHUB_CLIENT_ID, start)
      .then(async (token) => {
        const me = await gh(token, 'GET', '/user');
        // secrets are shared with SessionManager & RPC: the new token applies immediately, no restart.
        this.d.secrets.githubToken = token;
        this.d.saveSecrets();
        this.d.config.githubLogin = me.login;
        this.d.config.githubId = me.id;
        saveConfig(this.d.config);
        this.login = me.login;
        if (this.pending === pending) this.pending = null;
        this.d.log(`✓ GitHub signed in again: @${me.login}`);
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
