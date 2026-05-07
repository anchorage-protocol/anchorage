# Roadmap

Anchorage is built phase by phase, with each phase producing a discrete artifact that's useful on its own and informs the next. This file is honest about what's planned, what's hand-waved, and what's load-bearing for everything else.

The roadmap is a living document. Phases will move; some will split or merge. What stays stable is the *order of dependencies*: each phase produces something the next phase needs, and we don't skip ahead.

---

## Phase 0 — Design (current, concurrent with Phase 1)

**Goal:** A coherent design document set that the next person to read can decide *in ten minutes* whether they want to be involved.

**Concurrency.** Phase 0 and Phase 1 run concurrently. Doc work and testbed work co-evolve, with the docs-never-drift discipline (see [CLAUDE.md](./CLAUDE.md)) keeping them in lockstep — every commit that touches a contract updates both. Phase 0 finishes when the docs stop moving under their own pressure; testbed work continues into Phase 1's exit.

**Artifacts:**

- [README.md](./README.md) — elevator pitch, mental model, status.
- [docs/manifesto.md](./docs/manifesto.md) — why this exists, why now, why this shape.
- [docs/governance.md](./docs/governance.md) — contribution norms, review responsibilities.
- [docs/prd.md](./docs/prd.md) — technical north star: data model, governance machinery, calibration, credit, adversary testbed.
- [docs/seed-topic.md](./docs/seed-topic.md) — first cause for the public instance, starter sub-topics, and rationale.

**Exit criterion:** the docs are stable enough that the testbed builds from them without surfacing further contradictions or underspecified load-bearing points. Adversarial review by capable models acts as a continuous pre-screen; outside-expert and friend review are welcome but not gating.

---

## Phase 1 — Adversary testbed (concurrent with Phase 0)

**Goal:** A simulation harness that runs the full governance regime against a synthetic adversarial population, with published results.

This is the unique technical asset of Anchorage and the cheapest credible artifact we can produce. **The exit from Phase 1 is the user-exposure gate** — no real users meet Anchorage until this phase's exit criterion is met. Phase 1 work runs concurrently with Phase 0 doc work.

**Scope:**

- Real graph schema (claim-graph substrate, multi-scale topic/sub-topic/claim, edges, anchors).
- Real write-path tools (the same tools the eventual public instance will expose).
- Real governance machinery: redundant peer review, calibration batches drawn from validated history, reputation scoring, staking.
- Synthetic contributor population spanning the taxonomy: honest-weak, honest-strong, lazy, hallucinator, strategic adversary, patient adversary, sybil farms, coalitions.
- Parameter sweeps and attack-success-rate measurements.

**Artifact:** the testbed code (open) and a public results post / paper documenting attack success rates against tunable defenses.

**Exit criterion:** governance changes are CI-checked against the adversary suite; the published results survive third-party replication.

---

## Phase 2 — Single-cause public instance

**Goal:** One umbrella cause running on Anchorage with real human contributors, two or three hand-seeded starter sub-topics, and a manuscript projection emerging from the first sub-topic to mature.

**Scope:**

- Auth, identity, per-(cause, sub-topic) reputation.
- The verifiable-anchor write path (PMID/DOI fetch, span verification, refusal of ungrounded citations).
- Frontier surfaces: cause-level (where sub-topics could productively open) and sub-topic-level (specific synthesis gaps).
- Review queue with calibration batches.
- Minimal manuscript projection: outline view tying sections to sub-topic subgraphs.
- Operational tooling: moderation, abuse-flagging, reviewer-fraud detection.

**Exit criterion:** the first sub-topic ships a manuscript projection with named contributors, traceable back to graph nodes, and the testbed catches at least one governance proposal that would have been an attack vector.

---

## Phase 3 — Second cause + protocol hardening

**Goal:** A second umbrella cause running on the same instance, validating that the protocol is cause-agnostic.

**Scope:**

- Sub-topic auto-discovery as a graph-derived feature (proposing tractable scope envelopes from graph state).
- Cross-cause reputation: how (or whether) reviewer credibility transfers between causes.
- Federated read; optional federated write.
- Manuscript-projection improvements: section-level claim provenance, citation export, reviewer comments tied to graph nodes.

