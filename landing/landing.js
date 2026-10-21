// snugcode Cloud landing page interactions. No dependencies; animations are CSS (transform/opacity)
// triggered from here. Motion is reduced under prefers-reduced-motion; pointer-only effects are skipped on touch.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(pointer: fine)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- theme (shared with snugcode agent: pc.theme) ---------- */
const syncThemeColor = () => ($('meta[name=theme-color]').content = document.documentElement.dataset.theme === 'light' ? '#faf9f5' : '#262624');
syncThemeColor();
$('#themeBtn').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  localStorage.setItem('pc.theme', JSON.stringify(t));
  syncThemeColor();
});

/* ---------- account: snugcode agent buttons & sign-in modal ---------- */
// Same login token as snugcode agent (pc.token, same origin). boot.js already set .authed when a token exists;
// here it is checked against the relay so an expired/revoked token doesn't show the wrong buttons.
const root = document.documentElement;
const modal = $('#authModal');
const openModal = () => {
  closeMenu();
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('show'));
  $('.modal-card .btn-primary', modal).focus({ preventScroll: true });
};
const closeModal = () => {
  modal.classList.remove('show');
  setTimeout(() => (modal.hidden = true), reduced ? 0 : 300);
};
$$('[data-close]', modal).forEach((el) => el.addEventListener('click', closeModal));
addEventListener('keydown', (e) => e.key === 'Escape' && !modal.hidden && closeModal());
for (const a of $$('[data-agent]')) {
  a.addEventListener('click', (e) => {
    if (root.classList.contains('authed')) return;
    e.preventDefault();
    openModal();
  });
}
{
  let token = null;
  try { token = JSON.parse(localStorage.getItem('pc.token')); } catch {}
  if (token) {
    fetch('/api/me', { headers: { authorization: 'Bearer ' + token } })
      .then(async (r) => {
        if (r.status === 401) {
          localStorage.removeItem('pc.token');
          root.classList.remove('authed');
          return;
        }
        const { login } = r.ok ? await r.json() : {};
        if (!login) return;
        $('#meLogin').textContent = '@' + login;
        $('#meAv').textContent = login[0].toUpperCase();
      })
      .catch(() => {});
  }
}

/* ---------- nav: scrolled state, progress, active link, mobile menu ---------- */
const nav = $('#nav');
const prog = $('.progress span');
const links = $$('#navLinks a[href^="#"]');
const sections = links.map((a) => $(a.getAttribute('href')));
const burger = $('#burger');
const menu = $('#navLinks');
function setMenu(open) {
  burger.setAttribute('aria-expanded', String(open));
  menu.classList.toggle('open', open);
  root.classList.toggle('menu-open', open);
}
function closeMenu() { if (menu.classList.contains('open')) setMenu(false); }
burger.addEventListener('click', () => setMenu(!menu.classList.contains('open')));
$$('a', menu).forEach((a) => a.addEventListener('click', closeMenu));
addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
matchMedia('(min-width: 861px)').addEventListener('change', closeMenu);

/* ---------- word-by-word headings ---------- */
for (const el of $$('[data-split]')) {
  let i = 0;
  const walk = (node) => {
    for (const n of [...node.childNodes]) {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        for (const part of n.textContent.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.append(' '); continue; }
          const w = document.createElement('span');
          w.className = 'w';
          w.innerHTML = `<span style="--i:${i++}">${part}</span>`;
          frag.append(w);
        }
        n.replaceWith(frag);
      } else if (n.nodeType === 1) walk(n);
    }
  };
  walk(el);
}

/* ---------- reveal on scroll ---------- */
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}, { threshold: 0.08, rootMargin: '0px 0px -24px 0px' });
$$('[data-reveal], [data-split], .card').forEach((el) => io.observe(el));

/* ---------- counters ---------- */
const countIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    countIO.unobserve(e.target);
    const el = e.target, to = +el.dataset.count, dec = +(el.dataset.dec || 0), pre = el.dataset.prefix || '';
    const t0 = performance.now(), dur = reduced ? 1 : 1600;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur), v = to * (1 - Math.pow(1 - p, 4));
      el.textContent = pre + v.toFixed(dec);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}, { threshold: 0.6 });
