// Model picker with an effort slider and model health checks.
import * as M from '../../shared/models.js';
import { app } from './state.js';
import { busyButton, h, haptic, ic, isOldDaemon, loading, toast, ui } from './dom.js';

// ---------- Model picker + effort slider ----------
export const modelCache = { list: null, errors: [], at: 0, probes: new Map() };

export async function loadModels(fresh = false) {
  if (!fresh && modelCache.list && Date.now() - modelCache.at < 5 * 60 * 1000) return modelCache.list;
  let list;
  modelCache.errors = [];
  if (app.current?.info?.caps?.includes('modelsAll')) {
    // All connections at once; a failing connection is reported without failing the rest.
    const r = await app.conn.call('modelsAll', { fresh });
    list = r.models;
    modelCache.errors = r.errors || [];
  } else {
    try {
      list = await app.conn.call('modelsInfo', { fresh });
    } catch (e) {
      if (!isOldDaemon(e)) throw e;
      list = await app.conn.call('models'); // old daemon: IDs only
    }
  }
  modelCache.list = list;
  modelCache.at = Date.now();
  return list;
}

export function probeModel(id, retest = false) {
  if (retest) modelCache.probes.delete(id);
  if (!modelCache.probes.has(id)) {
    const p = app.conn.call('probeModel', { model: id }).catch((e) => ({ ok: null, err: isOldDaemon(e) ? 'Update snugcode on the PC to test models.' : e.message }));
    modelCache.probes.set(id, p);
    // Connection failures aren't cached; model results are cached for 5 minutes.
    p.then((r) => (r.ok === null ? modelCache.probes.delete(id) : setTimeout(() => modelCache.probes.delete(id), 5 * 60 * 1000)));
  }
  return modelCache.probes.get(id);
}

