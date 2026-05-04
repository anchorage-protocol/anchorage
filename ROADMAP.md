# Roadmap

Anchorage is built phase by phase, with each phase producing a discrete artifact that's useful on its own and informs the next. This file is honest about what's planned, what's hand-waved, and what's load-bearing for everything else.

The roadmap is a living document. Phases will move; some will split or merge. What stays stable is the *order of dependencies*: each phase produces something the next phase needs, and we don't skip ahead.

---

## Phase 0 — Design (current)

**Goal:** A coherent design document set that the next person to read can decide *in ten minutes* whether they want to be involved.

**Artifacts:**

- [README.md](./README.md) — elevator pitch, mental model, status.
- [docs/manifesto.md](./docs/manifesto.md) — why this exists, why now, why this shape.
- [docs/governance.md](./docs/governance.md) — contribution norms, review responsibilities (skeleton; expanded in Phase 0.1).
- `docs/prd.md` — technical north star: data model, governance machinery, calibration, credit, adversary testbed (TBD).
- `docs/seed-topic.md` — first cause for the public instance, starter sub-topics, and rationale (TBD).

**Exit criterion:** the docs survive their first serious adversarial review by an outside expert.

---

## Phase 1 — Adversary testbed

**Goal:** A simulation harness that runs the full governance regime against a synthetic adversarial population, with published results.

This is the unique technical asset of Anchorage and the cheapest credible artifact we can produce. It is built before any user-facing code.

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

Phase 0, week 1.