$$('[data-count]').forEach((el) => countIO.observe(el));

/* ---------- scroll: progress, nav, parallax, steps line, mobile CTA bar ---------- */
const floats = $$('[data-parallax]');
const mCta = $('#mCta');
const heroEl = $('#hero'), ctaEl = $('.cta-wrap');
const mobile = matchMedia('(max-width: 860px)');
const steps = $('#steps');
const stepEls = $$('.step', steps);
let ticking = false;
const onScroll = () => {
  ticking = false;
  const y = scrollY, h = document.documentElement.scrollHeight - innerHeight;
  prog.style.setProperty('--p', h > 0 ? y / h : 0);
  nav.classList.toggle('scrolled', y > 20);
  let cur = -1;
  sections.forEach((s, i) => { if (s && s.getBoundingClientRect().top < innerHeight * 0.4) cur = i; });
  links.forEach((a, i) => a.classList.toggle('on', i === cur));
  if (!reduced && !mobile.matches) for (const f of floats) f.style.setProperty('--py', `${y * f.dataset.parallax * -1}px`);
  // Bottom action bar on phones: after the hero, hidden again near the closing CTA and footer.
  const showBar = heroEl.getBoundingClientRect().bottom < 0 && ctaEl.getBoundingClientRect().top > innerHeight * 0.9;
  mCta.classList.toggle('show', showBar);
  mCta.setAttribute('aria-hidden', String(!showBar));
  const r = steps.getBoundingClientRect();
  const sp = Math.min(1, Math.max(0, (innerHeight * 0.75 - r.top) / r.height));
  steps.style.setProperty('--sp', sp);
  stepEls.forEach((s, i) => s.classList.toggle('lit', sp >= (stepEls.length > 1 ? i / (stepEls.length - 1) : 0) * 0.92));
};
addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
onScroll();

/* ---------- pointer: hero glow, tilt, magnetic buttons, spotlight (mouse only) ---------- */
if (fine && !reduced) {
  const hero = $('#hero');
  hero.addEventListener('pointermove', (e) => {
    const r = hero.getBoundingClientRect();
    hero.style.setProperty('--cx', `${e.clientX - r.left}px`);
    hero.style.setProperty('--cy', `${e.clientY - r.top}px`);
  });
  for (const el of $$('[data-tilt]')) {
    const host = el.closest('.hero-visual, .deploy') || el;
    host.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty('--ry', `${x * 14}deg`);
      el.style.setProperty('--rx', `${y * -12}deg`);
    });
    host.addEventListener('pointerleave', () => { el.style.setProperty('--ry', '0deg'); el.style.setProperty('--rx', '0deg'); });
  }
  for (const b of $$('.mag')) {
    b.addEventListener('pointermove', (e) => {
      const r = b.getBoundingClientRect();
      b.style.setProperty('--mx', `${(e.clientX - r.left - r.width / 2) * 0.25}px`);
      b.style.setProperty('--my', `${(e.clientY - r.top - r.height / 2) * 0.35}px`);
    });
    b.addEventListener('pointerleave', () => { b.style.setProperty('--mx', '0px'); b.style.setProperty('--my', '0px'); });
  }
}
if (fine) for (const c of $$('.spot')) {
  c.addEventListener('pointermove', (e) => {
    const r = c.getBoundingClientRect();
    c.style.setProperty('--sx', `${e.clientX - r.left}px`);
    c.style.setProperty('--sy', `${e.clientY - r.top}px`);
  });
}

/* ---------- hero word rotator ---------- */
{
  const words = ['frontend', 'backend', 'API', 'database', 'Telegram bot', 'cron job'];
  const rot = $('#rotator');
  let i = 0;
  if (!reduced) setInterval(() => {
    const old = rot.firstElementChild;
    old.classList.add('out');
    setTimeout(() => old.remove(), 400);
    const n = document.createElement('span');
    n.textContent = words[i = (i + 1) % words.length];
    rot.append(n);
  }, 2200);
}

