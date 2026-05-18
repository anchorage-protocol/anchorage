# Anchorage Phase 1 results — adversary testbed snapshot

> Snapshot as of **2026-05-18** (supersedes the 2026-05-14 reading). License: CC BY-SA 4.0 (text and tables) / AGPL-3.0 (the testbed code that produced them). This document is a point-in-time report of what the Anchorage adversary testbed measured, not a living spec — the testbed itself ([`packages/server/src/testbed.test.ts`](../packages/server/src/testbed.test.ts) for scripted populations, [`packages/server/src/run-deep-loop-cube.ts`](../packages/server/src/run-deep-loop-cube.ts) for the model-backed cube) is the durable artifact; this file freezes one reading from it.
>
> **Why this re-snapshot.** The Phase 2 client-bootstrap change (`query_causes` tool + MCP `instructions` at connect) altered the Anthropic request bytes the model-backed agents send, so every model-backed cube cassette was re-recorded 2026-05-18. LLM sampling is non-deterministic — each re-record is a fresh draw, not a re-run — so the per-cell tallies and the model-backed ASR below differ from the 2026-05-14 reading. **The scripted tier and every byte-for-byte scientific pin (`population-loop.test.ts`, `testbed.test.ts`) are unaffected by the bootstrap change and unchanged**; only the model-backed regression baseline was re-drawn. The 2026-05-14 reading is retained in git history.

## Summary