// Model picker sheet. onPick(id) is called when "Use" is tapped.
/** @param {{ title: string, current?: string, onPick: (id: string) => *, onBack?: () => void }} opts */
export async function pickModel({ title, current: cur, onPick, onBack }) {
  const q = h('input', { class: 'field', type: 'search', placeholder: 'Search models…', autocapitalize: 'off', autocomplete: 'off', enterkeyhint: 'search' });
  const list = h('div', { class: 'mlist' }, loading('Loading models…'));
  const probeLine = h('div', { class: 'probe' });
  const useBtn = h('button', { class: 'btn primary' }, 'Use');
  ui.sheet(ui.head(title, { back: onBack, sub: cur ? 'current: ' + M.modelLabel(cur) : '' }), h('div', { class: 'search' }, ic('search'), q), list, h('div', { class: 'sheetfoot' }, probeLine, useBtn));

  let groups;
  try {
    groups = M.groupModels(await loadModels());
  } catch (e) {
    return list.replaceChildren(h('div', { class: 'err' }, e.message));
  }
  const errs = modelCache.errors.map((e) => h('div', { class: 'err', style: 'display:flex;gap:8px' }, ic('alert'), `${e.conn}: ${e.err}`));
  if (!groups.length) {
    const add = app.current?.info?.caps?.includes('connAdd') ? h('button', { class: 'btn primary', style: 'margin-top:12px', onclick: async () => (await import('./settings.js')).connectionsSheet({ back: onBack }) }, ic('key'), 'Add an API key / sign in to ChatGPT') : null;
    return list.replaceChildren(...errs, h('div', { class: 'empty' }, 'No models available to the agent yet.'), add || '');
  }
  if (errs.length) list.before(...errs);
  // The model list can change at any time (dead models dropped, connections removed).
  const exact = cur ? M.findGroup(groups, cur) : null;
  const p = cur ? M.parseModelId(cur) : null;
  const sameGroup = !exact && p ? groups.find((g) => g.key === (p.conn !== 'router' ? `${p.conn}:${p.base}` : (p.provider ? p.provider + '/' : '') + p.base)) : null;
  if (cur && !exact)
    list.before(h('div', { class: 'err', style: 'display:flex;gap:8px' }, ic('alert'), sameGroup ? `Variant ${M.modelLabel(cur)} is no longer available. Pick another effort level.` : `${M.modelLabel(cur, { provider: true })} is no longer available. Pick another model.`));
  const g0 = exact || sameGroup || groups[0];
  const sel = { group: g0, effort: M.defaultChoice(g0, cur) };
  let probeTimer;
  let probeFor = null;

  const resolved = () => M.resolveId(sel.group, sel.effort);
  const update = () => {
    const id = resolved();
    useBtn.replaceChildren(id === cur ? '✓ In use' : 'Use ' + M.modelLabel(id));
    useBtn.disabled = id === cur;
    useBtn.className = 'btn primary';
    probeLine.replaceChildren(h('span', { class: 'spinner' }), h('span', { class: 'dim' }, 'testing ' + M.modelLabel(id) + '…'));
    clearTimeout(probeTimer);
    probeFor = id;
    probeTimer = setTimeout(async () => {
      const r = await probeModel(id);
      if (probeFor !== id) return;
      const retest = h('button', { class: 'linkbtn', onclick: () => (probeModel(id, true), update()) }, 'retest');
      if (r.ok) probeLine.replaceChildren(h('span', { class: 'ok' }, `✓ ready · ${(r.ms / 1000).toFixed(1)}s`), retest);
      else if (r.ok === null) probeLine.replaceChildren(h('span', { class: 'dim' }, r.err), retest);
      else {
        probeLine.replaceChildren(h('span', { class: 'e' }, '✗ ' + r.err), retest);
        if (id !== cur) {
          useBtn.replaceChildren('Use ' + M.modelLabel(id) + ' anyway');
          useBtn.className = 'btn warn';
        }
      }
    }, 450);
  };

  const effortPanel = (g) => {
    if (!g.slider) return null;
    const val = h('b', {}, '');
    const panel = h('div', { class: 'effort', onclick: (e) => e.stopPropagation() });
    const head = h('div', { class: 'row' }, h('span', { class: 'dim' }, 'effort'), val, h('span', { style: 'flex:1' }));
    let slider = null;
    let autoChip = null;
    let only = null;
    const ticks = [];
    if (g.auto) {
      autoChip = h('button', { class: 'effchip' }, 'auto');
      autoChip.onclick = () => {
        sel.effort = sel.effort === null ? g.levels[Math.floor((g.levels.length - 1) / 2)]?.effort ?? null : null;
        sync();
      };
      head.append(autoChip);
    }
    panel.append(head);
    if (g.levels.length >= 2) {
      slider = h('input', { type: 'range', min: '0', max: String(g.levels.length - 1), step: '1', 'aria-label': 'Effort level' });
      slider.oninput = () => {
        sel.effort = g.levels[+slider.value].effort;
        haptic(6);
        sync();
      };
      for (const l of g.levels) ticks.push(h('button', { onclick: () => ((sel.effort = l.effort), sync()) }, M.EFFORT_LABEL[l.effort] || l.effort));
      panel.append(slider, h('div', { class: 'ticks' }, ...ticks));
    } else if (g.levels.length === 1) {
      only = h('button', { class: 'effchip', style: 'margin-left:6px' }, M.EFFORT_LABEL[g.levels[0].effort]);
      only.onclick = () => ((sel.effort = g.levels[0].effort), sync());
      head.append(only);
    }
    panel.append(h('div', { class: 'hint' }, '← fast & cheap   ·   thinks deeper →'));
    const sync = () => {
      val.textContent = sel.effort === null ? 'auto' : M.EFFORT_LABEL[sel.effort] || sel.effort;
      if (slider) {
        const i = g.levels.findIndex((l) => l.effort === sel.effort);
        slider.disabled = sel.effort === null;
        if (i >= 0) slider.value = String(i);
        ticks.forEach((t, j) => t.classList.toggle('on', j === i));
      }
      autoChip?.classList.toggle('on', sel.effort === null);
      only?.classList.toggle('on', sel.effort !== null);
      update();
    };
    sync();
    return panel;
  };

  const render = () => {
    const term = q.value.trim().toLowerCase();
    const shown = groups.filter((g) => !term || g.key.toLowerCase().includes(term));
    const out = [];
    let lastProvider = null;
    for (const g of shown) {
      if (g.provider !== lastProvider) {
        lastProvider = g.provider;
        // Connection (Claude API, ChatGPT, OpenRouter, …) or a provider on the old router (cc/, ag/, …).
        const head = g.conn && g.conn !== 'router' ? (g.label || M.PROVIDER_LABEL[g.provider] || g.provider) : (M.PROVIDER_LABEL[g.provider] || g.provider || 'other') + (g.provider ? ` · ${g.provider}/` : '');
        out.push(h('div', { class: 'mprov' }, head));
      }
      const isSel = g === sel.group;
      const inUse = g.variants.some((v) => v.id === cur);
      const badges = [g.engine === 'codex' ? 'Codex' : g.engine === 'gemini' ? 'Gemini CLI' : null, g.ctx ? M.ctxLabel(g.ctx) + ' context' : null, g.slider ? `${g.levels.length + (g.auto ? 1 : 0)} effort levels` : g.fixed ? 'effort ' + (M.EFFORT_LABEL[g.fixed] || g.fixed) : null, g.vision ? 'images' : null].filter(Boolean);
      out.push(
        h('div', { class: 'model' + (isSel ? ' sel' : ''), role: 'button', tabindex: '0', onclick: () => {
          if (sel.group === g) return;
          haptic(8);
          sel.group = g;
          sel.effort = M.defaultChoice(g, cur);
          render();
          update();
        } },
          h('div', { class: 'row' }, h('span', { class: 'mname' }, g.name), inUse ? h('span', { class: 'tag on' }, 'in use') : null),
          h('div', { class: 'sub' }, badges.join(' · ')),
          isSel ? effortPanel(g) : null,
        ),
      );
    }
    list.replaceChildren(...(out.length ? out : [h('div', { class: 'empty' }, 'No matching models.')]));
  };
  q.oninput = render;
  useBtn.onclick = async () => {
    const done = busyButton(useBtn, 'Saving…');
    try {
      await onPick(resolved());
      haptic(15);
    } catch (e) {
      toast(e.message, true);
      done();
    }
  };
  render();
  update();
  requestAnimationFrame(() => list.querySelector('.model.sel')?.scrollIntoView({ block: 'center' }));
}