/* ---------- phone chat demo ---------- */
{
  const feed = $('#feed'), input = $('#phInput'), send = $('#phSend');
  const mascot = '<svg><use href="#mascot"/></svg>';
  const add = (cls, html) => {
    const m = document.createElement('div');
    m.className = 'msg ' + cls;
    m.innerHTML = html;
    feed.append(m);
    while (feed.children.length > 7) feed.firstElementChild.remove();
    return m;
  };
  const type = async (text) => {
    input.innerHTML = '<span class="t"></span><span class="cur"></span>';
    const t = $('.t', input);
    for (const ch of text) { t.textContent += ch; await sleep(reduced ? 0 : 28 + Math.random() * 40); }
    await sleep(300);
    send.classList.add('press');
    await sleep(180);
    send.classList.remove('press');
    input.innerHTML = '<span class="ph-ph">Ask the agent anything…</span>';
  };
  const tool = async (name, arg, ms) => {
    const m = add('tool', `<b>${name}</b> ${arg}<span class="sp"></span>`);
    await sleep(ms);
    $('.sp', m).outerHTML = '<span class="ok">✓</span>';
  };
  const scripts = [
    async () => {
      await type('Add a coffee menu page and deploy it');
      add('user', 'Add a coffee menu page and deploy it');
      await sleep(500);
      const th = add('ai', `${mascot}<span class="typing"><i></i><i></i><i></i></span>`);
      await sleep(1100); th.remove();
      await tool('Read', 'src/App.jsx', 700);
      await tool('Write', 'src/pages/Menu.jsx', 900);
      const p = add('perm', '<div class="pt">Allow Edit?</div><div class="dl d">- &lt;h2&gt;Menu&lt;/h2&gt;</div><div class="dl a">+ &lt;MenuGrid items={menu}/&gt;</div><div class="pb"><span>Deny</span><span>Always</span><span class="y">Allow</span></div>');
      await sleep(1400);
      $('.y', p).classList.add('tap');
      await sleep(600);
      await tool('Bash', 'npm run build', 1300);
      await tool('Deploy', 'coffee-shop', 1200);
      add('live', '<span class="dot-live"></span> coffee-shop.snug.run is live');
    },
    async () => {
      await type('Build a POST /orders endpoint with tests');
      add('user', 'Build a POST /orders endpoint with tests');
      await sleep(500);
      const th = add('ai', `${mascot}<span class="typing"><i></i><i></i><i></i></span>`);
      await sleep(1000); th.remove();
      add('ai', `${mascot}<span>On it! I'll add the route, validation and tests.</span>`);
      await sleep(600);
      await tool('Write', 'api/orders.ts', 900);
      await tool('Write', 'api/orders.test.ts', 800);
      await tool('Bash', 'npm test', 1500);
      add('ai', `${mascot}<span>12 tests passed ✓ The API is live at <b style="color:#f5f4ef">api.coffee-shop.snug.run</b></span>`);
    },
  ];
  (async () => {
    await sleep(1400);
    for (let k = 0; ; k++) {
      await scripts[k % scripts.length]();
      await sleep(3200);
      for (const m of [...feed.children]) { m.style.transition = 'opacity .4s'; m.style.opacity = '0'; }
      await sleep(450);
      feed.innerHTML = '';
    }
  })();
}

/* ---------- sparkline CPU ---------- */
{
  const pts = Array.from({ length: 24 }, () => 20 + Math.random() * 20);
  const line = $('#sparkLine'), fill = $('#sparkFill'), val = $('#cpuVal');
  const draw = () => {
    const d = pts.map((v, i) => `${i ? 'L' : 'M'}${(i / (pts.length - 1)) * 120} ${32 - (v / 100) * 32 * 1.6}`).join('');
    line.setAttribute('d', d);
    fill.setAttribute('d', `${d}L120 32L0 32Z`);
    val.textContent = Math.round(pts.at(-1)) + '%';
  };
  draw();
  if (!reduced) setInterval(() => { pts.shift(); pts.push(Math.max(6, Math.min(60, pts.at(-1) + (Math.random() - 0.45) * 14))); draw(); }, 900);
}

/* ---------- scrambling ciphertext ---------- */
{
  const el = $('#cipher'), hex = '0123456789abcdef';
  if (!reduced) setInterval(() => {
    el.textContent = el.textContent.replace(/[0-9a-f]/g, (c) => (Math.random() < 0.35 ? hex[(Math.random() * 16) | 0] : c));
  }, 120);
}

