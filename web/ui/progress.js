// Progress for long operations (cloud runner, PC update, repo clone, push): an always-moving bar,
// active step, elapsed time, and estimated time left — so it's clear the process is running, not stuck.
//
// Steps are driven by the caller from real signals (codespace state, runner reports, RPC replies). Within
// a step the bar follows its estimated duration and slows near the end, so it never looks "done" before
// the step really is. Each step's duration is learned from earlier runs on this phone (localStorage),
// so estimates get better over time.
import { store } from '../conn.js';
import { h, ic } from './dom.js';
import { fmtClock, fmtLeft, learn, overall, remaining } from '../eta.js';

/**
 * @param {string} flow key for learned durations, e.g. 'cloud-create'
 * @param {{ id: string, label: string, est: number }[]} steps est = estimated seconds
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
    time.textContent = `${fmtClock(elapsed)} · ${inStep > e * 1.3 && left < 5 ? 'almost there…' : fmtLeft(left)}`;
    // Far past the estimate: keep looking alive, with an honest note.
    el.classList.toggle('slow', inStep > e * 2 + 20);
  };
  const paint = () => {
    label.textContent = finished ? 'Done' : steps[cur].label;
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
    /** Move to step `id` (earlier steps count as done). The same or an earlier step is ignored. */
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
    // Done: each step's real duration is recorded (moving average) for the next estimate.
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
