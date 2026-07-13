# cgraph — Technical Critique & Gap List ("to be fixed")

Reviewed sources: `archetecture.md`, `README.md`, `CHANGELOG.md`, `improvemnts.md` (15/10 Masterplan),
`aprogress_150.md` (150/100 Progress Tracker), `package.json`, `src/storage.ts`, `src/a2a.ts`,
`src/config.ts`, `coverage/index.html`, `.github/workflows/*`, and the `__tests__/` layout.

This is a blunt, prioritized punch-list. Severity: **P0 = fix before trusting this in real workflows**,
**P1 = fix before calling it "production-grade" / before external users**, **P2 = polish / longer-horizon**.

---

## 1) Executive Summary

The project has genuinely good bones: a layered architecture (ingest → store → analyze → CLI/MCP/A2A),
real Mermaid sequence diagrams, a benchmark/gate harness, and an unusually candid `aprogress_150.md`
and `improvemnts.md` (masterplan) that show self-awareness about what's missing. That's rare and good.

But there is a wide gap between **narrative maturity** (the docs read like a v2.0 platform) and
**implementation maturity** (a single-writer, in-memory WASM SQLite with no locking, no auth on the
A2A HTTP surface beyond per-write signatures, ~77% statement coverage, 65% branch coverage, and a
masterplan that is aspirational rather than shipped). The biggest risk is that agents/CI will trust
outputs (`impact`, `gate`, A2A trust_status) more than the current implementation actually earns.

---

## 2) Cross-Document Consistency Gaps (P1)

