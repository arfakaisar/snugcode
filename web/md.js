// Markdown ringan untuk teks agen (tanpa dependensi): paragraf, judul, list, tabel, kutipan,
// blok kode, dan inline (`kode`, **tebal**, *miring*, tautan). Semua teks di-escape dulu.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function inlineMd(s) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}

function codeBlock(code, lang, copyIcon) {
  return `<div class="code"><div class="ch"><span>${esc(lang || 'kode')}</span><button class="copybtn" data-copy>${copyIcon}<span>salin</span></button></div><pre><code>${esc(code)}</code></pre></div>`;
}

// `copyIcon`: HTML ikon tombol salin pada blok kode.
export function md(src, { copyIcon = '' } = {}) {
  const L = src.split('\n');
  const out = [];
  let i = 0;
  const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  while (i < L.length) {
    const l = L[i];
    const fence = l.match(/^\s*```\s*([\w+#.-]*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < L.length && !/^\s*```/.test(L[i])) buf.push(L[i++]);
      i++;
      out.push(codeBlock(buf.join('\n'), fence[1], copyIcon));
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    if (/^#{1,6}\s/.test(l)) {
      out.push(`<h3>${inlineMd(l.replace(/^#+\s+/, ''))}</h3>`);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(L[i + 1] || '')) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(l);
      i += 2;
      const rows = [];
      while (i < L.length && /^\s*\|.*\|\s*$/.test(L[i])) rows.push(row(L[i++]));
      out.push(`<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (isList(l)) {
      const ordered = /^\s*\d+[.)]/.test(l);
      const items = [];
      while (i < L.length && (isList(L[i]) || (/^\s{2,}\S/.test(L[i]) && items.length))) {
        if (isList(L[i])) items.push(L[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        else items[items.length - 1] += ' ' + L[i].trim();
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inlineMd(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      const q = [];
      while (i < L.length && /^>\s?/.test(L[i])) q.push(L[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inlineMd(q.join(' '))}</blockquote>`);
      continue;
    }
    const para = [];
    while (i < L.length && L[i].trim() && !/^\s*```/.test(L[i]) && !/^#{1,6}\s/.test(L[i]) && !isList(L[i]) && !/^>\s?/.test(L[i])) para.push(L[i++]);
    out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`);
  }
  return out.join('');
}

// Posisi akhir blok markdown yang sudah pasti selesai di `src`, dipindai mulai `from` (yang
// selalu berada di batas blok): sesudah baris kosong terakhir yang tidak di dalam blok kode.
// Teks yang masih di-stream sebelum posisi ini tidak akan berubah tampilannya lagi.
export function stableCut(src, from = 0) {
  let cut = from;
  let fence = false;
  let i = from;
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    if (nl < 0) break;
    const line = src.slice(i, nl);
    if (/^\s*```/.test(line)) fence = !fence;
    else if (!fence && !line.trim()) cut = nl + 1;
    i = nl + 1;
  }
  return cut;
}
