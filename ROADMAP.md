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

Phase 0 + Phase 1, concurrent. Design docs are settled and the v0 MCP tool surface is implemented end-to-end as a TypeScript `Server` class — all 16 tools from the PRD, the curator-mediated acceptance path for every proposal kind, the assignment loop (capacity → request → accept → submit), the review path (`cast_review_vote`), and the read-path projections (`query_frontier`, `query_proposals`, `fetch_calibration_batch`). The contributor lifecycle composes correctly under test. MCP transport runs the same code paths a real client sees, and the testbed harness drives synthetic archetypes (honest contributors, honest-weak contributors, honest and lazy reviewers, hallucinator, strategic-coalition reviewers) end-to-end through the wired surface — with reputation deltas, verifier rejections, and bias-driven convergence outcomes observable over the wire. The strategic-coalition scenario surfaces an open attack: pure-vote convergence + reputation-against-converged-outcome lets a 2-of-3 biased coalition flip both ledgers against an honest reviewer of well-grounded work. Calibration is wired as the rep-ledger defense (assignment-injected items drawn from validated history, scored on `cast_review_vote` against ground truth) and the testbed shows it costs the coalition rep on bias-misaligned items while crediting the honest reviewer. Calibration-aware convergence weights votes by per-(cause, sub-topic) calibration record and requires both a minimum distinct-reviewer count and a minimum weighted sum; with that flag on, the naive coalition can no longer drive a bias-aligned suppression of a well-grounded excerpt past the threshold — the convergence half of the attack closes against the naive archetype while the rep-ledger half stays inverted, the two layers compounding. Against the calibration-aware variant of the archetype (PRD §Calibration batches — bias narrow enough that the calibration corpus falls entirely outside the bias zone), both defenses go quiet by design — the coalition passes every calibration item, keeps full convergence weight, and reclaims rep dominance as well as suppression. Pool-size scaling closes that vector against any fixed-size coalition where the eligible honest reviewer pool is large enough: at threshold N a coalition of size < N cannot solo-drive convergence on either side, so K+1 honest reviewers outvote a K-member coalition. The minimum K+1-honest-reviewer regime is testbed-handled. The small-sub-topic case where the eligible pool can't furnish K+1 honest reviewers is now closed by stratified-by-history assignment: PRD §Reviewer assignment commits the v0 stratum primitive (vote-pattern co-occurrence cluster), the prefer-not-yet-represented-strata draw rule, and the stratification-degraded flag that tightens convergence thresholds when fewer than N strata are reachable; `request_assignment` and `resolveByConvergence` are wired to that partition. The testbed scenario shows the calibration-aware coalition that bypassed both calibration defenses failing here — once Carol and Dave have built shared vote-history, the cross-stratum draw routes Dave away from the contested proposal, and the bias-suppression vector closes against a 3-reviewer pool too small for K+1 honest. The vote-decorrelating coalition variant — Carol and Dave deliberately disagreeing on every non-bias-zone proposal so their pairwise agreement falls below the cluster threshold — is now also wired as a testbed scenario, and confirms what the v0 cluster primitive cannot catch: the coalition holds singleton strata, the cross-stratum gate has nothing to enforce, both members vote on the contested item, and the bias-suppression vector reopens. The seam is the cluster signal itself: vote co-occurrence is lossy in two opposite directions. Contention-weighted edges are now wired as the first refinement and close the *over-aggregation* failure mode — where unanimous priming history pulls honest reviewers into one cluster and the cross-stratum gate locks them out, while coalition members who skipped priming walk in through the gap. The over-aggregation testbed scenario shows the raw primitive driving the contested item to rejected (honest review strangled), and the contention-weighted companion shows it converging accepted (unanimous-easy priming carries 0 weight, no edges form, all five reviewers vote). Anti-correlation detection is now wired as the second refinement and closes the decorrelating-coalition bypass. The cluster computation treats systematic disagreement as a co-stratum edge alongside systematic agreement: a pair that votes opposite on every shared priming proposal lights up the disagreement metric the agreement metric can't see, gets pulled into one cluster, and the cross-stratum gate trips against the second coalition member when the first has already been routed. The testbed scenario for the decorrelating coalition closes at threshold 1.0 (perfect decorrelation). The mixed-strategy coalition that targets the *gap* between the two thresholds — a 50/50 vote pattern across shared priming, sitting below both — defeats either refinement individually but the *composition* (contention-weighted + anti-correlation, both on at threshold 1.0) closes it: contention weighting reweights the pair-stat so agreement on unanimous-easy items contributes 0 weight and disagreement on contentious items contributes the full weight, collapsing the weighted disagreement ratio back to 1.0. The testbed wires both halves: the mixed-strategy bypass open with each refinement alone, closed under the composition. The remaining seam is a coalition that avoids co-voting on any contentious item, which constrains them sharply (suppressing the contested target inherently creates a contentious item); whatever works around that constraint is the next testbed target.

The decline-pattern projection (PRD §Adversary testbed: "decline-pattern abuse — declining everything outside the adversary's preferred sub-topic") is now wired as a curator-side surface (`server.curator.declinePatterns(cause_id)`), with `min_offers` and `min_rate` filters that the curator picks per their threshold (operationally private). The testbed scenario shows a reviewer who declines everything outside their preferred shape surfacing at the top of the projection; an honest accept-all reviewer ranks at zero and is filtered out at any non-trivial `min_rate`. The divergence-closure mechanism PRD §Reviewer assignment commits is also now wired (`server.curator.archiveStaleProposals({ window_seconds, cause_id? })`): a staged proposal whose most recent vote is older than the window flips to `unresolved-archived`, the terminal status the contracts already declared but no path produced. Never-voted proposals are explicitly excluded — they're unstarted, not divergent. The sweep is idempotent (already-archived proposals are skipped on re-run) and curator-triggered, with the production scheduler kept operationally private.