/* ---------- deploy tabs + terminal ---------- */
{
  const KINDS = {
    frontend: { dir: '~/coffee-shop', url: 'coffee-shop.snug.run', meta: 'Vite · static · global CDN', lines: [
      ['p', '$ ', '', 'snug deploy'], ['d', '→ ', '', 'detecting framework… '], ['v', '', '', 'Vite + React'],
      ['d', '→ ', '', 'npm ci  '], ['g', '', '', '✓ 412 packages (6.1 s)'], ['d', '→ ', '', 'npm run build  '], ['g', '', '', '✓ dist/ 148 kB'],
      ['d', '→ ', '', 'uploading to the edge  '], ['g', '', '', '✓'], ['d', '→ ', '', 'SSL '], ['b', '', '', "Let's Encrypt ✓"]] },
    backend: { dir: '~/coffee-api', url: 'api.coffee-shop.snug.run', meta: 'Node 22 · PM2 · 2 instances', lines: [
      ['p', '$ ', '', 'snug deploy --port 3000'], ['d', '→ ', '', 'runtime: '], ['v', '', '', 'Node.js 22 (Express)'],
      ['d', '→ ', '', 'npm ci --omit=dev  '], ['g', '', '', '✓'], ['d', '→ ', '', 'env: '], ['b', '', '', '6 variables from .env.production'],
      ['d', '→ ', '', 'health check GET /health  '], ['g', '', '', '✓ 200 (14 ms)'], ['d', '→ ', '', 'zero-downtime swap  '], ['g', '', '', '✓']] },
    fullstack: { dir: '~/coffee-web', url: 'coffee.shop', meta: 'Next.js · SSR · custom domain', lines: [
      ['p', '$ ', '', 'snug deploy --domain coffee.shop'], ['d', '→ ', '', 'framework: '], ['v', '', '', 'Next.js 16 (App Router)'],
      ['d', '→ ', '', 'next build  '], ['g', '', '', '✓ 23 routes, 4 APIs'], ['d', '→ ', '', 'database: '], ['b', '', '', 'postgres://snug-db (internal)'],
      ['d', '→ ', '', 'prisma migrate  '], ['g', '', '', '✓ 3 migrations'], ['d', '→ ', '', 'DNS coffee.shop  '], ['g', '', '', '✓ verified']] },
    database: { dir: '~', url: 'postgres://snug-db:5432', meta: 'PostgreSQL 17 · daily backups', lines: [
      ['p', '$ ', '', 'snug db create postgres --name snug-db'], ['d', '→ ', '', 'image '], ['v', '', '', 'postgres:17-alpine'],
      ['d', '→ ', '', 'volume 10 GB  '], ['g', '', '', '✓'], ['d', '→ ', '', 'credentials stored in '], ['b', '', '', 'the server keychain'],
      ['d', '→ ', '', 'backup schedule 03:00 UTC  '], ['g', '', '', '✓'], ['d', '→ ', '', 'network '], ['b', '', '', 'internal only']] },
    worker: { dir: '~/coffee-bot', url: 'coffee-bot · cron */15', meta: 'Python 3.13 · auto-restart', lines: [
      ['p', '$ ', '', 'snug run --always "python bot.py"'], ['d', '→ ', '', 'runtime: '], ['v', '', '', 'Python 3.13 (uv)'],
      ['d', '→ ', '', 'uv sync  '], ['g', '', '', '✓ 18 packages'], ['d', '→ ', '', 'process '], ['b', '', '', 'coffee-bot (pid 2841)'],
      ['d', '→ ', '', 'cron report */15 * * * *  '], ['g', '', '', '✓'], ['d', '→ ', '', 'log: '], ['b', '', '', 'snug logs coffee-bot -f']] },
  };
  const tabs = $$('.dtab'), ind = $('.dtab-ind'), body = $('#termBody'), live = $('#termLive');
  let run = 0;
  const moveInd = (t) => {
    ind.style.left = t.offsetLeft + 'px'; ind.style.top = t.offsetTop + 'px';
    ind.style.width = t.offsetWidth + 'px'; ind.style.height = t.offsetHeight + 'px';
  };
  const play = async (kind) => {
    const id = ++run, k = KINDS[kind];
    $('#termTitle').textContent = k.dir;
    $('#liveUrl').textContent = k.url;
    $('#liveMeta').textContent = k.meta;
    live.classList.remove('show');
    body.innerHTML = '';
    const cur = document.createElement('span'); cur.className = 'cur';
    let first = true;
    for (const [cls, pre, , text] of k.lines) {
      if (id !== run) return;
      const newLine = pre !== '' || first;
      if (newLine && !first) body.append('\n');
      first = false;
      const s = document.createElement('span'); s.className = cls;
      body.append(s); body.append(cur);
      s.textContent = pre;
      const out = cls === 'p' ? document.createElement('span') : s;
      if (cls === 'p') { body.insertBefore(out, cur); }
      for (const ch of text) {
        if (id !== run) return;
        out.textContent += ch;
        await sleep(reduced ? 0 : cls === 'p' ? 35 : 9);
      }
      await sleep(reduced ? 0 : cls === 'p' ? 350 : cls === 'g' ? 260 : 60);
    }
    if (id !== run) return;
    body.append('\n\n');
    const p = document.createElement('span'); p.className = 'p'; p.textContent = '$ ';
    body.append(p, cur);
    live.classList.add('show');
  };
  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => (x.classList.toggle('on', x === t), x.setAttribute('aria-selected', String(x === t))));
    // Phones: the tab strip scrolls sideways; keep the chosen tab in view.
    t.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduced ? 'auto' : 'smooth' });
    moveInd(t);
    play(t.dataset.kind);
  }));
  const termIO = new IntersectionObserver(([e]) => {
    if (e.isIntersecting) { termIO.disconnect(); play('frontend'); }
  }, { threshold: 0.4 });
  termIO.observe($('.term'));
  requestAnimationFrame(() => moveInd($('.dtab.on')));
  addEventListener('resize', () => moveInd($('.dtab.on')));
  document.fonts?.ready.then(() => moveInd($('.dtab.on')));
}

