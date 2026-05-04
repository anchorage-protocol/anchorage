# Governance

> How contributions enter the graph, how disputes are resolved, how reputation is earned and lost, and how the rules themselves change.

This document is a **skeleton**. It captures the design we've committed to in principle; the operational details (specific calibration ratios, reputation formulas, reviewer-assignment algorithms, decay rates) are deliberately deferred to the [PRD](./prd.md) and to the adversary-testbed phase, where they will be tuned against simulation rather than guessed.

The principle: **the rules of the game are public; the enforcement details are operationally private only where exposure helps attackers without helping reviewers.**

---

## Roles

- **Contributor.** Anyone who proposes a node, edge, anchor, or synthesis. No prior reputation required to propose; reputation is required for proposals to merge into the canonical graph without staged review.
- **Reviewer.** A contributor who has accumulated enough reputation in a topic (and ideally in the relevant sub-topic) to evaluate others' proposals. Reviewer assignment is randomized within the eligible pool, salted with calibration items.
- **Curator.** A small set of trusted humans (initially: the maintainers) who handle edge cases the automated regime cannot: sub-topic creation in v0, dispute escalation, moderation of bad-faith behavior, governance proposals. Curator authority is bounded and auditable.
- **Maintainer.** Project-level role for the codebase and protocol. Distinct from per-cause curators.

---

## The contribution flow

1. **Propose.** A contributor uses the write-path tools to propose a node and its parent edges. Tool-level validation enforces verifiability (anchors must resolve to fetchable sources; excerpts must include a quoted span the system can match against the source).

2. **Stage.** The proposal lands in a staging layer attached to the canonical graph. It is visible, queryable, and citable as a proposal — but not yet part of the canonical graph.

3. **Review.** The proposal is assigned to N randomly selected reviewers from the eligible pool, with the assignment salted by calibration items drawn from the graph's own validated history. Reviewers vote with reasons; reasons themselves can become graph nodes (typically `open_question` or rejection rationale).

4. **Resolve.** If reviewers converge, the proposal merges. If they diverge, the divergence becomes signal: either the proposal is reformulated (often by adding a hidden assumption as an explicit parent), or the system carries it forward as two parallel synthesis nodes that coexist until evidence resolves them, or the contested point becomes an `open_question`.

5. **Settle.** Once merged, the proposal accrues reputation to its contributor and to reviewers who evaluated it correctly. Later supersedes events update reputation in both directions.

---

## Reputation

- **Anchored at the cause level.** A contributor's reputation is a property of (contributor, cause), not of the contributor globally. Expertise is not interchangeable across causes.
- **Refined by sub-topic.** The system tracks which sub-topics a contributor has worked in. A colon-screening expert is not interchangeable with a CRC microbiome researcher even within the same cause.
- **Earned through confirmed contributions and accurate reviews.** Both proposing nodes that survive *and* reviewing accurately count.
- **Lost through reverted contributions and inaccurate reviews.** When a contribution is later superseded for being wrong (not for being refined), or a reviewer accepts a proposal that gets reverted, reputation decreases.
- **Per-topic, non-transferable, non-monetizable.** Reputation is not a token. It cannot be sold, transferred, or pooled. It exists only as a coordination signal within the system.
- **Slow-moving.** Reputation changes are tuned to reward consistency, not bursts. Specific decay rates and weights are tuned against simulation.

---

## Calibration

Reviewer assignments include items the system already knows the answer to — drawn from the graph's own validated history and indistinguishable from real frontier work. Reviewers who fail calibration lose reputation; the calibration corpus grows as the graph grows.

**Specific calibration items in active rotation are operationally private.** Published items get burned. Methodology is fully public; specific tuning is not.

---

## Sub-topic creation

In **v0 of any new cause**, sub-topic creation requires curator approval. Anyone can *propose* a sub-topic; curators evaluate it for tractability (corpus density, anchor coverage, projected closure distance) and either accept it as an active sub-topic or defer it.

In **later phases**, sub-topic auto-discovery becomes a graph-derived feature: the system surfaces tractable scope envelopes from graph state, with curator review remaining as a check rather than a gate.

This avoids the failure mode where bad sub-topics fragment effort.

---

## Disputes

Most disputes resolve at the proposal level: redundant review, divergence-as-signal, parallel synthesis nodes for genuine disagreement. The cases that escalate:

- **Bad-faith behavior** (sybil farms, coordinated reputation farming, persistent ungrounded citation): handled by curator review with documented action; specific moderation actions are logged but not all public.
- **Governance disagreement** (a contributor or reviewer disagrees with how the regime itself works): handled through the governance-change process below, not through individual disputes.

---

## Governance change

Anchorage's governance is itself code. Changes to the governance regime — calibration ratios, reputation formulas, reviewer-assignment algorithms, sub-topic-creation rules — are made through pull requests against the protocol repository.

Crucially: **every governance change is run against the adversary testbed before merging.** This is the project's continuous-integration story for governance. Wikipedia debates policy changes for years because it cannot test them; Anchorage tests them in an afternoon. Proposals that fail simulation against known attacks do not merge.

This is the load-bearing part of why the testbed is built first.

---

## Operationally private vs publicly governed

Public:

- The protocol code.
- The data model.
- The write-path tools.
- The reputation logic, including formulas.
- The reviewer-assignment methodology.
- The criteria for sub-topic creation and curator action.
- All committed graph state on the public instance.

Operationally private:

- Specific calibration items in active rotation (they get burned when published).
- Specific abuse signals and reviewer-fraud heuristics in production (methodology public; tuning specific to deployments).
- Specific moderation actions where exposure would aid evasion.

The principle is that exposure should help reviewers more than it helps attackers. When that asymmetry holds, things are public. When it doesn't, they're not.

---

## What this document will become

This is the skeleton. The full governance specification — with concrete parameter ranges, reviewer-assignment pseudocode, and the formal definition of the calibration regime — lives in the [PRD](./prd.md) and will be tuned against the adversary testbed in Phase 1.

Operational governance for the running public instance — moderation guidelines, escalation paths, named curator responsibilities — will be added once the instance exists.
