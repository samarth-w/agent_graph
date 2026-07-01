# cgraph 15/10 Masterplan

## 1) Vision and Success Definition
Goal:
- Transform cgraph into a decision-grade engineering intelligence platform that is trusted for change impact, root-cause exploration, and release risk analysis.

Success means all of the following are true for at least 8 consecutive weeks:
1. Engineering teams treat impact results as a first-pass decision input, not just discovery hints.
2. Accuracy, latency, and explainability KPIs stay within targets without manual intervention.
3. The platform supports large repositories and mixed-language projects without major degradation.
4. Product, support, and leadership can demonstrate measurable business ROI from adoption.

## 2) Strategic Objectives
1. Trustworthiness:
- Every major claim carries evidence and calibrated confidence.

2. Decision quality:
- Impact analysis captures control flow, data flow, and side effects, not just symbol proximity.

3. Scale:
- Large repositories remain interactive with stable p95 performance.

4. Operability:
- Releases are gated by objective quality signals and production observability.

5. Adoption:
- Developers can use CLI and MCP workflows with clear, predictable output modes.

## 3) Program Scope
In scope:
1. Semantic impact engine upgrades.
2. Evidence and confidence contract hardening.
3. Benchmark harness and quality gates in CI.
4. Parser and domain-rule expansion.
5. Scale, caching, and incremental indexing.
6. CLI and MCP output-mode polish for decision workflows.

Out of scope for this program cycle:
1. Formal verification of runtime semantics.
2. Full support for all programming languages.
3. One-shot replacement of human review in safety-critical domains.

## 4) Operating Model
### 4.1 Program Cadence
1. Weekly engineering review:
- Status, blockers, and risk register updates.

2. Biweekly quality review:
- Benchmark deltas, false-positive audits, and calibration checks.

3. Monthly leadership review:
- KPI trendlines, adoption, ROI indicators, and roadmap adjustments.

### 4.2 Team Structure
Required core team:
1. Engineering lead for architecture and sequencing.
2. Graph and semantics engineer.
3. Parser and indexing engineer.
4. Developer experience engineer for CLI and MCP.
5. Evaluation and quality engineer.
6. Product owner for requirements and rollout governance.

### 4.3 Decision Rights
1. Product owner owns priority and acceptance criteria.
2. Engineering lead owns technical approach and sequencing.
3. Evaluation owner can block release on KPI regression.
4. Release manager can trigger fallback modes on SLO breach.

## 5) Master Roadmap

## Phase 0: Program Setup and Baseline (Weeks 1-2)
Objective:
- Establish measurement, controls, and release safety rails.

Deliverables:
1. Gold benchmark set with at least 100 labeled impact questions.
2. Baseline scorecard for precision, recall, latency, and evidence coverage.
3. Shared output contract for scope metadata and warnings.
4. Risk register and release gate policy documented.

Exit criteria:
1. Baseline metrics published and reproducible.
2. CI emits benchmark reports for every main-branch merge.

## Phase 1: Evidence-First Contract (Weeks 3-5)
Objective:
- Make every result explainable and confidence-aware.

Deliverables:
1. Unified finding schema with mandatory evidence metadata.
2. Confidence calibration rubric and downgrade rules.
3. Response sections for direct, conditional, side-effect, and uncertain findings.
4. Heuristic-only warning pathway and uncertainty summary.

Exit criteria:
1. Evidence coverage at top 10 findings is at least 95 percent.
2. High-confidence findings without evidence are 0 percent.

## Phase 2: Semantic Reasoning Expansion (Weeks 6-10)
Objective:
- Improve impact quality by adding semantics beyond graph adjacency.

Deliverables:
1. Relation classifier:
- call
- assignment
- condition
- data propagation
- side effect
- heuristic
2. Condition-aware gating extraction from control-flow blocks.
3. Data propagation inference for setup or policy fields.
4. Side-effect heuristics for persistence, runtime toggles, and forced overrides.

Exit criteria:
1. Precision at 10 improves by at least 20 percent vs baseline.
2. Recall at 20 improves by at least 15 percent on conditional-impact slices.

## Phase 3: Scale and Performance Hardening (Weeks 11-14)
Objective:
- Maintain responsiveness and reliability on very large repositories.

Deliverables:
1. Incremental indexing with file-level invalidation.
2. Hot-symbol cache and adaptive traversal depth.
3. Large-repo execution policy with bounded traversal budgets.
4. Index health diagnostics and automatic recovery path.

Exit criteria:
1. p95 impact latency under 1.5 seconds on target large repos.
2. Re-index latency reduced by at least 40 percent for incremental changes.

## Phase 4: Productization and Adoption (Weeks 15-18)
Objective:
- Turn technical quality into team-level adoption and measurable value.

Deliverables:
1. Decision-mode output templates for engineering and leadership audiences.
2. PR and CI integration for impact summaries.
3. Rollout playbook with canary, beta, and stable channels.
4. Documentation set:
- trust model
- interpretation guide
- troubleshooting
- domain-pack authoring guide

Exit criteria:
1. At least 50 percent of target teams active weekly.
2. Two consecutive release cycles with no quality-gate regressions.

## 6) Workstreams and Owners
WS-A Semantic Engine:
- Owner: Graph and semantics engineer
- Support: Parser engineer, evaluation engineer

WS-B Evidence and Confidence:
- Owner: Engineering lead
- Support: DX engineer, evaluation engineer

WS-C Benchmarks and Quality Gates:
- Owner: Evaluation engineer
- Support: Product owner, engineering lead

WS-D Parser and Domain Packs:
- Owner: Parser and indexing engineer
- Support: Graph engineer