/* ---------- pricing: monthly / yearly ---------- */
{
  const sw = $('#billSwitch');
  const set = (yearly) => {
    sw.setAttribute('aria-checked', yearly);
    $$('.bl').forEach((b) => b.classList.toggle('on', (b.dataset.b === 'y') === yearly));
    for (const b of $$('.price b[data-m]')) {
      b.classList.remove('flip'); void b.offsetWidth; b.classList.add('flip');
      setTimeout(() => { b.textContent = yearly ? b.dataset.y : b.dataset.m; }, 220);
    }
    cfg.yearly = yearly; cfg.update();
  };
  sw.addEventListener('click', () => set(sw.getAttribute('aria-checked') !== 'true'));
  $$('.bl').forEach((b) => b.addEventListener('click', () => set(b.dataset.b === 'y')));
}

/* ---------- server configurator ---------- */
const cfg = (() => {
  const RAM = [2, 4, 8, 16, 32, 64];
  const rCpu = $('#rCpu'), rRam = $('#rRam'), rDisk = $('#rDisk'), price = $('#cfgPrice'), rack = $('#rack');
  const state = { yearly: false, shown: 15, units: 0 };
  const fill = (r) => r.style.setProperty('--fill', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
  state.update = () => {
    const cpu = +rCpu.value, ram = RAM[+rRam.value], disk = +rDisk.value;
    $('#vCpu').textContent = cpu; $('#vRam').textContent = ram + ' GB'; $('#vDisk').textContent = disk + ' GB';
    [rCpu, rRam, rDisk].forEach(fill);
    let total = 2 + cpu * 3.5 + ram * 1.3 + disk * 0.04;
    if (state.yearly) total *= 0.8;
    total = Math.round(total);
    const from = state.shown, t0 = performance.now();
    const anim = (t) => {
      const p = Math.min(1, (t - t0) / 400);
      state.shown = Math.round(from + (total - from) * (1 - Math.pow(1 - p, 3)));
      price.textContent = state.shown.toLocaleString('en-US');
      if (p < 1) requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
    const units = Math.min(8, 1 + Math.ceil(cpu / 2.5) + (+rRam.value >> 1));
    while (rack.children.length < units) { const u = document.createElement('div'); u.className = 'unit'; u.style.setProperty('--dl', `${Math.random()}s`); rack.append(u); }
    while (rack.children.length > units) rack.lastElementChild.remove();
  };
  [rCpu, rRam, rDisk].forEach((r) => r.addEventListener('input', state.update));
  for (const b of $$('#regions .rg')) {
    b.addEventListener('click', () => {
      $$('#regions .rg').forEach((x) => x.classList.toggle('on', x === b));
      const el = $('#ping'), to = +b.dataset.ms, from = +el.textContent, t0 = performance.now();
      const anim = (t) => { const p = Math.min(1, (t - t0) / 500); el.textContent = Math.round(from + (to - from) * p); if (p < 1) requestAnimationFrame(anim); };
      requestAnimationFrame(anim);
    });
  }
  state.update();
  return state;
})();

/* ---------- FAQ ---------- */
const setQa = (qa, open) => { qa.classList.toggle('open', open); $('.q', qa).setAttribute('aria-expanded', String(open)); };
for (const qa of $$('.qa')) {
  $('.q', qa).addEventListener('click', () => {
    const open = !qa.classList.contains('open');
    $$('.qa.open').forEach((x) => setQa(x, false));
    setQa(qa, open);
  });
}
if ($('.qa')) setQa($('.qa'), true);

/* ---------- swipeable rails on phones (features, plans): dots + start on the popular plan ---------- */
for (const rail of $$('.rail')) {
  const items = [...rail.children];
  const dots = document.createElement('div');
  dots.className = 'rail-dots';
  dots.setAttribute('aria-hidden', 'true');
  dots.innerHTML = items.map(() => '<i></i>').join('');
  rail.after(dots);
  const sync = () => {
    const mid = rail.scrollLeft + rail.clientWidth / 2;
    let at = 0;
    items.forEach((it, i) => { if (it.offsetLeft <= mid) at = i; });
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === at));
  };
  rail.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });
  const pop = $('.pop', rail);
  if (pop && mobile.matches) requestAnimationFrame(() => (rail.scrollLeft = pop.offsetLeft - (rail.clientWidth - pop.offsetWidth) / 2));
  requestAnimationFrame(sync);
}

