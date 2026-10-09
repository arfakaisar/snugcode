// Ikon aplikasi dari maskot Snug: SVG (favicon, ikon "any") + PNG untuk Android, maskable, dan iOS
// (iOS tidak memakai SVG untuk ikon layar utama). Hasil di web/ ikut di-commit; jalankan ulang
// setelah mengubah maskot:  npm run icons
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../daemon/browser.js';

const WEB = path.resolve(import.meta.dirname, '..', 'web');

// Maskot statis (warna tetap), koordinat 64×64 seperti MASCOT di web/ui/dom.js.
const MASCOT = `<ellipse cx="32" cy="58.6" rx="21" ry="2.4" fill="#000" opacity=".22"/>
<path d="M13 50C13 33 21 21.5 32 21.5S51 33 51 50Z" fill="#d97757"/>
<path d="M23.4 37.2q3 3 6 0M34.6 37.2q3 3 6 0" fill="none" stroke="#3a231a" stroke-width="2.6" stroke-linecap="round"/>
<ellipse cx="21.6" cy="42" rx="2.8" ry="1.7" fill="#f6a48c" opacity=".8"/><ellipse cx="42.4" cy="42" rx="2.8" ry="1.7" fill="#f6a48c" opacity=".8"/>
<ellipse cx="32" cy="42.3" rx="1.4" ry="1.2" fill="#3a231a"/>
<path d="M15.5 32.5C16 22.5 24 16.5 33.5 16.5c8.5 0 15.5 3.5 19.5 10.5 2.5 4.5 4 8 4.2 11.5.2 1.9-1.6 2.5-2.4.9-1.4-3.4-3.8-6.9-7.6-9.2-7.7-3.2-23.2-2.8-31.7 2.3Z" fill="#6f7bc8"/>
<path d="M27 22.2l.7 1.5 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2z" fill="#fbeee0"/><circle cx="40.5" cy="21.5" r="1" fill="#fbeee0"/><circle cx="20.5" cy="27.6" r=".8" fill="#fbeee0"/>
<path d="M16.4 31.8C24.5 27 39 26.6 47.3 30" fill="none" stroke="#fbeee0" stroke-width="3.6" stroke-linecap="round"/>
<circle cx="56" cy="40.4" r="3.4" fill="#fbeee0"/>
<path d="M7 51c0-4.8 3.8-7 9.5-6.6 6 .4 10 2.6 15.5 2.6s9.5-2.2 15.5-2.6C53.2 44 57 46.2 57 51v3.5c0 1.9-1.4 3.1-3.4 3.1H10.4c-2 0-3.4-1.2-3.4-3.1Z" fill="#fbeee0" stroke="#e3c4a8" stroke-width="1.2"/>
<path d="M11.5 53.2h41" fill="none" stroke="#e3c4a8" stroke-width="1.3" stroke-dasharray="2 2.6" stroke-linecap="round"/>
<ellipse cx="24.4" cy="45.6" rx="3.5" ry="2.5" fill="#d97757"/><ellipse cx="39.6" cy="45.6" rx="3.5" ry="2.5" fill="#d97757"/>
<path d="M45.5 15h3l-3 3.2h3M50.5 8.5h4l-4 4.2h4" fill="none" stroke="#e9a688" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
// Kotak pembatas maskot (termasuk zzz & pompom) dalam koordinat 64×64: dipusatkan di kanvas 512.
const BOX = { x0: 7, x1: 59.4, y0: 8.5, y1: 58.6 };

// scale = lebar maskot dalam px di kanvas 512; rx = sudut latar (0 = full-bleed untuk maskable/iOS).
function svg({ width, rx }) {
  const k = width / (BOX.x1 - BOX.x0);
  const tx = 256 - ((BOX.x0 + BOX.x1) / 2) * k;
  const ty = 256 - ((BOX.y0 + BOX.y1) / 2) * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs><radialGradient id="g" cx="50%" cy="56%" r="62%"><stop offset="0" stop-color="#3d2c23"/><stop offset="1" stop-color="#232220"/></radialGradient></defs>
<rect width="512" height="512" rx="${rx}" fill="url(#g)"/>
<g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${k.toFixed(3)})">
${MASCOT}
</g>
</svg>
`;
}

const icons = {
  // "any": ubin bersudut bulat, maskot ±75% lebar ikon.
  'icon.svg': svg({ width: 384, rx: 112 }),
  // Maskable: launcher Android memotong ke lingkaran/squircle; maskot di dalam zona aman (r = 40%).
  'icon-maskable.svg': svg({ width: 310, rx: 0 }),
  // iOS membulatkan sudut sendiri dan tidak memotong ke lingkaran.
  'apple-touch-icon.svg': svg({ width: 360, rx: 0 }),
};
for (const [f, s] of Object.entries(icons)) fs.writeFileSync(path.join(WEB, f), s);

const browser = await chromium.launch({ executablePath: process.env.CHROME || findBrowser() });
const page = await browser.newPage();
for (const [src, out, size] of [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
  ['apple-touch-icon.svg', 'apple-touch-icon.png', 180],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(icons[src]).toString('base64')}">`);
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(WEB, out), omitBackground: true });
  console.log('✔ ' + out);
}
fs.rmSync(path.join(WEB, 'apple-touch-icon.svg'));
await browser.close();