WS-E Scale and Reliability:
- Owner: Engineering lead
- Support: Graph engineer, parser engineer

WS-F Adoption and UX:
- Owner: Developer experience engineer
- Support: Product owner

## 7) KPI Framework
Primary KPIs:
1. Precision at 10, target at least 0.90.
2. Recall at 20, target at least 0.85.
3. Evidence coverage for top findings, target at least 0.95.
4. High-confidence false-positive rate, target below 0.05.
5. p95 latency for impact and context, target at most 1.5 seconds.
6. Incremental re-index speedup, target at least 40 percent.

Secondary KPIs:
1. Token overhead, target at most plus 15 percent vs baseline.
2. Weekly active teams.
3. Percentage of queries requiring fallback mode.
4. Number of benchmark regressions per release.

## 8) Quality Gates and Release Policy
A release is blocked when any of the following occur:
1. Precision at 10 drops by more than 3 points week over week.
2. High-confidence false-positive rate exceeds 5 percent.
3. p95 latency exceeds budget for two consecutive benchmark runs.
4. Evidence coverage falls below 90 percent.

Release channels:
1. Canary for internal users.
2. Beta for selected teams.
3. Stable for broad adoption after two healthy cycles.

Fallback controls:
1. Switch to discovery mode when quality gates fail.
2. Preserve evidence and scope reporting in fallback mode.
3. Log all fallback triggers for weekly review.

## 9) Risk Register and Mitigation Plan
Risk 1:
- Semantic overreach creates convincing but wrong outputs.
Mitigation:
- Confidence downgrade rules and mandatory uncertainty sections.

Risk 2:
- Performance regressions from deeper analysis.
Mitigation:
- Adaptive traversal budgets and cache-first lookup strategy.

Risk 3:
- Domain overfitting to firmware patterns.
Mitigation:
- Mixed-language and mixed-domain benchmark slices.

Risk 4:
- Scope confusion across multi-root repositories.
Mitigation:
- Explicit scope metadata and out-of-scope warnings in every response.

Risk 5:
- Team bandwidth drift.
Mitigation:
- Enforce phase exit criteria and cap concurrent major initiatives.

## 10) Detailed Backlog by Priority
P0 Must Ship:
1. Unified evidence schema enforcement in all impact outputs.
2. Quality harness with labeled datasets and CI integration.
3. Confidence calibration logic with downgrade policy.
4. Scope metadata and out-of-scope warnings.

P1 High Value:
1. Condition and side-effect relation extraction.
2. Data propagation inference for configuration flows.
3. Decision-mode report formatting for MCP and CLI.

P2 Strategic:
1. Domain packs for firmware and config-heavy backend systems.
2. Incremental indexing with eviction-safe cache hierarchy.
3. PR and release pipeline impact summaries.

## 11) Budget and Resourcing Inputs Needed
Engineering capacity:
1. 5 to 6 full-time contributors for 18 weeks.

Infrastructure:
1. CI capacity for benchmark jobs on representative large repositories.
2. Artifact storage for benchmark history and trend reports.

Data preparation:
1. Time from subject matter engineers to label benchmark cases.

Enablement:
1. Documentation and onboarding material for pilot teams.

## 12) Governance Templates
Weekly status template:
1. Completed this week.
2. In progress.
3. Blockers.
4. KPI delta.
5. Risk changes.
6. Decisions requested.

Monthly leadership template:
1. KPI trendlines.
2. Adoption and ROI indicators.
3. Release health summary.
4. Top risks and mitigation progress.
5. Next-month commitments.

## 13) Implementation Checklist
Phase 0 checklist:
1. Benchmark data structure finalized.
2. CI scoring job integrated.
3. Baseline report published.

Phase 1 checklist:
1. Evidence fields required at compile-time and runtime.
2. Confidence buckets visible in output.
3. Uncertainty messaging standardized.

Phase 2 checklist:
1. Relation classifier integrated into impact ranking.
2. Conditional and side-effect extraction validated.
3. Benchmark improvement validated.

Phase 3 checklist:
1. Incremental indexing enabled by default.
2. Performance budgets enforced in CI.
3. Recovery path tested under failure scenarios.

Phase 4 checklist:
1. Canary and beta cohorts onboarded.
2. Documentation complete and reviewed.
3. Stable release signed off with green gates.

## 14) Definition of Done for 15/10 State
All criteria must be met:
1. KPI targets achieved for 8 consecutive weeks.
2. Stable channel running without release-blocking regressions.
3. Decision-mode output trusted by pilot teams and used in regular workflows.
4. Measurable ROI documented in leadership review.

## 15) Immediate Next 10 Actions
1. Freeze benchmark schema and labeling rubric.
2. Add CI benchmark scoring and artifact publishing.
3. Finalize evidence and confidence response contract.
4. Implement strict uncertainty and downgrade rules.
5. Complete relation classifier baseline across call and assignment edges.
6. Add condition extraction for guarded paths.
7. Add side-effect tagging for persistent or runtime-changing operations.
8. Enable adaptive traversal policy for large repositories.
9. Draft rollout playbook for canary and beta groups.
10. Start weekly KPI and risk-review cadence.

## 17) Customer Validation Plan
Suggested validation scenarios:
- Firmware policy change: trace which configuration fields change and why.
- App refactor: identify direct and indirect impact for a shared helper.
- Setup/config change: understand which UI, runtime, and recovery paths are affected.
- Multi-repo investigation: confirm that scope and indexing boundaries are visible.

Validation method:
- Capture 5-10 representative tasks per phase.
- Ask users to rate output on: correctness, usefulness, clarity, and trust.
- Record whether the tool helped them reach a decision faster.