The Anchorage adversary testbed runs the full v0 governance regime against synthetic adversarial populations — both **scripted** (deterministic deciders driving the wired MCP write-path tools) and **model-backed** (real Claude agents over the Anthropic Messages API, recorded into checked-in cassettes that replay byte-deterministically in CI). The cube layer measures attack-success-rate (ASR) per defense config across every named axis in [PRD §What's deliberately not specified](./prd.md#whats-deliberately-not-specified): calibration density, reviewer pool size, vote-aggregation thresholds, reputation decay rates, identity-cost composition, difficulty-aware credit, plus the (stratification × threshold), (decay × cluster-signal), and (alpha × stratification × demonstrated-decay) compositions where axes interact. 21 distinct sweep cubes are wired (20 scripted, 1 model-backed). Every named adversary archetype in [PRD §Adversary taxonomy](./prd.md#adversary-taxonomy) has scripted-tier coverage; the deep loop adds model-backed honest-strong, patient adversary, and strategic adversary.

The headline reading: **redundant peer review with calibration-aware convergence + stratified-by-history assignment + the four-layer sybil-resistance composition (Binding cost / rate-limited Tickets / cluster-signal Networks / Encounter-domain extension) closes every coalition pattern the testbed has constructed against it on the scripted tier**, with the model-backed cube confirming the closures hold against real-LLM honest pools and adversaries on the deep loop's small-population fixture. The model-backed cube records closure failures on a borderline-contested item under the bare v0 closure stack: in the 2026-05-18 reading the verb-swap drift fails v0 in **all 3** of its sampling rollouts (`borderline-contested`, `borderline-contested-r2`, `borderline-contested-r3`), every one via the **auto-close-accept** path (≥2 accepts hitting `votes_to_accept` before the curator escalation pass sees the item) — and `borderline-contested` fails it with *no adversary vote at all*, a confused honest pool alone. The strict-v1 cell (`borderline-contested-v2`) fails via the same auto-close-accept path the v1 escalation knobs do not touch. The model-backed attack-success-rate is 4/11 (≈36%), every accepted instance on the verb-swap drift. These failures motivated three `ReviewConfig` knobs (`escalation_revise_counts_as_reject`, `escalation_requires_votes_to_accept`, `contested_votes_to_accept`) forming a v3 stack; the load-bearing v0/v1/v3 deltas are pinned byte-for-byte at the harness level by scripted-decider pairs in [`population-loop.test.ts`](../packages/server/src/population-loop.test.ts) (unaffected by the bootstrap re-record) and corroborated at the real-model level by the `borderline-contested-v1`/`v3` cube cells, which record `rejected`. The dominant 2026-05-18 failure path (auto-close-accept) is exactly the one `contested_votes_to_accept` (v3) closes. **No open closure failure remains in the cube as of this snapshot** — every recorded failure path has a v3 closure pinned against scripted deciders.

The Phase 1 ROADMAP language called for "third-party replication" of these results; that criterion was a category error borrowed from conventional scientific publishing. Anchorage's testbed is by-construction simulatable: cassettes pin every byte across the wire, the model is a published API (`claude-haiku-4-5-20251001` and `claude-sonnet-4-6` both replay deterministically from cassette), the code is open. A third-party rerun is *literally the same operation* as an in-house rerun. Reproducibility is what's load-bearing, and is satisfied by the artifacts in this repository; replication of any cube cell or extension to new cells is incremental work in the same testbed. The reproduce instructions are at the bottom of this doc.

## Methodology

**Testbed shape.** The testbed talks to the server *only over MCP*, by build-system construction — `packages/testbed` declares no path to `packages/server` internals; the synthetic populations exercise the same surface a real client (Claude Desktop, Cursor, custom agent) would. Every archetype, scripted or model-backed, calls the production write-path tools (`set_capacity`, `request_assignment`, `propose_*`, `cast_review_vote`, etc.) and reads from the production query tools (`query_frontier`, `query_proposals`, `fetch_calibration_batch`, `query_reputation`). This is what makes the sim≡prod equivalence load-bearing: there is no `if (sim) ...` branching anywhere in the codebase, ever — the only difference between sim and prod is who is on the other end of the connection. Testbed results transfer to production by construction.

**Two tiers.**
- **Scripted (fast loop)** — deterministic deciders drive the same wired surface. Every PR runs the full scripted cube layer in CI (`pnpm test`). Cheap, deterministic, run thousands of times per release. The scripted tier carries the bulk of regression coverage.
- **Model-backed (deep loop)** — real Claude agents over the Anthropic Messages API. The role is carried entirely in the agent's *system prompt* (the loop is role-blind). Recordings live as *cassettes* at `packages/server/test/fixtures/golden-*.json` (sha256-keyed by request body); replay is byte-deterministic and key-free. CI runs the cassettes; live re-recordings are on-demand by the maintainer. Default model: `claude-haiku-4-5-20251001`. A typical deep-loop cube cell records at ~$0.40-0.65; the full deep-loop cube is ~$10 to re-record from scratch.

**Cube layer.** Each cube sweeps one or more *defense parameters* against a fixed *attack pattern*, reads the attack-success-rate (and lockout-rate where the failure mode is honest-pool collapse rather than attack pass-through), and asserts the load-bearing shape — usually "ASR < ε with the named defense on, ASR ≥ T with it off, monotone between". Cubes are CI assertions, not separate runs: every PR runs them.

**Closure-stack discipline.** When the model-backed cube records a closure failure (the system letting an attack through that the scripted cube didn't predict), the response is a new opt-in `ReviewConfig` knob with `default = v0-preserves-everything`, a *byte-for-byte harness pair* in `population-loop.test.ts` against scripted deciders pinning the load-bearing v_n / v_{n-1} delta, and a dedicated cube cell as the real-model regression baseline. Three closure-stack knobs landed this way (v1: `escalation_revise_counts_as_reject`; v2: `escalation_requires_votes_to_accept`; v3: `contested_votes_to_accept`), each closing a specific failure path the model-backed loop surfaced.

## Coverage

### Adversary archetypes ([PRD §Adversary taxonomy](./prd.md#adversary-taxonomy))

| Archetype | Scripted | Model-backed |
|---|---|---|
| Honest-weak | `runHonestWeak` (friction-rate test) | n/a (PRD frames as small local model; deep loop is frontier-only) |
| Honest-strong | `runHonestStrong` (proposer/honest pool in ~20 cubes) | `honestStrongRole` (every deep-loop cube cell runs 2) |
| Lazy | `acceptAllDecider` (caught by calibration) | n/a (calibration scoring exercised via patient-adversary cells) |
| Hallucinator | `runHallucinator` (verifier-rejection) | n/a (caught pre-review at the verifier seam) |
| Strategic adversary | strategic-coalition cubes #1-#4 + variants | `strategicAdversaryRole` (cube cells `strategic-adversary`, `borderline-contested`, `borderline-surrogate`, `borderline-subgroup`, `borderline-contested-v1/v2/v3/r2/r3`) |
| Patient adversary | testbed two-component drain + assignment-gate refusal | `patientAdversaryRole` (cube cells `calibration-on/off` + `golden-deep-loop` replay) |
| Sybil farm | sybil-amplified-coalition + binding-cost + rate-limit + cross-cause clustering + adversary-budget primitive | n/a (sybil resistance is sub-MCP; no model surface) |
| Coalition (multi-variant) | decorrelating, unanimous-priming, anti-correlation, mixed-strategy, paired-decline, contention-weighted+anti-correlation | n/a (coordination is structural, not behavioral) |

The scripted/model-backed split mirrors the PRD's design partition: archetypes whose distinguishing behavior is *structural* (coalition coordination, sybil minting, hallucination caught at the verifier) are scripted-only by design; archetypes whose distinguishing behavior is *judgment under partial information* (patient drift, strategic borderline-defense) are where the model-backed tier earns its keep. Honest-weak and lazy are scripted-only because their named defense (calibration scoring) is exercised in scripted form on the same surface, and the model-backed tier would add no signal.

### Defense axes ([PRD §What's deliberately not specified](./prd.md#whats-deliberately-not-specified))

| Axis | Cube(s) |
|---|---|
| Calibration density (ratios) | #10 + #13 (density-floor scaling at two resolutions) + #16 (corpus-composition contamination) |
| Reviewer pool sizes | #11 (graceful-degradation on cluster-signal closure) |
| Vote-aggregation thresholds | #12 (threshold-axis decomposition on K+1-honest dynamic) + #14 (stratification × threshold composition) |
| Reputation formula constants — recent-window decay | #15 (ratio-invariance on recent W/T closure) |
| Reputation formula constants — demonstrated-window decay | #17 (ratio-invariance on demonstrated W/T closure) |
| Identity-cost composition (B/T/N/E layers) | #6 (binding cost) + #7 (rate-limited tickets) + #8 (cluster-signal networks) + #9 (encounter-domain extension) |
| Difficulty-aware review credit (alpha) | #5 (recent-gate closure on patient archetype) + #20 (stratification closure on coalition archetype) |
| Curator-side visibility | #19 (decline-pattern projection) |
| (decay × cluster-signal) composition | #18 (gate-design role-separation on multi-round timed-coalition) |
| Closure-stack version on borderline contested | model-backed cube `borderline-contested-v1/v2/v3` + scripted-decider harness pairs in `population-loop.test.ts` |
| Contested-item severity (model-backed) | model-backed cube `borderline-contested` (verb-swap) + `borderline-surrogate` (surrogate-substitution) + `borderline-subgroup` (generalization-from-subgroup) + sampling rollouts `r2`/`r3` |

Every axis named in PRD §What's deliberately not specified has measured cube coverage.

## Headline findings

The full per-cube findings are in the test file's headers (each cube's `it(...)` block opens with a multi-paragraph commentary describing what was measured and what closed). The summary below picks out the load-bearing structural results.

**1. Redundant review + calibration is the base layer; both halves are needed.** The naive 2-of-3 strategic coalition flips both vote convergence and rep ledger against an honest reviewer of well-grounded work (cube #1 baseline, ASR ≈ 100% with no defense). Calibration-on-its-own catches the rep-ledger half (the coalition burns rep on bias-misaligned calibration items) but not the convergence half. Calibration-aware convergence (vote-weight by per-(cause, sub-topic) calibration record + minimum distinct-reviewer floor) closes the convergence half; the two compound into closure of the naive archetype. Against the *calibration-aware variant* (bias narrow enough that the calibration corpus falls outside the bias zone) both defenses go quiet — closing this requires the next layers.

**2. Pool-size scaling closes any fixed-K coalition where the eligible honest pool is ≥ K+1 (cube #11).** This handles the "minimum K+1-honest-reviewer regime" — the regime where the honest pool can outvote a bounded coalition.

**3. Stratified-by-history assignment closes the small-pool case (cube #14, (stratification × threshold) composition).** When the eligible pool can't furnish K+1 honest reviewers, vote-pattern co-occurrence clustering routes coalition members away from each other's contested proposals. The v0 cluster primitive falls to a vote-decorrelating coalition (singleton strata). The two refinements that close the bypass: contention-weighted edges (closes over-aggregation, where unanimous priming pulls honest reviewers into one cluster) and anti-correlation detection (closes the decorrelating bypass at threshold 1.0). The mixed-strategy coalition that targets the gap between the two thresholds is closed only by their *composition* — neither refinement alone catches it.

**4. The four-layer sybil-resistance architecture closes the named sybil patterns (cubes #6-#9).** Identity binding cost (B), rate-limited identity-issue tickets (T), cluster-signal Networks (N — the same stratification primitive applied at the identity layer), and Encounter-domain extension via `stratum_include_declines` (E — closes paired-decline coalitions that suppress co-voting on contentious items). #6-#9 measure each layer's contribution; #19 measures the curator-side visibility surface (decline-pattern projection) that exposes sub-MCP signals to operator action.

**5. Difficulty-aware review credit (alpha) re-baselines two closures (cube #5 patient, cube #20 coalition).** The naive credit formula's threshold derivations assume alpha=1; under alpha=0.5 the same closure mechanism goes from full-honest-defense to lockout. Cube #5 reads the patient case and pins the recent-gate closure under the re-tuned threshold; cube #20 does the same for the coalition case and pins the stratification closure.

**6. The model-backed deep-loop cube confirmed the scripted closures hold against real-LLM populations and surfaced verb-swap closure failures on a borderline-contested item, all closed by v3.** The strategic adversary is handed a genuinely borderline contested claim (source uses observational "associated with" framing; pre-staged claim swaps it for causal "increases"). In the 2026-05-18 reading **all 3** sampling rollouts of that scenario (`borderline-contested` + `borderline-contested-r2` + `borderline-contested-r3`) fail the bare v0 closure stack, all via the *same* path: auto-close-accept (≥2 accepts hitting `votes_to_accept=2` before the curator escalation pass sees the item). `borderline-contested` fails it with no adversary vote at all — the confused honest pool alone lands the two accepts; `r2`/`r3` via adversary drift accept + a confused honest accept. The path is closed by the v3 stack (`escalation_revise_counts_as_reject` + `escalation_requires_votes_to_accept` + `contested_votes_to_accept`), pinned byte-for-byte at the harness level and corroborated by the `borderline-contested-v3` cube cell (`rejected`). The contested-item-severity axis maps a drift-pattern landscape: verb-swap drift breaks v0 (3/3 rollouts, dominant path auto-close-accept); surrogate-substitution drift v0 closes via curator escalation reject *even when the adversary drifts on it*; generalization-from-subgroup drift v0 closes via auto-close-reject (the adversary declined to drift on it) — two of three drift kinds the v0 stack handles, verb-swap the one it does not, robustly across its trio rather than by sampling luck.

**7. Calibration-aware convergence is asymmetric in the right direction.** A calibration-burned vote drops convergence weight (it counts toward the distinct-reviewer floor but contributes 0 to the weighted sum) — so a coalition member who misfires once can no longer drive the contested target across the threshold. The calibration on/off cube cell on the model-backed loop shows that on the honest baseline, flipping the defense off moves no outcome — the defense is load-bearing when an adversary actually drifts, and carries no false-positive cost when no one does.

## Open work (post-Phase-1, non-blocking)

- **More borderline drift kinds** (missing-caveat, magnitude-inflation, reverse-causation) — extends the contested-item-severity axis. Each is a one-cell cassette + per-cell assertion; the harness shape is unchanged.
- **Sampling rollouts for `borderline-surrogate` and `borderline-subgroup`** — the verb-swap trio established that a single-rollout cube reading is one draw, not a verdict (across two snapshots it has read 2/3 and 3/3 fail, via different path mixes); analogous trios on the other drift kinds would tighten the landscape and show whether their single-rollout v0-closes results are robust.
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

**Run the scripted cube layer (no API key needed).**

```bash
pnpm test
```

This runs all 20 scripted cubes plus the model-backed cube cells in cassette-replay mode (the checked-in `golden-*.json` fixtures). Byte-deterministic, ~5 seconds, no network. A pass means every cube cell's load-bearing assertion holds.

**Replay a single model-backed cube cell from cassette.**

```bash
pnpm --filter @anchorage/server test golden-deep-loop-cube
```

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

**Cost envelope.** Replaying every cassette in CI: $0. Re-recording the full deep-loop cube from scratch: ~$10. Re-recording one cube cell: ~$0.40-0.65. Running the scripted cube layer: $0 (no LLM).
