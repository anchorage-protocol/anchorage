# Anchorage Phase 1 results — adversary testbed snapshot

> Snapshot as of **2026-05-21** (supersedes the 2026-05-19 reading). License: CC BY-SA 4.0 (text and tables) / AGPL-3.0 (the testbed code that produced them). This document is a point-in-time report of what the Anchorage adversary testbed measured, not a living spec — the testbed itself ([`packages/server/src/testbed.test.ts`](../packages/server/src/testbed.test.ts) for scripted populations, [`packages/server/src/run-deep-loop-cube.ts`](../packages/server/src/run-deep-loop-cube.ts) for the model-backed cube) is the durable artifact; this file freezes one reading from it.
>
> **Why this re-snapshot.** The `request_assignment` assigned/idle reshape ([PRD §Write-path tools, "Assignment"](./prd.md#write-path-tools)) changed the contributor-visible wire shape: frontier exhaustion is now a structured `status: 'idle'` response (with the cause's active sub-topics + their `scope_query` + an orientation string pointing at the propose_* off-slot path) rather than a `not_found` error. The connect-time MCP `instructions` paragraph picks up the idle-switch-modes branch so a freshly-connected agent sees it before any tool call. Both alter what the model-backed agents see, so the deep-loop cassette and all 11 model-backed cube cells were re-recorded 2026-05-21 (the `golden-live-honest` cassette was also re-recorded; the scripted-fetch tests in `cassette-replay.test.ts` record-and-replay in the same test run and required only an assertion update). LLM sampling is non-deterministic — each re-record is a fresh draw, not a re-run — so the per-cell tallies and the model-backed ASR below differ from the 2026-05-19 reading. **The scripted tier and every byte-for-byte scientific pin (`population-loop.test.ts`, `testbed.test.ts`) are unaffected and unchanged**; only the model-backed regression baseline was re-drawn.
>
> The shifts in this re-record are larger than the prior cycle's, and the cause separates cleanly:
> 1. **A genuine new behaviour: spontaneous proposing after frontier exhaustion.** The idle response carries guidance pointing at the propose_* tools, and several agents in several cells acted on it — landing real `propose_synthesis` and `propose_open_question` work that the prior baseline never produced. Two cells (`borderline-surrogate`, `borderline-contested-r2`) record 3-5 synthesis nodes and 2-3 open-question nodes from this path; one cell (`borderline-surrogate`) terminates `rounds_exhausted` rather than `frontier_drained` because the spontaneous-propose loop keeps generating fresh frontier items. This is the intended UX: idle ≠ done.
> 2. **Compounded with LLM sampling non-determinism, the contested-outcome cells re-shuffled.** The 2026-05-19 reading had `borderline-contested` + `borderline-contested-v2` as the two failure cells (ASR 2/11 = 18%, both via auto-close-accept on the verb-swap drift). The 2026-05-21 reading has only `borderline-contested-v1` failing (ASR 1/11 = 9%) — also via auto-close-accept, structurally the same path. The verb-swap drift now *closes* on the v0 cell (`borderline-contested`); the strict-v1 stack cell (`borderline-contested-v2`) now also closes. The failure path the prior snapshot recorded on v0/v2 reappears on v1 in this snapshot. These are different draws of the same underlying landscape, not a structural change.
>
> The cube cost rose from ~$10 to **~$17.71** for the full re-record. The increased burn is the agents trying spontaneous `propose_anchor` after the frontier exhausts and occasionally tripping on `external_ref` schema (model sends a stringified-JSON instead of an object): turns that would have been a clean termination in the prior baseline become 8-16 turns of mis-formatted retries before the agent moves on or hits `max_turns`. The failure mode is a real signal — it argues for either a tightened tool-description example on `external_ref` or a less anchor-centric guidance string — but it does not affect server-state outcomes; the cube cells still record the contested-item closure properties the per-cell assertions pin.
>
> **The 2026-05-19 and 2026-05-18 and 2026-05-14 readings are retained in git history.**

## Summary

The Anchorage adversary testbed runs the full v0 governance regime against synthetic adversarial populations — both **scripted** (deterministic deciders driving the wired MCP write-path tools) and **model-backed** (real Claude agents over the Anthropic Messages API, recorded into checked-in cassettes that replay byte-deterministically in CI). The cube layer measures attack-success-rate (ASR) per defense config across every named axis in [PRD §What's deliberately not specified](./prd.md#whats-deliberately-not-specified): calibration density, reviewer pool size, vote-aggregation thresholds, reputation decay rates, identity-cost composition, difficulty-aware credit, plus the (stratification × threshold), (decay × cluster-signal), and (alpha × stratification × demonstrated-decay) compositions where axes interact. 19 distinct sweep cubes are wired (18 scripted parameter-sweep cubes, PRD-enumerated #1-#18, + 1 model-backed). Every named adversary archetype in [PRD §Adversary taxonomy](./prd.md#adversary-taxonomy) has scripted-tier coverage; the deep loop adds model-backed honest-strong, patient adversary, and strategic adversary.

The headline reading: **redundant peer review with calibration-aware convergence + stratified-by-history assignment + the four-layer sybil-resistance composition (binding cost / issuance cap / per-identity rate-limit / cluster-signal × budget) closes every coalition pattern the testbed has constructed against it on the scripted tier**, with the model-backed cube confirming the closures hold against real-LLM honest pools and adversaries on the deep loop's small-population fixture. The model-backed cube still records a closure failure on a borderline-contested item under one closure-stack configuration: in the 2026-05-21 reading the verb-swap drift fails on `borderline-contested-v1` (adversary drift accept + a confused honest accept hitting `votes_to_accept=2` on the auto-close path before the v1 escalation tiebreak could see the item — v1's narrower knobs (`escalation_revise_counts_as_reject` only) govern escalation, not the auto-close threshold). The bare v0 cell (`borderline-contested`), the strict-v1 cell (`borderline-contested-v2`), the v3 cell (`borderline-contested-v3`), and the two paired rollouts (`borderline-contested-r2`/`-r3`) all *close* in this reading. The model-backed attack-success-rate is 1/11 (≈9%), down from 2/11 in the 2026-05-19 reading — the failure cell moved from v0/v2 to v1, the failure path stayed structurally identical (auto-close-accept on the normal vote path). These failures motivated three `ReviewConfig` knobs (`escalation_revise_counts_as_reject`, `escalation_requires_votes_to_accept`, `contested_votes_to_accept`) forming a v3 stack; the load-bearing v0/v1/v3 deltas are pinned byte-for-byte at the harness level by scripted-decider pairs in [`population-loop.test.ts`](../packages/server/src/population-loop.test.ts) (unaffected by the reshape and the re-record) and corroborated at the real-model level by the `borderline-contested-v3` cube cell (`rejected`). The dominant failure path (auto-close-accept) is exactly the one `contested_votes_to_accept` (v3) closes. **No open closure failure remains in the cube as of this snapshot** — every recorded failure path has a v3 closure pinned against scripted deciders.

The Phase 1 ROADMAP language called for "third-party replication" of these results; that criterion was a category error borrowed from conventional scientific publishing. Anchorage's testbed is by-construction simulatable: cassettes pin every byte across the wire, the model is a published API (`claude-haiku-4-5-20251001` and `claude-sonnet-4-6` both replay deterministically from cassette), the code is open. A third-party rerun is *literally the same operation* as an in-house rerun. Reproducibility is what's load-bearing, and is satisfied by the artifacts in this repository; replication of any cube cell or extension to new cells is incremental work in the same testbed. The reproduce instructions are at the bottom of this doc.

## Methodology

**Testbed shape.** The testbed talks to the server *only over MCP*, by build-system construction — `packages/testbed` declares no path to `packages/server` internals; the synthetic populations exercise the same surface a real client (Claude Desktop, Cursor, custom agent) would. Every archetype, scripted or model-backed, calls the production write-path tools (`request_assignment`, `propose_*`, `cast_review_vote`, etc.) and reads from the production query tools (`query_frontier`, `query_proposals`, `fetch_calibration_batch`, `query_reputation`). This is what makes the sim≡prod equivalence load-bearing: there is no `if (sim) ...` branching anywhere in the codebase, ever — the only difference between sim and prod is who is on the other end of the connection. Testbed results transfer to production by construction.

**Two tiers.**
- **Scripted (fast loop)** — deterministic deciders drive the same wired surface. Every PR runs the full scripted cube layer in CI (`pnpm test`). Cheap, deterministic, run thousands of times per release. The scripted tier carries the bulk of regression coverage.
- **Model-backed (deep loop)** — real Claude agents over the Anthropic Messages API. The role is carried entirely in the agent's *system prompt* (the loop is role-blind). Recordings live as *cassettes* at `packages/server/test/fixtures/golden-*.json` (sha256-keyed by request body); replay is byte-deterministic and key-free. Default model: `claude-haiku-4-5-20251001`. A typical deep-loop cube cell records at ~$0.40-1.20.

**Cassette cadence.** The model-backed cassettes pin a *behavioral regression baseline*, not a per-commit unit invariant — running the full re-cohort on every cosmetic change to a tool description or guidance string turns the cube into a tax on polish rather than a guard against regressions. The cadence is split:
- The **cheap pair** (`golden-cassette.test.ts` + `golden-deep-loop.test.ts`, ~$1 to re-record together) runs in default CI on every commit. Cheap, fast, validates basic flows.
- The **cube** (`golden-deep-loop-cube.test.ts`, 11 parameter-sweep cells, ~$15-18 full re-cohort) is opt-in via `ANCHORAGE_CUBE_CASSETTE=1`. Run it on cadence — before substantive tool-shape changes ship (release-time gate), not per PR. The scripted byte-for-byte science in [`population-loop.test.ts`](../packages/server/src/population-loop.test.ts) guards the load-bearing closures regardless, so the per-commit cube signal is not load-bearing. What still triggers a cube re-cohort: input/output schema changes, MCP tool surface additions/removals, behavior changes that *should* shift model decisions. Cosmetic clarifications (parameter examples, schema notes, ordering reshuffles that don't change available actions) skip the re-record.

**Cube layer.** Each cube sweeps one or more *defense parameters* against a fixed *attack pattern*, reads the attack-success-rate (and lockout-rate where the failure mode is honest-pool collapse rather than attack pass-through), and asserts the load-bearing shape — usually "ASR < ε with the named defense on, ASR ≥ T with it off, monotone between". Cubes are CI assertions, not separate runs: every PR runs them.

**Closure-stack discipline.** When the model-backed cube records a closure failure (the system letting an attack through that the scripted cube didn't predict), the response is a new opt-in `ReviewConfig` knob with `default = v0-preserves-everything`, a *byte-for-byte harness pair* in `population-loop.test.ts` against scripted deciders pinning the load-bearing v_n / v_{n-1} delta, and a dedicated cube cell as the real-model regression baseline. Three closure-stack knobs landed this way (v1: `escalation_revise_counts_as_reject`; v2: `escalation_requires_votes_to_accept`; v3: `contested_votes_to_accept`), each closing a specific failure path the model-backed loop surfaced.

## Coverage

### Adversary archetypes ([PRD §Adversary taxonomy](./prd.md#adversary-taxonomy))

| Archetype | Scripted | Model-backed |
|---|---|---|
| Honest-weak | `runHonestWeak` (friction-rate test) | n/a (PRD frames as small local model; deep loop is frontier-only) |
| Honest-strong | `runHonestStrong` (proposer/honest pool in ~20 cubes) | `honestStrongRole` (every deep-loop cube cell runs 2) |
| Lazy | `acceptAllDecider` (caught by reviewer-as-staking; see correction note below) | n/a (calibration scoring exercised via patient-adversary cells) |
| Hallucinator | `runHallucinator` (verifier-rejection) | n/a (caught pre-review at the verifier seam) |
| Strategic adversary | strategic-coalition cubes #1-#4 + variants | `strategicAdversaryRole` (cube cells `strategic-adversary`, `borderline-contested`, `borderline-surrogate`, `borderline-subgroup`, `borderline-contested-v1/v2/v3/r2/r3`) |
| Patient adversary | testbed two-component drain + assignment-gate refusal | `patientAdversaryRole` (cube cells `calibration-on/off` + `golden-deep-loop` replay) |
| Sybil farm | sybil-amplified-coalition + binding-cost + rate-limit + cross-cause clustering + adversary-budget primitive | n/a (sybil resistance is sub-MCP; no model surface) |
| Coalition (multi-variant) | decorrelating, unanimous-priming, anti-correlation, mixed-strategy, contention-weighted+anti-correlation | n/a (coordination is structural, not behavioral) |

The scripted/model-backed split mirrors the PRD's design partition: archetypes whose distinguishing behavior is *structural* (coalition coordination, sybil minting, hallucination caught at the verifier) are scripted-only by design; archetypes whose distinguishing behavior is *judgment under partial information* (patient drift, strategic borderline-defense) are where the model-backed tier earns its keep. Honest-weak and lazy are scripted-only because their named defense is exercised in scripted form on the same surface, and the model-backed tier would add no signal.

*Correction (2026-06-12).* The original table attributed the lazy accept-biased archetype's closure to calibration. That attribution was wrong: the v0 calibration corpus is accept-only ground truth, so an indiscriminate accepter passes every calibration item by construction. What actually catches `acceptAllDecider` in these runs — and what the relevant scripted assertions in fact pin ("rep moves down when honest rejecters converge") — is **reviewer-as-staking**. Calibration meters reject-bias and drift. PRD §Calibration batches now records this precisely, along with the committed redesign (staged calibration copies with reject-expected distractors) that brings the accept-biased form into calibration's reach.

### Defense axes ([PRD §What's deliberately not specified](./prd.md#whats-deliberately-not-specified))

| Axis | Cube(s) |
|---|---|
| Calibration density (ratios) | #8 + #11 (density-floor scaling at two resolutions) + #14 (corpus-composition contamination) |
| Reviewer pool sizes | #9 (graceful-degradation on cluster-signal closure) |
| Vote-aggregation thresholds | #10 (threshold-axis decomposition on K+1-honest dynamic) + #12 (stratification × threshold composition) |
| Reputation formula constants — recent-window decay | #13 (ratio-invariance on recent W/T closure) |
| Reputation formula constants — demonstrated-window decay | #15 (ratio-invariance on demonstrated W/T closure) |
| Identity-cost composition (B/N/T layers) | #4 (budget cost-multiplier B×T×N) + #5 (multi-epoch B×E×N) + #6 (action-axis M×T×E) + #7 (cluster-signal × budget) |
| Difficulty-aware review credit (alpha) | #3 (recent-gate closure on patient archetype) + #18 (stratification closure on coalition archetype) |
| Curator-side visibility | #17 (cross-cause identity-clustering projection) |
| (decay × cluster-signal) composition | #16 (gate-design role-separation on multi-round timed-coalition) |
| Closure-stack version on borderline contested | model-backed cube `borderline-contested-v1/v2/v3` + scripted-decider harness pairs in `population-loop.test.ts` |
| Contested-item severity (model-backed) | model-backed cube `borderline-contested` (verb-swap) + `borderline-surrogate` (surrogate-substitution) + `borderline-subgroup` (generalization-from-subgroup) + sampling rollouts `r2`/`r3` |

Every axis named in PRD §What's deliberately not specified has measured cube coverage.

## Headline findings

The full per-cube findings are in the test file's headers (each cube's `it(...)` block opens with a multi-paragraph commentary describing what was measured and what closed). The summary below picks out the load-bearing structural results.

**1. Redundant review + calibration is the base layer; both halves are needed.** The naive 2-of-3 strategic coalition flips both vote convergence and rep ledger against an honest reviewer of well-grounded work (cube #1 baseline, ASR ≈ 100% with no defense). Calibration-on-its-own catches the rep-ledger half (the coalition burns rep on bias-misaligned calibration items) but not the convergence half. Calibration-aware convergence (vote-weight by per-(cause, sub-topic) calibration record + minimum distinct-reviewer floor) closes the convergence half; the two compound into closure of the naive archetype. Against the *calibration-aware variant* (bias narrow enough that the calibration corpus falls outside the bias zone) both defenses go quiet — closing this requires the next layers.

**2. Pool-size scaling closes any fixed-K coalition where the eligible honest pool is ≥ K+1 (cube #9).** This handles the "minimum K+1-honest-reviewer regime" — the regime where the honest pool can outvote a bounded coalition.

**3. Stratified-by-history assignment closes the small-pool case (cube #12, (stratification × threshold) composition).** When the eligible pool can't furnish K+1 honest reviewers, vote-pattern co-occurrence clustering routes coalition members away from each other's contested proposals. The v0 cluster primitive falls to a vote-decorrelating coalition (singleton strata). The two refinements that close the bypass: contention-weighted edges (closes over-aggregation, where unanimous priming pulls honest reviewers into one cluster) and anti-correlation detection (closes the decorrelating bypass at threshold 1.0). The mixed-strategy coalition that targets the gap between the two thresholds is closed only by their *composition* — neither refinement alone catches it.

**4. The four-layer sybil-resistance architecture closes the named sybil patterns (cubes #4-#7).** Identity binding cost (B), the issuance-frequency cap (N), per-identity rate-limited tickets (T), and the cluster-signal × budget composition. Cube #4 reads the cost-multiplier on one-shot suppression (B × T × N), #5 the multi-epoch extension (B × E × N), #6 the action-axis sibling (M × T × E), and #7 the full cluster-signal × binding-cost composition on the sybil-amplified coordinated-voting pattern. The curator-side *visibility* layer (cross-cause identity-clustering projection, PRD §Identity bullet 4) is measured separately by cube #17. (The earlier decline-coalition / encounter-domain layer and its decline-pattern projection were retired with the single-slot reshape — `decline_assignment` no longer exists, so the abuse they watched cannot occur.)

**5. Difficulty-aware review credit (alpha) re-baselines two closures (cube #3 patient, cube #18 coalition).** The naive credit formula's threshold derivations assume alpha=1; under alpha=0.5 the same closure mechanism goes from full-honest-defense to lockout. Cube #3 reads the patient case and pins the recent-gate closure under the re-tuned threshold; cube #18 does the same for the coalition case (alpha × stratification × demonstrated-threshold) and pins the stratification closure.

**6. The model-backed deep-loop cube confirmed the scripted closures hold against real-LLM populations and continues to surface auto-close-accept on the borderline-contested item, closed by v3.** The strategic adversary is handed a genuinely borderline contested claim (source uses observational "associated with" framing; pre-staged claim swaps it for causal "increases"). In the 2026-05-21 reading **1 of 11** cube cells records auto-close-accept on the contested item: `borderline-contested-v1` (adversary drift accept + a confused honest accept hitting `votes_to_accept=2` before the v1 escalation tiebreak could see the item). The verb-swap-on-v0 cell itself (`borderline-contested`) and its paired rollouts (`borderline-contested-r2`/`-r3`) all *close* in this reading; the strict-v1 cell (`borderline-contested-v2`) also closes. Across the three snapshots that have read the verb-swap trio (2026-05-18: 3/3 fail; 2026-05-19: 1/3 fail; 2026-05-21: 0/3 fail), the picture continues to fill in: the failure is real but sampling-dependent, and the closure-stack mapping is what's load-bearing. The failure path is closed by the v3 stack (`escalation_revise_counts_as_reject` + `escalation_requires_votes_to_accept` + `contested_votes_to_accept`), pinned byte-for-byte at the harness level and corroborated by the `borderline-contested-v3` cube cell (`rejected`). The contested-item-severity axis maps a drift-pattern landscape: across this reading and the prior two, verb-swap drift is the one kind that has produced auto-close-accept failures (now spread across the v0, v1, v2 cells in different snapshots, all the same structural path); surrogate-substitution and generalization-from-subgroup drift continue to close cleanly. The load-bearing v0/v1/v3 closure delta is pinned independently of any draw by the scripted-decider pair in `population-loop.test.ts`.

A new behaviour worth flagging on the model-backed tier this snapshot: **the assigned/idle reshape opened a spontaneous-proposing path agents can use after frontier exhaustion**, and across the cube several real-model runs took it. The cells where this lands cleanly (`borderline-surrogate`, `borderline-contested-r2`) now produce 3-5 `synthesis` nodes and 2-3 `open_question` nodes from spontaneous proposing — work the prior baseline never produced because the agents terminated on the `not_found` error rather than switching modes. The path is not free of friction: in this draw, agents trying spontaneous `propose_anchor` sometimes mis-serialize the `external_ref` field (sending a stringified JSON instead of an object), burning turns on retry until the agent moves on or hits `max_turns`. The friction is the cost; the new productive work the cube records is the benefit. The recorded behaviour does not affect the contested-outcome closures the cube exists to measure, but it argues for either a tightened tool-description example on `external_ref` or a less anchor-centric guidance string in the idle payload — open follow-up items at the testbed level.

**7. Calibration-aware convergence is asymmetric in the right direction.** A calibration-burned vote drops convergence weight (it counts toward the distinct-reviewer floor but contributes 0 to the weighted sum) — so a coalition member who misfires once can no longer drive the contested target across the threshold. The calibration on/off cube cell on the model-backed loop shows that on the honest baseline, flipping the defense off moves no outcome — the defense is load-bearing when an adversary actually drifts, and carries no false-positive cost when no one does.

## Open work (post-Phase-1, non-blocking)

- **More borderline drift kinds** (missing-caveat, magnitude-inflation, reverse-causation) — extends the contested-item-severity axis. Each is a one-cell cassette + per-cell assertion; the harness shape is unchanged.
- **Sampling rollouts for `borderline-surrogate` and `borderline-subgroup`** — the verb-swap trio established that a single-rollout cube reading is one draw, not a verdict (across four snapshots it has read 2/3, 3/3, 1/3, then 0/3 fail); analogous trios on the other drift kinds would tighten the landscape and show whether their single-rollout v0-closes results are robust.
- **Idle-response guidance and `external_ref` tool-description tightening** — the 2026-05-21 cube recorded agents spontaneously proposing after frontier exhaustion (`propose_synthesis` and `propose_open_question` landed; `propose_anchor` attempts tripped on the `external_ref` schema). Two concrete moves: either an `external_ref` example in the tool description (cheap), or a less anchor-centric guidance string in the idle payload that nudges agents toward `propose_synthesis` / `propose_supersedes` over the wider-scoped `propose_anchor` (also cheap, more targeted). Either is a recordable cube delta; both are post-Phase-1 follow-ups.
- **`borderline-surrogate` and `borderline-subgroup` through v1/v3 closure stacks** — confirms the closure-stack rules generalize across drift kinds.
- **A `lazyRole` / `honestWeakRole`** for the model-backed tier — covered in scripted form against their named defenses today; the deep-loop addition would be cosmetic completeness, not new closure information.
- **Scheduled CI cadence** for the deep-loop cube (a `schedule:` trigger on the `deep-loop.yml` workflow) — deferred to Phase 2 by the maintainer; the deep-loop cube runs on workflow_dispatch today.
- **Live-fetch verification** (PMID/DOI/URL resolution + source caching) — landed 2026-05-14 as Phase 2 slice 1 (`LiveFetchVerifier` in `packages/server/src/live-fetch-verifier.ts`; see [ROADMAP §Status](../ROADMAP.md#status)). The production-runtime wiring (slice 4) is still ahead; testbed cassettes continue to use `FakeVerifier` so the testbed itself doesn't take a dependency on PubMed availability.

None of these gate Phase 1 closure: they extend the sweep at the same testbed, which is exactly what "incremental coverage" means.

## Reproduce

**Clone and install.**

```bash
git clone https://github.com/anchorage-protocol/anchorage.git
cd anchorage
pnpm install
```

**Run the scripted cube layer + cheap-pair cassettes (no API key needed).**

```bash
pnpm test
```

This runs all 18 scripted cubes plus the cheap-pair cassettes (`golden-cassette.test.ts` + `golden-deep-loop.test.ts`) in replay mode. Byte-deterministic, ~5 seconds, no network. A pass means every scripted cube cell's load-bearing assertion holds and the cheap pair replays clean.

**Replay the model-backed deep-loop parameter-sweep cube from cassette (opt-in).**

```bash
ANCHORAGE_CUBE_CASSETTE=1 pnpm --filter @anchorage/server test golden-deep-loop-cube
```

The cube is env-gated because re-recording it costs ~$15-18 — it's a release-time behavioral baseline, not a per-commit invariant. The default-CI cassette guard is the cheap pair; the cube runs when you want to verify the parameter-sweep landscape against fresh model samples.

**Re-record a single model-backed cube cell against a live model** (requires `ANTHROPIC_API_KEY` in repo-root `.env`; ~$0.40-0.65 per cell on `claude-haiku-4-5-20251001`):

```bash
ANCHORAGE_CASSETTE_MODE=record \
ANCHORAGE_CUBE_CELL=borderline-contested \
pnpm --filter @anchorage/server deep-loop-cube
```

The cassette is rewritten at `packages/server/test/fixtures/golden-deep-loop-cube-borderline-contested.json`. Re-running `pnpm test` then replays the new recording deterministically. Each rollout is an independent draw from the model's distribution — sampling variance is real (the verb-swap trio's three rollouts produced three structurally different outcomes), so a single re-record is one data point, not a deterministic re-run of the original.

**Add a new cube cell.** Append an entry to `DEEP_LOOP_CUBE_CELLS` in [`packages/server/src/deep-loop-scenario.ts`](../packages/server/src/deep-loop-scenario.ts), record its cassette, add a per-cell assertion in [`packages/server/src/golden-deep-loop-cube.test.ts`](../packages/server/src/golden-deep-loop-cube.test.ts), and update PRD §Continuous integration in lockstep ([CLAUDE.md docs-never-drift discipline](../CLAUDE.md#conventions-for-working-in-this-repo)).

**Run the live single-agent loop** (requires API key; ~$0.05 per run):

```bash
pnpm --filter @anchorage/server live
```

**Cost envelope.** Replaying every cassette in CI: $0. Re-recording the full deep-loop cube from scratch: ~$10-$18 depending on how often agents engage the spontaneous-propose path after frontier exhaustion (longer agent runs raise the bill; the 2026-05-21 reading at $17.71 was higher than the 2026-05-19 reading at ~$10 for exactly this reason — same fixture, longer recordings). Re-recording one cube cell: ~$0.40-$1.20. Running the scripted cube layer: $0 (no LLM).
