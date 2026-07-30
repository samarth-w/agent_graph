/**
 * Diagnostic: dump the cases where B5 (cgraph fingerprints) reported "unchanged"
 * for a mutation labeled semantic-changing. These are false negatives — the
 * correctness-critical failure direction — so each one is either a real
 * soundness bug in the fingerprint or a mislabeled mutation.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { initMutator, collectSymbols } from './lib/mutate.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseFile } = require(path.join(ROOT, 'dist', 'parser.js'));
const { initTreeSitter } = require(path.join(ROOT, 'dist', 'treesitter.js'));

function fingerprints(source, language, relPath, level) {
  const out = new Map();
  let result;
  try {
    result = parseFile(source, language, relPath, { fingerprintLevel: level });
  } catch {
    return out;
  }
  const visit = (symbols) => {
    for (const s of symbols) {
      if (s.fingerprint) out.set(s.name, s.fingerprint);
      if (s.children?.length) visit(s.children);
    }
  };
  visit(result.symbols);
  return out;
}

const level = 4;
const gold = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/invalidation-gold.json'), 'utf8'));

await initMutator();
await initTreeSitter();

const cache = new Map();
const misses = [];
const skipReasons = { missingFile: 0, symbolGone: 0, noFingerprint: 0 };

for (const c of gold.cases) {
  const abs = path.join(ROOT, c.file);
  if (!cache.has(c.file)) {
    cache.set(c.file, fs.existsSync(abs)
      ? {
          source: fs.readFileSync(abs, 'utf8'),
          symbols: new Map(collectSymbols(fs.readFileSync(abs, 'utf8'), c.language).map((s) => [s.name, s])),
          fps: fingerprints(fs.readFileSync(abs, 'utf8'), c.language, c.file, level),
        }
      : null);
  }
  const before = cache.get(c.file);
  if (!before) { skipReasons.missingFile += c.expectations.length; continue; }

  const afterSymbols = new Map(collectSymbols(c.mutatedSource, c.language).map((s) => [s.name, s]));
  const afterFps = fingerprints(c.mutatedSource, c.language, c.file, level);

  for (const exp of c.expectations) {
    const a = before.symbols.get(exp.symbol);
    const b = afterSymbols.get(exp.symbol);
    const fa = before.fps.get(exp.symbol);
    const fb = afterFps.get(exp.symbol);
    if (!a || !b) { skipReasons.symbolGone++; continue; }
    if (fa === undefined || fb === undefined) { skipReasons.noFingerprint++; continue; }
    if (exp.expectInvalidate && fa === fb) {
      misses.push({
        id: c.id, file: c.file, language: c.language,
        symbol: exp.symbol, mutationKind: c.mutationKind,
        beforeText: a.text.slice(0, 400),
        afterText: b.text.slice(0, 400),
      });
    }
  }
}

console.log(JSON.stringify({ falseNegatives: misses.length, skipReasons, misses }, null, 2));
