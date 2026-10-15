// Progress untuk proses lama (runner cloud, pembaruan PC, clone repo, push): bar yang terus bergerak,
// tahap aktif, waktu berjalan, dan perkiraan sisa — supaya jelas prosesnya berjalan, bukan macet.
//
// Tahap ditentukan pemanggil dari sinyal nyata (status codespace, laporan runner, balasan RPC). Di dalam
// satu tahap bar maju mengikuti perkiraan durasinya dan melambat mendekati akhir, jadi tidak pernah
// "selesai" sebelum tahapnya benar-benar selesai. Durasi tiap tahap dipelajari dari proses sebelumnya
// di HP ini (localStorage), sehingga perkiraan makin tepat.
import { store } from '../conn.js';
import { h, ic } from './dom.js';
import { fmtClock, fmtLeft, learn, overall, remaining } from '../eta.js';

/**
 * @param {string} flow kunci untuk durasi yang dipelajari, mis. 'cloud-create'
 * @param {{ id: string, label: string, est: number }[]} steps est = perkiraan detik
 * @param {{ now?: () => number }} [opts]
 */
export function progress(flow, steps, { now = () => Date.now() } = {}) {
  const learned = store.get('eta.' + flow) || {};
  const est = Object.fromEntries(steps.map((s) => [s.id, Math.max(1, learned[s.id] ?? s.est)]));
  const ests = steps.map((s) => est[s.id]);
  const t0 = now();
  let cur = 0;
  let stepAt = t0;
  let finished = false;
  let failed = false;
  const took = {};

  const fill = h('i');
  const bar = h('div', { class: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const label = h('b', { class: 'plabel' });
  const time = h('span', { class: 'ptime' });
  const detail = h('div', { class: 'pdetail' });
  const items = steps.map((s) => h('li', {}, h('span', { class: 'pi' }), h('span', {}, s.label)));
  const el = h('div', { class: 'prog' }, h('div', { class: 'ptop' }, label, time), bar, detail, h('ol', { class: 'psteps' }, ...items));

  const pct = () => (finished ? 100 : overall(ests, cur, (now() - stepAt) / 1000));
  const render = () => {
    const p = pct();
    fill.style.width = p.toFixed(1) + '%';
    bar.setAttribute('aria-valuenow', String(Math.round(p)));
    const elapsed = (now() - t0) / 1000;
    if (finished) return (time.textContent = fmtClock(elapsed));
    const e = ests[cur];
    const inStep = (now() - stepAt) / 1000;
    const left = remaining(ests, cur, inStep);
    time.textContent = `${fmtClock(elapsed)} · ${inStep > e * 1.3 && left < 5 ? 'sebentar lagi…' : fmtLeft(left)}`;
    // Jauh melewati perkiraan: tetap terlihat hidup, dengan keterangan jujur.
    el.classList.toggle('slow', inStep > e * 2 + 20);
  };
  const paint = () => {
    label.textContent = finished ? 'Selesai' : steps[cur].label;
    items.forEach((li, i) => {
      li.className = finished || i < cur ? 'done' : i === cur ? 'now' : '';
      li.firstChild.replaceChildren(finished || i < cur ? ic('check') : i === cur ? h('span', { class: 'spinner' }) : '');
    });
    render();
  };
  const timer = setInterval(render, 500);
  paint();

  return {
    el,
    /** Pindah ke tahap `id` (tahap sebelumnya dianggap selesai). Tahap yang sama/sebelumnya diabaikan. */
    step(id, text) {
      const i = steps.findIndex((s) => s.id === id);
      if (finished || failed || i < 0) return;
      if (i > cur) {
        took[steps[cur].id] = (now() - stepAt) / 1000;
        cur = i;
        stepAt = now();
        paint();
      }
      if (text != null) detail.textContent = text;
    },
    note(text) {
      detail.textContent = text || '';
    },
    // Selesai: durasi nyata tiap tahap dicatat (rata-rata bergerak) untuk perkiraan berikutnya.
    done(text) {
      if (finished) return;
      took[steps[cur].id] = (now() - stepAt) / 1000;
      finished = true;
      clearInterval(timer);
      store.set('eta.' + flow, learn(learned, took));
      if (text != null) detail.textContent = text;
      el.classList.add('ok');
      paint();
    },
    fail(text) {
      failed = true;
      clearInterval(timer);
      el.classList.add('bad');
      items[cur]?.firstChild.replaceChildren(ic('x'));
      if (text != null) detail.textContent = text;
    },
    stop: () => clearInterval(timer),
  };
}