/* ---------- starry sky in the CTA ---------- */
{
  const cv = $('#stars'), ctx = cv.getContext('2d');
  let stars = [], w = 0, h = 0, visible = false;
  const resize = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    w = cv.clientWidth; h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: Math.round((w * h) / 4500) }, () => ({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.3 + 0.3, p: Math.random() * 6.28, s: 0.5 + Math.random() * 1.5, v: Math.random() * 0.15 + 0.03 }));
  };
  let shoot = null;
  const frame = (t) => {
    if (!visible) return;
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      s.x -= s.v; if (s.x < 0) s.x = w;
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t / 1000 * s.s + s.p));
      ctx.fillStyle = '#fbeee0';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.28); ctx.fill();
    }
    if (!shoot && Math.random() < 0.006) shoot = { x: Math.random() * w * 0.6 + w * 0.3, y: Math.random() * h * 0.3, l: 0 };
    if (shoot) {
      shoot.l += 0.025;
      const x = shoot.x - shoot.l * 260, y = shoot.y + shoot.l * 130;
      const g = ctx.createLinearGradient(x, y, x + 80, y - 40);
      g.addColorStop(0, 'rgba(233,166,136,1)'); g.addColorStop(1, 'rgba(233,166,136,0)');
      ctx.globalAlpha = 1 - shoot.l; ctx.strokeStyle = g; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 80, y - 40); ctx.stroke();
      if (shoot.l >= 1) shoot = null;
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  };
  resize();
  addEventListener('resize', resize);
  new IntersectionObserver(([e]) => {
    const was = visible; visible = e.isIntersecting && !reduced;
    if (visible && !was) requestAnimationFrame(frame);
    if (reduced) frame(0);
  }).observe(cv);
}

/* ---------- marquee: duplicate content for a seamless loop ---------- */
for (const t of $$('.mq-track')) t.innerHTML += t.innerHTML;
