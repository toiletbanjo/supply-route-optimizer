// Loads plain-script modules (which attach to globalThis.SRO) into Node for tests.
// Usage: const SRO = loadScripts(['src/core/ns.js', ...]) or loadGroup('worker', { only: [...] }).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .json data files become `SRO.data.<name> = <json>;` (same rule as tools/build.py).
export function wrapSource(file, text) {
  if (!file.endsWith('.json')) return text;
  const name = path.basename(file).split('.')[0];
  return '(function(root){var SRO=root.SRO=root.SRO||{};SRO.data=SRO.data||{};SRO.data[' + JSON.stringify(name) + ']=' + text + ';})(typeof self!=="undefined"?self:globalThis);';
}

export function loadScripts(files) {
  const ctx = { console, setTimeout, clearTimeout, performance, Date, Math, JSON };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of files) {
    const full = path.join(ROOT, f);
    vm.runInContext(wrapSource(f, fs.readFileSync(full, 'utf8')), ctx, { filename: full });
  }
  return ctx.SRO;
}

// Loads files from a manifest group in order, skipping missing optional (?) files
// and, when `upTo` is given, stopping after that file.
export function loadGroup(group, opts = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/manifest.json'), 'utf8'));
  const files = [];
  for (let f of manifest[group]) {
    const optional = f.endsWith('?');
    if (optional) f = f.slice(0, -1);
    if (!fs.existsSync(path.join(ROOT, f))) {
      if (optional || opts.skipMissing) continue;
      throw new Error('missing ' + f);
    }
    files.push(f);
    if (opts.upTo && f === opts.upTo) break;
  }
  return loadScripts(files);
}

export { ROOT };
