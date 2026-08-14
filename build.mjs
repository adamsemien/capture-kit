import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const outdir = 'dist';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  outdir,
  sourcemap: false,
  target: 'chrome116',
  logLevel: 'info',
};

// The service worker is declared "type": "module"; everything else loads as a
// classic script, so those bundles are IIFE.
await esbuild.build({
  ...common,
  format: 'esm',
  entryPoints: { 'background/service-worker': 'src/background/service-worker.ts' },
});

await esbuild.build({
  ...common,
  format: 'iife',
  entryPoints: {
    'content/recorder-main': 'src/content/recorder-main.ts',
    'content/recorder-isolated': 'src/content/recorder-isolated.ts',
    'popup/popup': 'src/popup/popup.ts',
    'options/options': 'src/options/options.ts',
    'result/result': 'src/result/result.ts',
    'session/session': 'src/session/session.ts',
  },
});

cpSync('manifest.json', `${outdir}/manifest.json`);
// Shared design tokens — every page links ../tokens.css before its own.
cpSync('src/tokens.css', `${outdir}/tokens.css`);
cpSync('icons', `${outdir}/icons`, { recursive: true });
cpSync('src/popup/popup.html', `${outdir}/popup/popup.html`);
cpSync('src/popup/popup.css', `${outdir}/popup/popup.css`);
cpSync('src/options/options.html', `${outdir}/options/options.html`);
cpSync('src/options/options.css', `${outdir}/options/options.css`);
cpSync('src/result/result.html', `${outdir}/result/result.html`);
cpSync('src/result/result.css', `${outdir}/result/result.css`);
cpSync('src/session/session.html', `${outdir}/session/session.html`);
cpSync('src/session/session.css', `${outdir}/session/session.css`);

console.log('Built dist/ — load it unpacked via chrome://extensions.');
