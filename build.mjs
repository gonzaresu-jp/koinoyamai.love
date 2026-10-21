import * as esbuild from 'esbuild';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'webui', 'dist');
const JS = join(__dirname, 'webui', 'js');

if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });

const start = performance.now();

// ── 1. ESモジュールをバンドル (main.js + 全import) ─────────────────
await esbuild.build({
  entryPoints: [join(JS, 'main.js')],
  bundle: true,
  minify: true,
  outfile: join(DIST, 'main.bundle.min.js'),
  format: 'esm',
});

// ── 2. スタンドアロンJSを個別にminify（グローバル関数を維持） ────
const standalone = [
  'weekly-schedule', 'heatmap', 'notification-stats', 'carousel', 'count-days',
  'panel', 'mai-voice', 'ui-misc', 'subscribers', 'auth-settings-bridge', 'archive',
  'stream-alarm'
];
for (const name of standalone) {
  const src = join(JS, name + '.js');
  if (!existsSync(src)) {
    console.warn(`  [skip] ${name}.js not found`);
    continue;
  }
  await esbuild.build({
    entryPoints: [src],
    minify: true,
    outfile: join(DIST, `${name}.min.js`),
  });
}

// ── 3. CSS 単体minify（url()パス維持のためwebui直下に出力） ──
const cssFiles = ['style.css', 'heatmap.css', 'top-card.css', 'sp.css'];
for (const f of cssFiles) {
  const src = join(__dirname, 'webui', f);
  if (!existsSync(src)) continue;
  await esbuild.build({
    entryPoints: [src],
    minify: true,
    outfile: join(__dirname, 'webui', f.replace('.css', '.min.css')),
    loader: { '.css': 'css' },
  });
}

const elapsed = (performance.now() - start).toFixed(0);
console.log(`[build] Done in ${elapsed}ms -> ${DIST}`);
