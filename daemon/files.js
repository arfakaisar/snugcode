// File explorer & per-hunk diff review from the phone: list folders, read/write files in the session folder, and
// revert a single hunk (or file) of changes. Client paths are always relative to the session folder;
// symlinks leaving the session folder and the snugcode data folder are rejected.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isInside, isSensitivePath } from './permissions.js';
import { git, worktreeDiff } from './github.js';

export const MAX_TEXT = 1024 * 1024; // text files that can be opened & edited
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif' };

export const hashText = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const posix = (p) => p.split(path.sep).join('/');

// Client relative path → absolute (realpath'd) path inside the session folder.
export function resolveIn(cwd, rel = '') {
  if (typeof rel !== 'string' || rel.length > 4096 || rel.includes('\0')) throw new Error('Invalid path');
  const root = fs.realpathSync(cwd);
  const abs = path.resolve(root, rel.replace(/^[\\/]+/, ''));
  if (!isInside(abs, root)) throw new Error('Path is outside the session folder');
  // New file/folder: the nearest existing ancestor must be inside the session folder.
  let base = abs;
  while (!fs.existsSync(base) && base !== root) base = path.dirname(base);
  const real = path.join(fs.realpathSync(base), path.relative(base, abs));
  if (!isInside(real, root)) throw new Error('Path points outside the session folder');
  if (isSensitivePath(real) || isSensitivePath(abs)) throw new Error('The snugcode data folder can\'t be opened from here');
  return { root, abs: real, rel: posix(path.relative(root, real)) };
}

export function listDir(cwd, rel = '') {
  const { abs, rel: r, root } = resolveIn(cwd, rel);
  if (!fs.existsSync(abs)) throw new Error('Folder not found');
  const ents = fs.readdirSync(abs, { withFileTypes: true });
  const out = [];
  for (const e of ents) {
    if (e.name === '.git') continue;
    const p = path.join(abs, e.name);
    if (isSensitivePath(p)) continue;
    let dir = e.isDirectory();
    let size = 0;
    let link = false;
    if (e.isSymbolicLink()) {
      link = true;
      try {
        const st = fs.statSync(p);
        dir = st.isDirectory();
        size = st.size;
        if (!isInside(fs.realpathSync(p), root)) continue; // symlink leaving the session folder: can't be opened
      } catch {
        continue;
      }
    } else if (!dir) {
      try {
        size = fs.statSync(p).size;
      } catch {}
    }
    out.push({ name: e.name, dir, size, ...(link ? { link } : {}) });
  }
  out.sort((a, b) => +b.dir - +a.dir || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: r, entries: out.slice(0, MAX_ENTRIES), more: out.length > MAX_ENTRIES };
}

/** @typedef {{ path: string, size: number, mtime: number, text?: string, hash?: string, truncated?: boolean, binary?: boolean, image?: { mime: string, data: string } }} FileInfo */
// Text (max 1 MB, larger is truncated & read-only), small images as base64, binaries: info only.
/** @returns {FileInfo} */
export function readFile(cwd, rel) {
  const { abs, rel: r } = resolveIn(cwd, rel);
  if (!fs.existsSync(abs)) throw new Error('File not found');
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('This is a folder');
  const ext = path.extname(abs).toLowerCase();
  const base = { path: r, size: st.size, mtime: st.mtimeMs };
  if (IMAGES[ext]) {
    if (st.size > MAX_IMAGE) return { ...base, binary: true };
    return { ...base, image: { mime: IMAGES[ext], data: fs.readFileSync(abs).toString('base64') } };
  }
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_TEXT));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const data = buf.subarray(0, n);
    if (data.subarray(0, 8000).includes(0)) return { ...base, binary: true };
    const truncated = st.size > MAX_TEXT;
    return { ...base, text: data.toString('utf8'), truncated, ...(truncated ? {} : { hash: hashText(data) }) };
  } finally {
    fs.closeSync(fd);
  }
}

// Save an edit from the phone. `hash` = content hash when opened: if the file has changed since then (e.g. by the agent),
// the save is rejected so nobody's changes are silently overwritten.
/** @param {string} cwd @param {string} rel @param {string} text @param {{ hash?: string, create?: boolean }} [opts] */
export function writeFile(cwd, rel, text, { hash, create = false } = {}) {
  if (typeof text !== 'string') throw new Error('Invalid file content');
  if (Buffer.byteLength(text) > MAX_TEXT) throw new Error('File too large to edit from the phone (max 1 MB)');
  const { abs, rel: r } = resolveIn(cwd, rel);
  if (r.split('/').some((x) => x.toLowerCase() === '.git')) throw new Error('.git contents can\'t be edited from here');
  const exists = fs.existsSync(abs);
  if (exists) {
    if (create) throw new Error('File already exists');
    if (fs.statSync(abs).isDirectory()) throw new Error('This is a folder');
    if (hash && hashText(fs.readFileSync(abs)) !== hash) throw new Error('The file changed on the PC (maybe by the agent). Reopen it and edit again.');
  } else if (!create) throw new Error('File no longer exists');
  else fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return { path: r, hash: hashText(Buffer.from(text)), size: Buffer.byteLength(text) };
}

// ---------- review diff per hunk ----------
// One file from `git diff`: header (diff --git, index, ---, +++) + hunk list (@@ … up to the next hunk).
export function splitPatch(patch) {
  const lines = patch.replace(/\n$/, '').split('\n');
  const header = [];
  const hunks = [];
  for (const l of lines) {
    if (l.startsWith('@@')) hunks.push([l]);
    else if (hunks.length) hunks.at(-1).push(l);
    else header.push(l);
  }
  return { header, hunks: hunks.map((h) => h.join('\n')) };
}

function applyReverse(cwd, patch) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['-c', 'core.quotepath=off', 'apply', '-R', '--whitespace=nowarn', '-'], { cwd, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Hunk can\'t be reverted: ' + (err.trim() || 'exit ' + code)))));
    p.stdin.end(patch);
  });
}

// Revert one file's changes against HEAD (empty `hunk`) or a single hunk. The client sends the hunk
// as-is from the diff it saw; if that file's diff has changed since, the hunk isn't found and is rejected.
export async function revertChange(cwd, rel, hunk) {
  const { root, rel: r } = resolveIn(cwd, rel);
  if (!r) throw new Error('Invalid path');
  // The same diff the phone showed (worktreeDiff: snapshot through a temporary index, the user's index untouched).
  const patch = await worktreeDiff(root, [r]);
  if (!patch.trim()) throw new Error('This file has no changes');
  const { header, hunks } = splitPatch(patch);
  const isNew = header.some((l) => l.startsWith('new file mode'));
  if (hunk) {
    const want = String(hunk).replace(/\n$/, '');
    const i = hunks.indexOf(want);
    if (i < 0) throw new Error('This file\'s diff has changed. Reload the diff and try again.');
    // The only hunk = the whole file's change: same as reverting the file.
    if (hunks.length > 1 || !isNew) {
      await applyReverse(root, [...header, want].join('\n') + '\n');
      return { path: r, hunks: hunks.length - 1 };
    }
  }
  if (isNew) {
    fs.rmSync(path.join(root, r), { force: true });
    await git(root, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', r]).catch(() => {});
  } else await git(root, ['checkout', 'HEAD', '--', r]);
  return { path: r, hunks: 0 };
}
