# Governance

> How contributions enter the graph, how disputes are resolved, how reputation is earned and lost, and how the rules themselves change.

This document captures the governance design we've committed to in principle and how it operates today; the quantitative operational details (specific calibration ratios, reputation formulas, reviewer-assignment algorithms, decay rates) live in the [PRD](./prd.md) and were tuned against the adversary testbed across Phase 1 (closed 2026-05-14) rather than guessed. Where a commitment here is not yet built, the [v0 operating reality](#what-is-committed-vs-what-is-deployed-v0-operating-reality) section below says so plainly.

The principle: **the rules of the game are public; the enforcement details are operationally private only where exposure helps attackers without helping reviewers.**

---

## Identity, briefly

Anchorage supports stable pseudonymous participation while retaining bounded identities-per-real-person via low-friction third-party identity (email + OIDC). Pseudonyms are public; the binding to identity-establishing credentials is private and used by curators only under documented escalation. Named credit on manuscript projections is opt-in — pseudonymous credit is permitted but discouraged for high-impact projections, where academic legibility favors real names. Revocation invalidates future participation without rewriting graph history. Public reputation is per-cause; anti-abuse signals are global-per-identity, documented and audited. The full requirements sketch lives in the [PRD](./prd.md#identity).

---

## Roles

- **Contributor.** Anyone who proposes a node, edge, anchor, or synthesis. No prior reputation required to propose. Every proposal stages and is reviewed — reputation does not buy a *bypass* of staged review; what it gates is whether a staged proposal advances into the review queue automatically (above threshold) or waits on curator action (below it). See [PRD §The contribution flow](./prd.md#the-contribution-flow) and §Verification engine (Reputation gates).
- **Reviewer.** A contributor who has accumulated enough reputation in a topic (and ideally in the relevant sub-topic) to evaluate others' proposals. Reviewer assignment is randomized within the eligible pool, salted with calibration items.
- **Curator.** A small set of trusted humans (initially: the maintainers) who handle edge cases the automated regime cannot: sub-topic creation in v0, dispute escalation, moderation of bad-faith behavior, governance proposals. Curator authority is bounded, auditable, and revocable: every curator action is logged in a tamper-evident audit log; affected contributors see *that* an action occurred and the broad category, with specific signals redacted only where exposure would aid evasion; a separate auditor role periodically samples curator actions for review; cause-level curators can be removed through a documented process (multi-curator vote in early phases, broader contributor input as the cause matures). Wikipedia's hardest governance arm is curator capture and accountability — the design accepts that a single-curator-trust-point is unacceptable and that audit + removal need to exist before they are needed.
- **Auditor.** A rotating role (filled by curators of *other* causes, or by senior reviewers nominated for the role) that periodically samples curator actions and surfaces irregular patterns. Auditors do not overturn individual actions but can trigger curator-removal processes.
- **Maintainer.** Project-level role for the codebase and protocol. Distinct from per-cause curators.

### What is committed vs. what is deployed (v0 operating reality)

The Curator and Auditor descriptions above are governance *commitments* — the accountability machinery the design holds itself to before scale, stated in the present tense because they are load-bearing for the trust story. They are not all built yet, and honesty about the gap matters more than the tense:

- **The tamper-evident audit log does not exist yet.** Today the runtime's structured logging covers page views, the re-verification scheduler, and OAuth events — not a signed, append-only ledger of curator actions. The audit log is a commitment, not a current property.
- **The Auditor role is unfilled, and multi-curator mechanisms are vacuous at one curator.** The live instance runs with a single maintainer-curator, so "removal by multi-curator vote", "an auditor samples curator actions", and "multi-curator approval to loosen a threshold" describe a future state, not the present one. At v0 the curator is a unilateral accept/reject/revoke/escalate authority; the check on it is that the data and code are open (AGPL + CC-BY-SA) and the graph is public, so curator actions are externally observable even without the formal log.
- **These are commitments-before-scale by design.** The accountability machinery is sized for a multi-curator, multi-cause instance; it is built as the contributor base grows past what a single trusted operator can be transparent about by hand. Building it before there is anyone to hold accountable would be fake-mature signal. The commitment is that it lands before the instance relies on more than one curator's good faith — not that it already has.

---

## The contribution flow

The default flow is *assignment-driven*: the system assigns work from the frontier, and reputation accrues on assigned work. A contributor-initiated path exists for genuinely novel proposals but with weaker rep weighting. The shape:

1. **Assignment.** The contributor requests work; the system draws a frontier task across all sub-topics in the cause on frontier priority alone — no expertise matching, no declared capacity. A contributor holds one assignment slot per cause, held the moment it is returned — there is no accept step and no decline. A task that cannot be honestly completed (a source that will not resolve, a lapsed precondition) resolves as its own correct negative result rather than being refused, so selectivity has no surface to act on. The single slot is itself the only availability signal — there is no shopping list, which is what closes the rep-laundering vector.

2. **Submit.** The contributor submits work via the assigned-proposal tool; verification (grounding, lineage, rate) gates the submission synchronously.

3. **Stage.** The proposal lands in a staging layer attached to the canonical graph. It is visible, queryable, and citable as a proposal — but not yet part of the canonical graph.

4. **Review.** The proposal is assigned to N reviewers drawn from the eligible pool of the proposal's home sub-topic (or target sub-topic, for membership claims), with the assignment salted by calibration items drawn from the graph's own validated history. Reviewers vote with reasons; reasons themselves can become graph nodes (typically `open_question` or rejection rationale).

5. **Resolve.** If reviewers converge, the proposal merges. If they diverge, the divergence becomes signal: either the proposal is reformulated (often by adding a hidden assumption as an explicit parent), or the system carries it forward as two parallel synthesis nodes that coexist until evidence resolves them, or the contested point becomes an `open_question`. Long-unresolved divergences archive rather than re-route indefinitely.

6. **Settle.** Once merged, the proposal accrues reputation to its contributor and to reviewers who evaluated it correctly. Reputation gain is weighted by claim difficulty and by whether the work was assignment-driven (full weight) or contributor-initiated (reduced weight, conditional on independent confirmation). Later supersedes events update reputation in both directions.

The contributor-initiated path skips step 1 and weights step 6 lower. It exists so genuine novel synthesis is not bottlenecked by the system's frontier model — but it is not the default.

---

## Reputation

Reputation is structured around a real trilemma — slow decay rewards consistency but enables stockpiling, fast decay punishes episodic experts, review-as-staking selects against ambition. The design acknowledges this directly rather than tuning around it.

- **Two-component.** Slow-decay *demonstrated-competence* gates eligibility tiers; fast-decay *recent-activity* gates review assignment. Stockpiles don't translate into review authority without current presence.
- **Anchored at the cause level, refined by sub-topic.** Cause-level reputation gets a contributor in the door to *propose* anywhere within the cause. Reviewer eligibility in a contested sub-topic requires demonstrated work *in that sub-topic*. Easy-sub-topic credibility does not parlay into reviewer authority over contested ones.
- **Earned through confirmed contributions and accurate reviews.** Both proposing nodes that survive *and* reviewing accurately count.
- **Lost through reverted contributions and inaccurate reviews.** Supersedes by other contributors (not self-supersedes) and failed calibration items decrease reputation.
- **Review-credit normalized by claim difficulty.** Engaging hard syntheses is not dominated by rubber-stamping easy ones.
- **Eligibility tiers public; numeric reputation private.** Tiers communicate what's possible; raw numbers don't become leaderboards.
- **Per-topic, non-transferable, non-monetizable.** Reputation is not a token. Coordination signal only.
- **Slow-moving.** Reputation changes reward consistency over bursts. Specific decay rates and weights are tuned against simulation.

The full structure, including the two-component model and the difficulty-normalized review-credit shape, lives in the [PRD](./prd.md#reputation).

---

## Calibration

Reviewer assignments include items the system already knows the answer to — drawn from the graph's own validated history. They are intended to be indistinguishable from real frontier work to a reviewer evaluating one batch; defenses against patient adversaries observing many batches (rotation regime, sampling distribution) are part of the methodology and live in the [PRD](./prd.md#calibration-batches). Reviewers who fail calibration lose reputation; the calibration corpus grows as the graph grows.

**Specific calibration items in active rotation are operationally private.** Published items get burned. Methodology is fully public; specific tuning is not.

---

## Sub-topic creation

In **v0 of any new cause**, sub-topic creation requires curator approval. Anyone can *propose* a sub-topic; curators evaluate it for tractability (corpus density, anchor coverage, projected closure distance) and either accept it as an active sub-topic or defer it.

In **later phases**, sub-topic auto-discovery becomes a graph-derived feature: the system surfaces tractable scope envelopes from graph state, with curator review remaining as a check rather than a gate.

This avoids the failure mode where bad sub-topics fragment effort.

---

## Disputes

Most disputes resolve at the proposal level: redundant review, divergence-as-signal, parallel synthesis nodes for genuine disagreement. The cases that escalate:

- **Bad-faith behavior** (sybil farms, coordinated reputation farming, persistent ungrounded citation): handled by curator review with documented action; specific moderation actions are logged in the tamper-evident audit log, with affected contributors notified of the action category and specific signals redacted only where exposure would aid evasion. Aggregate moderation reporting (counts and categories per period) is published.
- **Governance disagreement** (a contributor or reviewer disagrees with how the regime itself works): handled through the governance-change process below, not through individual disputes.

---

## Governance change

Anchorage's governance is itself code. Changes to the governance regime — calibration ratios, reputation formulas, reviewer-assignment algorithms, sub-topic-creation rules — are made through pull requests against the protocol repository.

Crucially: **every governance change is run against the adversary testbed before merging.** This is the project's continuous-integration story for governance. Wikipedia debates policy changes for years because it cannot test them; Anchorage tests them on a fast loop for the cheap-attack threat surface, with a slower deep loop for frontier-model adversaries. Proposals that fail simulation against known attacks do not merge. The threshold definitions for "passing" are themselves versioned and require multi-curator approval to loosen — see [PRD](./prd.md#continuous-integration).

This is the load-bearing part of why the testbed is built first.

---

## Operationally private vs publicly governed

Public:

- The protocol code.
- The data model.
- The write-path tools.
- The reputation logic, including formulas (individual numeric reputation values are private; eligibility tiers are public).
- The reviewer-assignment methodology.
- The criteria for sub-topic creation and curator action.
- The curator-action audit log (selectively redacted — affected contributors see action category; specific signals redacted only where exposure aids evasion).
- Aggregate moderation transparency reports (counts and categories per period).
- All committed graph state on the public instance.

Operationally private:

- Specific calibration items in active rotation (they get burned when published).
- Specific abuse signals and reviewer-fraud heuristics in production (methodology public; tuning specific to deployments).
- Specific moderation actions where exposure would aid evasion.

The principle is that exposure should help reviewers more than it helps attackers. When that asymmetry holds, things are public. When it doesn't, they're not.

---

## Where the rest of the governance design lives

The full governance specification — concrete parameter ranges, reviewer-assignment pseudocode, the formal definition of the calibration regime — lives in the [PRD](./prd.md), and was tuned against the adversary testbed across Phase 1 (closed 2026-05-14); the testbed remains the regression handle for any subsequent governance change.

The public instance is live (`anchorage.science` / `mcp.anchorage.science`, since 2026-05-16). Operational governance for it runs at the v0 posture described under [What is committed vs. what is deployed](#what-is-committed-vs-what-is-deployed-v0-operating-reality): a single maintainer-curator, moderation via the `curator_*` MCP tools, network-gated curator console, and the accountability machinery (audit log, auditor role, multi-curator removal) committed for when the contributor base outgrows a single trusted operator. The named-curator-responsibilities and formal escalation-path documents land alongside that machinery, before the instance relies on more than one curator.