**Exit criterion:** the second cause produces an independent manuscript projection without governance regressions on the first.

---

## Phase 4 — Independent fork

**Goal:** At least one institution we don't control runs an independent Anchorage instance with a different cause focus.

**Scope:** documentation, deployment story, governance handoff, federation contract.

**Exit criterion:** the independent instance is producing manuscript projections on its own cause, and protocol changes can be coordinated across instances without breaking either.

---

## What's deliberately *not* on this roadmap

- A token, marketplace, or paid tier.
- Generic chat or freeform-wiki features.
- Auto-merge of contested syntheses (the system surfaces them as `open_question` instead).
- Replacement for journal review or empirical research.
- Promises about specific timelines. Phases happen when their exit criteria are met.

---

## Status

Phase 0 + Phase 1, concurrent. Design docs are settled and the v0 MCP tool surface is implemented end-to-end as a TypeScript `Server` class — all 16 tools from the PRD, the curator-mediated acceptance path for every proposal kind, the assignment loop (capacity → request → accept → submit), the review path (`cast_review_vote`), and the read-path projections (`query_frontier`, `query_proposals`, `fetch_calibration_batch`). The contributor lifecycle composes correctly under test. MCP transport runs the same code paths a real client sees, and the testbed harness drives synthetic archetypes (honest contributors, honest and lazy reviewers, hallucinator, strategic-coalition reviewers) end-to-end through the wired surface — with reputation deltas, verifier rejections, and bias-driven convergence outcomes observable over the wire. The strategic-coalition scenario surfaces an open attack: pure-vote convergence + reputation-against-converged-outcome lets a 2-of-3 biased coalition flip both ledgers against an honest reviewer of well-grounded work. Calibration is wired as the rep-ledger defense (assignment-injected items drawn from validated history, scored on `cast_review_vote` against ground truth) and the testbed shows it costs the coalition rep on bias-misaligned items while crediting the honest reviewer. Calibration-aware convergence weights votes by per-(cause, sub-topic) calibration record and requires both a minimum distinct-reviewer count and a minimum weighted sum; with that flag on, the naive coalition can no longer drive a bias-aligned suppression of a well-grounded excerpt past the threshold — the convergence half of the attack closes against the naive archetype while the rep-ledger half stays inverted, the two layers compounding. Against the calibration-aware variant of the archetype (PRD §Calibration batches — bias narrow enough that the calibration corpus falls entirely outside the bias zone), both defenses go quiet by design — the coalition passes every calibration item, keeps full convergence weight, and reclaims rep dominance as well as suppression. Pool-size scaling closes that vector against any fixed-size coalition where the eligible honest reviewer pool is large enough: at threshold N a coalition of size < N cannot solo-drive convergence on either side, so K+1 honest reviewers outvote a K-member coalition. The minimum K+1-honest-reviewer regime is testbed-handled. The small-sub-topic case where the eligible pool can't furnish K+1 honest reviewers is now closed by stratified-by-history assignment: PRD §Reviewer assignment commits the v0 stratum primitive (vote-pattern co-occurrence cluster), the prefer-not-yet-represented-strata draw rule, and the stratification-degraded flag that tightens convergence thresholds when fewer than N strata are reachable; `request_assignment` and `resolveByConvergence` are wired to that partition. The testbed scenario shows the calibration-aware coalition that bypassed both calibration defenses failing here — once Carol and Dave have built shared vote-history, the cross-stratum draw routes Dave away from the contested proposal, and the bias-suppression vector closes against a 3-reviewer pool too small for K+1 honest. The next adversary variation is a coalition that vote-de-correlates on non-bias-zone proposals to stay below the cluster threshold; that's the obvious adaptation and the next testbed target on this seam.

Next milestones: vote-decorrelating coalition variant on the stratification seam; the remaining archetypes (patient adversary, sybil farms, coalitions across multiple proposals); and the parameter sweeps Phase 1's exit criterion calls for. Live-fetch verification (PMID/DOI/URL resolution and source caching) stays a stub until the testbed needs it; span verification is wired at the verifier seam and exercised by adversary scenarios.
