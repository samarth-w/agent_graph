/**
 * Five-arm invalidation accuracy evaluation.
 *
 *   node scripts/eval-invalidation.mjs [--gold fixtures/invalidation-gold.json]
 *                                      [--level 4] [--pretty] [--out reports/x.json]
 *
 * Arms:
 *   B1 mtime        — any touched file invalidates everything in it.
 *   B2 file_hash    — file content hash; what most tooling does today.
 *   B3 line_hash    — hash of the symbol's exact source lines, unnormalized.
 *   B4 lexical      — token-bag cosine similarity below a threshold invalidates.
 *   B5 cgraph       — this system, via the real production parse path.
 *
 * ERROR ASYMMETRY. The two mistakes are not equally bad:
 *   false negative — the symbol changed meaningfully but knowledge was kept.
 *                    The agent then acts on a stale belief. CORRECTNESS hazard.
 *   false positive — valid knowledge was discarded and must be re-derived.
 *                    COST hazard.
 * Recall therefore matters more than precision, and an arm with recall < 1.0
 * is reported as unsafe regardless of its F1.
 *
 * B4 is a LEXICAL proxy for an embedding baseline, not a neural model. It is
 * deterministic and offline, which keeps the harness reproducible, but it
 * should not be read as a claim about what a real embedding model would score.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { initMutator, collectSymbols } from './lib/mutate.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { parseFile } = require(path.join(ROOT, 'dist', 'parser.js'));
const { initTreeSitter } = require(path.join(ROOT, 'dist', 'treesitter.js'));

const LEXICAL_THRESHOLD = 0.95;

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function tokenBag(text) {
  const bag = new Map();
  for (const tok of text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+|[^\sA-Za-z0-9_]/g) ?? []) {
    bag.set(tok, (bag.get(tok) ?? 0) + 1);
  }
  return bag;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    if (b.has(k)) dot += v * b.get(k);
  }
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return na === nb ? 1 : 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** name → fingerprint, from the real production parse path. */
function productionFingerprints(source, language, relPath, level) {
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

function newCounts() {
  return { tp: 0, fp: 0, fn: 0, tn: 0 };
}

function score(c) {
  const precision = c.tp + c.fp === 0 ? 1 : c.tp / (c.tp + c.fp);
  const recall = c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const retention = c.tn + c.fp === 0 ? 1 : c.tn / (c.tn + c.fp);
  return {
    ...c,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4)),
    knowledgeRetentionRate: Number(retention.toFixed(4)),
  };
}

async function main() {
  const argv = process.argv;
  const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  const goldPath = argOf('--gold', 'fixtures/invalidation-gold.json');
  const level = Number(argOf('--level', '4'));
  const outPath = argOf('--out', null);

  const gold = JSON.parse(fs.readFileSync(path.join(ROOT, goldPath), 'utf8'));

  await initMutator();
  await initTreeSitter();

  const ARMS = ['B1_mtime', 'B2_file_hash', 'B3_line_hash', 'B4_lexical', 'B5_cgraph'];
  const totals = Object.fromEntries(ARMS.map((a) => [a, newCounts()]));
  const perKind = {};
  const perLanguage = {};

  const originalCache = new Map();
  let evaluated = 0;
  let skipped = 0;

  for (const c of gold.cases) {
    const absolute = path.join(ROOT, c.file);
    if (!originalCache.has(c.file)) {
      if (!fs.existsSync(absolute)) {
        originalCache.set(c.file, null);
      } else {
        const source = fs.readFileSync(absolute, 'utf8');
        originalCache.set(c.file, {
          source,
          symbols: new Map(collectSymbols(source, c.language).map((s) => [s.name, s])),
          fingerprints: productionFingerprints(source, c.language, c.file, level),
        });
      }
    }
    const before = originalCache.get(c.file);
    if (!before) {
      skipped++;
      continue;
    }

    const afterSymbols = new Map(collectSymbols(c.mutatedSource, c.language).map((s) => [s.name, s]));
    const afterFingerprints = productionFingerprints(c.mutatedSource, c.language, c.file, level);
    const fileChanged = c.mutatedSource !== before.source;

    for (const exp of c.expectations) {
      const a = before.symbols.get(exp.symbol);
      const b = afterSymbols.get(exp.symbol);
      const fa = before.fingerprints.get(exp.symbol);
      const fb = afterFingerprints.get(exp.symbol);
      // Only score symbols every arm can actually see, so no arm is credited
      // or penalized for a symbol another arm never had a chance to judge.
      if (!a || !b || fa === undefined || fb === undefined) {
        skipped++;
        continue;
      }

      const verdicts = {
        B1_mtime: fileChanged,
        B2_file_hash: fileChanged,
        B3_line_hash: sha(a.text) !== sha(b.text),
        B4_lexical: cosine(tokenBag(a.text), tokenBag(b.text)) < LEXICAL_THRESHOLD,
        B5_cgraph: fa !== fb,
      };

      perKind[c.mutationKind] ??= Object.fromEntries(ARMS.map((x) => [x, newCounts()]));
      perLanguage[c.language] ??= Object.fromEntries(ARMS.map((x) => [x, newCounts()]));

      for (const arm of ARMS) {
        const bucket = exp.expectInvalidate
          ? (verdicts[arm] ? 'tp' : 'fn')
          : (verdicts[arm] ? 'fp' : 'tn');
        totals[arm][bucket]++;
        perKind[c.mutationKind][arm][bucket]++;
        perLanguage[c.language][arm][bucket]++;
      }
      evaluated++;
    }
  }

  const arms = Object.fromEntries(ARMS.map((a) => [a, score(totals[a])]));
  const mapScores = (obj) => Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, Object.fromEntries(ARMS.map((a) => [a, score(v[a])]))]),
  );

  const report = {
    goldPath,
    fingerprintLevel: level,
    caseCount: gold.cases.length,
    judgementCount: evaluated,
    skipped,
    lexicalThreshold: LEXICAL_THRESHOLD,
    arms,
    unsafeArms: ARMS.filter((a) => arms[a].recall < 1),
    byMutationKind: mapScores(perKind),
    byLanguage: mapScores(perLanguage),
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(path.join(ROOT, outPath)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, outPath), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, argv.includes('--pretty') ? 2 : 0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