A first parameter sweep is wired as the Phase-1-exit-criterion infrastructure pattern: a 3D cube over (coalition pattern ∈ {mixed, decorrelated}, anti-correlation threshold ∈ {0, 0.5, 1.0}, contention-weighted ∈ {off, on}) drives twelve it.each cells, each running the same end-to-end scenario through a shared `runDecorrelationScenario` helper and asserting the contested-status outcome. The matrix exercises all four corners of the closure: threshold 0 leaves every cell open; threshold 0.5 catches both patterns; threshold 1.0 closes the decorrelated pattern outright but only catches the mixed pattern under the contention-weighted composition (the matrix cell that was the standalone-test headline). The cube is now layered with an aggregate-attack-success-rate assertion that groups cells by defense config (anti-correlation threshold × contention-weighted) and asserts the per-config ASR — 100% with anti-correlation off, 0% at threshold 0.5, 50% at threshold 1.0 alone (the named gap), 0% under the composition. The aggregate is derived from the static expected-status fields the per-cell tests already validate, so it stays a fast read over locked observations rather than a re-run of the cube. The shape — named defense config to expected ASR, with a coverage invariant that catches uneven attack-pattern counts per group — is the template future sweeps follow as the cube widens.

Honest-weak is wired as the friction-rate archetype — structurally honest-strong with verifier-rejection tolerance, with competence modeled in the content provider rather than the loop. The friction-rate test pins the measurement: the fraction of attempts the verifier refuses is observable from the action log and matches the configured weakness exactly, sitting between honest-strong's 100% pass-through and the hallucinator's 0%. The same cost (a `submit_rejected` action, a burned rate slot, no proposal record) applies — the archetypes differ in intent and fraction, not mechanism.

The sybil-amplified coalition is now wired as the freshness-bypass scenario for stratification: an established Carol+Dave coalition (priming history detected by the cluster signal) recruits Eve, a fresh identity with no shared history. The cross-stratum gate fires correctly against Dave (Carol-already-routed + Carol-Dave co-stratum) but Eve sits in a singleton stratum and the gate has nothing to enforce against her; she walks in and casts the second reject vote. The contested target flips to rejected with three votes — Erin's accept, Carol's reject, Eve's reject — and Dave never votes. The pin is architectural: behavior-dependent defenses (cluster signal, calibration record, reputation) all require accumulated history per identity, so an operator that mints fresh identities and uses each exactly once routes around them by construction. PRD §Identity names identity-binding cost, rate-limited issuance, and global anti-abuse signals as the load-bearing defenses; none are wired in v0, and the testbed's surface cannot express them. The defense lives at a layer below — this scenario is the regression handle that says so.

Patient adversary is wired as a drift-bandwidth archetype — a calibration-aware biased reviewer running solo, priming through honest accepts on well-grounded excerpts and passes on the anchor calibration corpus, then drifting on a single contested target. The scenario stacks the strongest current defenses (calibration injection + calibration-aware convergence) and confirms the convergence half holds: the contested target converges to accepted because two honest reviewers reach the distinct-count + weighted-sum gate before the lone biased vote can find a partner.

Two-component reputation bookkeeping is now wired as the first half of the patient-adversary defense: every reputation event moves a slow-decay `demonstrated`-competence component and a fast-decay `recent`-activity component together, and `query_reputation` decays each component on read per its own half-life (PRD §Reputation). Half-lives are testbed-tuned config — `demonstrated_half_life_seconds` and `recent_half_life_seconds`, both defaulting to `Infinity` so existing scenarios (no time advanced) see identical pre-decay numbers on both fields and stay unaffected. The patient-adversary scenario is now the regression handle for the bookkeeping: immediately post-drift `demonstrated == recent`, but advancing the clock past several recent half-lives (Carol stops being recently active between drifts — the patient-adversary's defining behavior) drains `recent` toward zero while `demonstrated` is preserved. The gap is the lever an assignment-gating slice will consume; the gates themselves (eligibility tiers on `demonstrated`, assignment filters on `recent`) are the next iteration. Cumulative-buffer drift bandwidth (`demonstrated / reviewer_inaccurate_loss`) is unchanged from pre-decay v0 by construction — this slice paves the seam, the next slice closes it. `FakeClock.advance(ms)` is added so testbed scenarios can travel time deliberately on top of the per-call auto-tick.

Next milestones: assignment-time gating that consumes the recent-activity component (the second half of the patient-adversary defense, where the scenario's drift-bandwidth pin tightens); eligibility-tier gating that consumes demonstrated; broader sweeps that grow the cube (more attack patterns and more knob axes feeding the same aggregate-ASR shape); the remaining archetypes (coalitions across multiple proposals, the avoid-co-voting-on-contentious-items workaround the composition-closes-mixed-strategy seam names). Identity-cost / rate-limit / anti-abuse defenses for the sybil-amplified-coalition seam live below the wired surface and are the next architectural layer the design needs, not a testbed knob. Live-fetch verification (PMID/DOI/URL resolution and source caching) stays a stub until the testbed needs it; span verification is wired at the verifier seam and exercised by adversary scenarios.
