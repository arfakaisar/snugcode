// File explorer & review diff per hunk dari HP: daftar folder, baca/tulis file di folder sesi, dan
// membatalkan satu hunk (atau satu file) perubahan. Path dari klien selalu relatif ke folder sesi;
// symlink yang keluar dari folder sesi dan folder data snugcode ditolak.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isInside, isSensitivePath } from './permissions.js';
import { git } from './github.js';

export const MAX_TEXT = 1024 * 1024; // file teks yang bisa dibuka & diedit
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif' };

export const hashText = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const posix = (p) => p.split(path.sep).join('/');

// Path relatif klien → path absolut (sudah di-realpath) di dalam folder sesi.
export function resolveIn(cwd, rel = '') {
  if (typeof rel !== 'string' || rel.length > 4096 || rel.includes('\0')) throw new Error('Path tidak valid');
  const root = fs.realpathSync(cwd);
  const abs = path.resolve(root, rel.replace(/^[\\/]+/, ''));
  if (!isInside(abs, root)) throw new Error('Path di luar folder sesi');
  // File/folder baru: leluhur terdekat yang sudah ada yang harus berada di dalam folder sesi.
  let base = abs;
  while (!fs.existsSync(base) && base !== root) base = path.dirname(base);
  const real = path.join(fs.realpathSync(base), path.relative(base, abs));
  if (!isInside(real, root)) throw new Error('Path mengarah ke luar folder sesi');
  if (isSensitivePath(real) || isSensitivePath(abs)) throw new Error('Folder data snugcode tidak bisa dibuka dari sini');
  return { root, abs: real, rel: posix(path.relative(root, real)) };
}

export function listDir(cwd, rel = '') {
  const { abs, rel: r, root } = resolveIn(cwd, rel);
  if (!fs.existsSync(abs)) throw new Error('Folder tidak ditemukan');
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
        if (!isInside(fs.realpathSync(p), root)) continue; // symlink keluar folder sesi: tidak bisa dibuka
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
// Teks (maks 1 MB, lebih besar dipotong & tidak bisa diedit), gambar kecil sebagai base64, biner: info saja.
/** @returns {FileInfo} */
export function readFile(cwd, rel) {
  const { abs, rel: r } = resolveIn(cwd, rel);
  if (!fs.existsSync(abs)) throw new Error('File tidak ditemukan');
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('Ini folder');
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

// Simpan editan dari HP. `hash` = hash isi saat dibuka: bila file sudah diubah (mis. oleh agen)
// sejak itu, penyimpanan ditolak agar perubahan siapa pun tidak tertimpa diam-diam.
/** @param {string} cwd @param {string} rel @param {string} text @param {{ hash?: string, create?: boolean }} [opts] */
export function writeFile(cwd, rel, text, { hash, create = false } = {}) {
  if (typeof text !== 'string') throw new Error('Isi file tidak valid');
  if (Buffer.byteLength(text) > MAX_TEXT) throw new Error('File terlalu besar untuk diedit dari HP (maks 1 MB)');
  const { abs, rel: r } = resolveIn(cwd, rel);
  if (r.split('/').some((x) => x.toLowerCase() === '.git')) throw new Error('Isi .git tidak bisa diedit dari sini');
  const exists = fs.existsSync(abs);
  if (exists) {
    if (create) throw new Error('File sudah ada');
    if (fs.statSync(abs).isDirectory()) throw new Error('Ini folder');
    if (hash && hashText(fs.readFileSync(abs)) !== hash) throw new Error('File sudah berubah di PC (mungkin oleh agen). Buka ulang lalu edit lagi.');
  } else if (!create) throw new Error('File sudah tidak ada');
  else fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return { path: r, hash: hashText(Buffer.from(text)), size: Buffer.byteLength(text) };
}

// ---------- review diff per hunk ----------
// Satu file dari `git diff`: header (diff --git, index, ---, +++) + daftar hunk (@@ … sampai hunk berikutnya).
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
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Hunk tidak bisa dibatalkan: ' + (err.trim() || 'exit ' + code)))));
    p.stdin.end(patch);
  });
}

// Batalkan perubahan satu file terhadap HEAD (`hunk` kosong) atau satu hunk saja. Hunk dikirim klien
// apa adanya dari diff yang ia lihat; bila diff file itu sudah berubah, hunk tidak ditemukan dan ditolak.
export async function revertChange(cwd, rel, hunk) {
  const { root, rel: r } = resolveIn(cwd, rel);
  if (!r) throw new Error('Path tidak valid');
  await git(root, ['add', '-N', '--', r]).catch(() => {});
  const patch = await git(root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--', r]);
  if (!patch.trim()) throw new Error('File ini tidak punya perubahan');
  const { header, hunks } = splitPatch(patch);
  const isNew = header.some((l) => l.startsWith('new file mode'));
  if (hunk) {
    const want = String(hunk).replace(/\n$/, '');
    const i = hunks.indexOf(want);
    if (i < 0) throw new Error('Diff file ini sudah berubah. Muat ulang diff lalu coba lagi.');
    // Satu-satunya hunk = seluruh perubahan file: sama dengan membatalkan file.
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
