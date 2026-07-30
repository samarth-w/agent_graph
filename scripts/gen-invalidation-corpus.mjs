/**
 * Generate the labeled invalidation corpus.
 *
 *   node scripts/gen-invalidation-corpus.mjs [--out fixtures/invalidation-gold.json]
 *
 * Each case records one mutation and the expected verdict for EVERY symbol in
 * the touched file, not just the mutated one. That is deliberate: the symbols
 * left alone are what separate symbol-level tracking from file-level tracking,
 * which otherwise score identically.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { initMutator, generateMutations, collectSymbols, languageForFile } from './lib/mutate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Source corpora shipped in-repo, so the evaluation reproduces offline. */
const CORPORA = [
  { repo: 'demo/finance', dir: 'demo/finance' },
  { repo: 'demo/tictactoe', dir: 'demo/tictactoe' },
  { repo: 'demo/cpp-shell', dir: 'demo/cpp-shell' },
  { repo: 'python_test', dir: 'python_test' },
  { repo: 'src', dir: 'src' },
];

function listFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(p);
      } else if (languageForFile(p)) {
        out.push(p);
      }
    }
  };
  walk(abs);
  return out.sort();
}

async function main() {
  const outArg = process.argv.indexOf('--out');
  const outPath = outArg !== -1 ? process.argv[outArg + 1] : 'fixtures/invalidation-gold.json';

  await initMutator();

  const cases = [];
  const byKind = {};
  const byLanguage = {};
  const repos = new Set();

  for (const { repo, dir } of CORPORA) {
    for (const file of listFiles(dir)) {
      const language = languageForFile(file);
      const source = fs.readFileSync(file, 'utf8');
      if (source.length > 200_000) continue;

      let symbols;
      let mutations;
      try {
        symbols = collectSymbols(source, language);
        if (symbols.length === 0) continue;
        mutations = generateMutations(source, language);
      } catch {
        continue;
      }

      for (const m of mutations) {
        const expectations = symbols.map((s) => ({
          symbol: s.name,
          // Only the mutated symbol can change, and only if the edit was
          // semantic. Every other symbol in the file is untouched.
          expectInvalidate: s.name === m.symbol && !m.semanticPreserving,
        }));
        cases.push({
          id: crypto.createHash('sha1')
            .update(`${file}\0${m.symbol}\0${m.kind}`).digest('hex').slice(0, 12),
          repo,
          file: path.relative(ROOT, file).replace(/\\/g, '/'),
          language,
          symbol: m.symbol,
          mutationKind: m.kind,
          semanticPreserving: m.semanticPreserving,
          mutatedSource: m.mutated,
          expectations,
        });
        byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
        byLanguage[language] = (byLanguage[language] ?? 0) + 1;
        repos.add(repo);
      }
    }
  }

  const payload = {
    generatedBy: 'scripts/gen-invalidation-corpus.mjs',
    caseCount: cases.length,
    repoCount: repos.size,
    languageCount: Object.keys(byLanguage).length,
    byKind,
    byLanguage,
    preserving: cases.filter((c) => c.semanticPreserving).length,
    changing: cases.filter((c) => !c.semanticPreserving).length,
    cases,
  };

  fs.mkdirSync(path.dirname(path.join(ROOT, outPath)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, outPath), JSON.stringify(payload, null, 2));

  console.log(JSON.stringify({
    out: outPath,
    caseCount: payload.caseCount,
    repoCount: payload.repoCount,
    languageCount: payload.languageCount,
    preserving: payload.preserving,
    changing: payload.changing,
    byLanguage,
    byKind,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