1. **`archetecture.md` vs `README.md` architecture section duplicate/diverge.** Two separate
   "architecture" write-ups exist with different diagrams and different levels of detail. They will
   drift out of sync (one already omits the `graph/summary.ts`, `compression/*`, `cli/gate.ts`,
   `cli/pr-summary.ts` modules that the other doesn't mention either). Pick one canonical source and
   have the other link to it instead of re-describing it.
2. **`aprogress_150.md` claims "All items from the original 150/100 plan are now complete"** and that
   CI/release automation "are implemented via GitHub Actions" — true, `.github/workflows/ci.yml`,
   `release.yml`, and `a2a-benchmark-gate.yml` do exist. But the doc gives zero visibility into whether
   these workflows are green, and there's no badge/status link in `README.md`. A tracker that says
   "100% done" with no live verification link is a trust gap for readers.
3. **`improvemnts.md` (15/10 Masterplan) is entirely aspirational** — Phase 0 through Phase 4, KPIs,
   "gold benchmark set with 100 labeled cases," "evidence coverage ≥95%," etc. None of this is
   reflected in `archetecture.md` or `README.md` as "in progress." A reader hitting both docs has no
   way to know the masterplan is Day 0 of Week 1 vs Week 12. Add a status line ("Phase: not started" /
   "Phase 0 in progress") at the top of `improvemnts.md`.
4. **CHANGELOG.md `[Unreleased]` section lists brand-new language parsers** (ASL, EDK2, Batch, NASM,
   YAML, Markdown) that are not mentioned anywhere in `archetecture.md`'s parsing layer description or
   in `README.md`'s feature list. Either the changelog is ahead of the docs, or these are half-wired.
5. **README's "Performance Snapshot" claims "21.4x" speedup and "5.1x" (in CHANGELOG) for different
   scenarios** without a shared, reproducible benchmark script referenced by both. This looks like
   marketing-by-anecdote rather than a tracked metric. `improvemnts.md` explicitly calls for "baseline
   scorecard... reproducible" — that hasn't landed in the README yet.
6. **Two masterplan-style docs (`improvemnts.md`, `aprogress_150.md`) plus `archetecture.md` plus
   `README.md` plus `docs/*.md` = 4-5 overlapping "what is this project" documents.** There's no single
   index/README section pointing to all of them with a one-line purpose for each (this new file will at
   least partially fix that, but the repo needs a `docs/README.md` index).

---

## 3) Architecture-Level Gaps (P0/P1)

### 3.1 Storage engine is a single point of fragility (P0)
`src/storage.ts` uses `sql.js` — an **in-memory WASM SQLite** that is loaded fully into memory on
`GraphDB.open()` and written back to disk only on explicit `save()`. Consequences not discussed anywhere
in `archetecture.md`:
- **No cross-process locking.** CLI, MCP server, and A2A server can all open the same `.cgraph/graph.db`
  concurrently. Two processes writing and calling `save()` will race — last save wins, silently
  discarding the other process's writes. This is a correctness bug, not just a performance concern.
- **No crash-safety.** If the process dies between mutation and `save()`, all in-memory changes since
  the last save are lost with no WAL/journal to recover from.
- **Whole-file read + whole-file write per operation.** For large repos, every `GraphDB.open()` in the
  A2A handler (see 3.2) re-parses the entire DB from disk into memory, and every `save()` re-serializes
  the entire DB back to disk. This does not scale and is never called out as a known limitation in the
  architecture doc's "Performance Architecture" section.
- **Fix direction:** either move to `better-sqlite3` (real file-backed SQLite with proper locking) or
  add an explicit single-writer queue/lock (even a simple file lock or in-process mutex + a persistent
  server process instead of "open fresh DB per request").

### 3.2 A2A handler opens/closes a fresh DB per RPC call (P0)
Every method in `handleA2ARpcRequest` (`register_agent`, `write_node`, `read_lineage`, `query_by_agent`)
does `await GraphDB.open(...)` at the top and `db.close()` in a `finally`. Given 3.1, this means:
- Under concurrent load (the README's own "Throughput check" PowerShell snippet fires 20 concurrent
  writes), each request loads/saves the *entire* graph DB independently, causing lost-update races and
  needless I/O amplification. The benchmark scripts (`benchmark-a2a-multihop.mjs`) should be checked to
  confirm whether they run sequentially (masking this bug) or concurrently (exposing it).
- There is no connection pool / long-lived DB handle option for the A2A server despite it being
  advertised as a persistent "runtime integration" component in both README and architecture doc.

### 3.3 A2A trust model has real security gaps (P0/P1)
- **No transport auth on the HTTP server itself.** Anyone who can reach the port can call
  `query_by_agent` or `read_lineage` for *any* `agent_id` — these are read paths with **zero
  authentication**, only `write_node`/`register_agent` require a signature. Data authored by any agent
  is fully world-readable to anyone hitting `/rpc`. `archetecture.md` §8 ("Security and Trust
  Considerations") doesn't mention this asymmetry at all.
- **No TLS.** The server is plain HTTP; Ed25519 signatures protect the claim payload's authenticity but
  not the channel. Fine for localhost demos, understated risk if anyone binds `host: 0.0.0.0`.
- **No request size limit** in `readJsonBody` — it buffers the entire body into memory with no cap, a
  trivial memory-exhaustion DoS vector for anything reachable beyond localhost.
- **No revocation / expiry for registered agents.** Once `trust_status: verified` is written, there is
  no visible mechanism to revoke, rotate keys, or expire a stale registration.
- **No rate limiting** on any endpoint — inconsistent with a document that talks about "trust policy"
  and "production profiles" in §8-9 of `archetecture.md`.
- **MD5 used for content hashing** (`crypto.createHash('md5')`) in `register_agent`/`write_node`. Not a
  security control here since it's just a change-detection hash, but MD5 anywhere in a codebase that
  also talks about Ed25519 trust reads as inconsistent security hygiene — switch to SHA-256 for
  cheapness of the fix.

### 3.4 "Deterministic outputs for CI and agent workflows" is asserted, not verified (P1)
`archetecture.md` §1 states this as a core design principle, but there's no test that pins output
snapshots across runs/platforms (e.g., ordering of search/impact results, JSON key order, or
file-path normalization on Windows vs POSIX). Given this repo is being developed on Windows
(`C:\Users\samarth2\...`) but ships POSIX install scripts too, path-separator determinism is a real,
untested risk.

### 3.5 Adaptive/traversal limits are described but not benchmarked publicly (P1)
`src/adaptive.ts` is referenced in the performance section, and `improvemnts.md` Phase 3 explicitly
lists "p95 impact latency under 1.5s on target large repos" as a KPI — but there's no large-repo
benchmark artifact in `fixtures/` or `reports/` beyond the A2A-specific ones. The "Performance
Snapshot" in the README is a single anecdotal run against `demo/finance`, not a controlled
large-repo benchmark.

---

## 4) Parser / Ingestion Gaps (P1/P2)

- **Regex-based parsers for most non-JS/TS languages** (Python "regex-based" per CHANGELOG 0.1.0,
  plus the new ASL/EDK2/Batch/NASM/YAML/Markdown parsers) are fast but fragile — no mention anywhere of
  how false positives/negatives are measured for these. `improvemnts.md` Phase 2 wants a "relation
  classifier" and real semantic edges, but the current parser layer for 8+ languages is described in
  `archetecture.md` only at the level of "language-aware AST/syntax parsing," which overstates what a
  regex parser does.
- **No documented fallback behavior when a file fails to parse** — silently skipped? logged? counted in
  `status`? Neither `archetecture.md` nor `README.md` says.
- **Dynamic dispatch synthesis** (callbacks/events/HOFs/promises, per CHANGELOG 0.1.0) is a heuristic
  edge-creation feature with obvious false-positive risk, and it's not covered by the "Evidence-First
  Contract" that `improvemnts.md` proposes (confidence/evidence metadata per edge). This is exactly the
  kind of "convincing but wrong output" risk that `improvemnts.md`'s own Risk Register (Risk 1) flags —
  but the mitigation (confidence downgrade rules) hasn't been implemented in `src/synthesizer.ts` yet
  (unverified — worth a direct code check before shipping decision-mode output).

---

## 5) Testing & Quality Gaps (P1)

- **Coverage is 76.99% statements / 65.96% branches / 77.22% functions** (from `coverage/index.html`).
  Branch coverage in the mid-60s is the weak spot — that's usually where trust-model edge cases
  (`per_write` fallback logic in `a2a.ts`, config precedence in `getTrustPolicy`) go untested.
- **No coverage gate in CI.** `package.json`'s `verify` script runs `build && test && check:performance`
  but has no `--coverage` threshold enforcement, so coverage can silently regress.
- **No fuzz/property tests** for the parser layer (especially the new regex-based language parsers),
  which are exactly the components most likely to have edge-case bugs.
- **No test for concurrent A2A writes** (the exact race condition described in 3.1/3.2) despite the
  README providing a PowerShell snippet to *manually* fire 20 concurrent writes — this should be an
  automated test with an assertion on data integrity, not just a latency benchmark.
- **`__tests__/` is a flat 34-file directory** with no subfolder structure mirroring `src/` — fine at
  this size, but will not scale, and makes it hard to see which modules lack dedicated test files (e.g.,
  is there a dedicated `a2a-security.test.ts`? Not visible by name.)

---

## 6) Documentation & DX Gaps (P2)

- **No root-level docs index.** `docs/` has 4 files (`cli-usage.md`, `mcp-workflows.md`,
  `release-process.md`, `troubleshooting.md`) that are only linked from the bottom of `README.md`.
  Combined with `archetecture.md`, `improvemnts.md`, `aprogress_150.md`, `CHANGELOG.md` at repo root,
  there are effectively **9 markdown docs** with no single map of "read this first, this second."
- **No CONTRIBUTING.md / SECURITY.md / CODE_OF_CONDUCT.md visible at repo root** despite
  `aprogress_150.md` claiming these were added ("Added governance docs: CONTRIBUTING, SECURITY,
  CODE_OF_CONDUCT, MASTERPLAN, QUALITY.") — these were not present in the top-level directory listing.
  Either they were removed, never committed, or the tracker is stale. **This is itself a doc/reality
  mismatch worth fixing first.**
- **`README.md`'s "Use as a Library" example imports from `./src/storage`** (relative path) rather than
  the package's public `dist`/`main` entrypoint (`cgraph`), which is inconsistent with the diagnostics
  example right above it that correctly imports `from 'cgraph'`. Confusing for library consumers.
- **`archetecture.md` §6 "Observed benchmark posture"** is vague ("A2A multihop benchmark and
  enforce-mode gates are integrated") with no numbers, dates, or links to `reports/a2a-baseline.json` /
  `reports/a2a-current.json` even though those files exist in the repo.
- **Filename typo**: `archetecture.md` (should be `architecture.md`) and `improvemnts.md` (should be
  `improvements.md`) — trivial, but unprofessional in a repo that otherwise reads like an intentionally
  polished OSS project.

---

## 7) Process / Release Gaps (P2)

- **Version is `0.3.0` in `package.json`**, but `CHANGELOG.md`'s `[Unreleased]` section already lists
  substantial new language support — no clear process for when `[Unreleased]` gets cut into a version,
  and `docs/release-process.md` should be checked against `.github/workflows/release.yml` to confirm
  they agree (not verified in this pass — flag for follow-up).
- **No SemVer policy stated** anywhere for a project that ships a public library entrypoint
  (`main: ./dist/index.js`) and a CLI — breaking changes to CLI flags or MCP tool names would currently
  have no documented compatibility guarantee.
- **`node_modules` and `coverage/` and `dist/` are all present in the working tree** during this review —
  worth double-checking `.gitignore` actually excludes these from version control (not confirmed in this
  pass; if they're committed, that's a repo hygiene problem worth fixing immediately).

---

## 8) Prioritized Fix List

**P0 — fix before trusting outputs in real agent/CI workflows**
1. Add single-writer locking or move off `sql.js` in-memory model to a real file-backed engine with
   proper concurrency control (`src/storage.ts`).
2. Fix the A2A per-request open/close DB pattern to use a shared, lock-protected connection
   (`src/a2a.ts`).
3. Add authentication (at minimum, a shared secret / API key) to `query_by_agent` and `read_lineage`,
   which currently leak all agent-authored data to any caller.
4. Add a body-size limit to `readJsonBody` in `src/a2a.ts`.
5. Reconcile `aprogress_150.md`'s "governance docs added" claim with the actual repo root — either add
   the missing `CONTRIBUTING.md`/`SECURITY.md`/`CODE_OF_CONDUCT.md` or correct the tracker.

**P1 — fix before calling this production-grade / before external users**
6. Add an automated concurrency test for A2A writes that asserts no lost updates.
7. Raise branch coverage above ~80% with explicit focus on `a2a.ts` trust-mode fallback paths and
   `config.ts` precedence resolution.
8. Add a coverage threshold gate to CI (`ci.yml`) so coverage cannot silently regress.
9. Merge/cross-link `archetecture.md` and the README's architecture section into one canonical source.
10. Add explicit status markers ("not started / in progress / shipped") to `improvemnts.md` phases so
    readers don't mistake the masterplan for current state.
11. Replace MD5 with SHA-256 for content hashing in `a2a.ts` (cheap fix, removes an easy code-review
    red flag).
12. Add revocation/expiry semantics for A2A agent registrations.
13. Add a reproducible, checked-in benchmark script + numbers backing the README's "21.4x" claim (same
    treatment CHANGELOG's "5.1x" already implies exists somewhere).

**P2 — polish / longer horizon**
14. Rename `archetecture.md` → `architecture.md`, `improvemnts.md` → `improvements.md`.
15. Add a root `docs/README.md` (or a "Docs Map" section in the main README) indexing all 9 markdown
    files with one-line descriptions.
16. Add rate limiting to the A2A HTTP server.
17. Add fuzz/property tests for the regex-based language parsers (ASL, EDK2, Batch, NASM, YAML, MD).
18. Document parse-failure/fallback behavior for unsupported or malformed files.
19. State a SemVer/compatibility policy for CLI flags, MCP tool names, and library exports.
20. Confirm `.gitignore` correctly excludes `node_modules/`, `dist/`, and `coverage/` from version
    control.

---

## 9) What's Actually Good (worth preserving, not just criticizing)

- The layered design (ingest/store/analyze/interface) is a sound architecture and is consistently
  described across docs even where the docs disagree on details.
- The willingness to publish an honest, self-critical masterplan (`improvemnts.md`) and progress
  tracker (`aprogress_150.md`) is unusual and valuable — most projects don't admit "Out of scope" and
  risk registers this explicitly. Keep doing this, just keep it synced with reality.
- The A2A trust model's core idea (Ed25519-signed claims, `registration_only` vs `per_write` modes,
  fallback-with-logging) is a genuinely reasonable design; the gaps above are implementation hardening,
  not a wrong design direction.
- CI/CD automation (`ci.yml`, `release.yml`, `a2a-benchmark-gate.yml`) and a benchmark-budget/gate
  system (`fixtures/*-budget.json`, `scripts/check-performance-budget.mjs`) are more mature than most
  projects at this stage — the gap is in *auth/concurrency hardening* and *coverage*, not process
  tooling.
