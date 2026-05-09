# PRD

> The technical north star: data model, interfaces, governance machinery, calibration, credit, adversary testbed. Where the [manifesto](./manifesto.md) explains *why* and [governance](./governance.md) sketches *who decides what*, this document specifies *how*.

This document captures design intent. **Field-level contracts** (zod schemas, MCP tool I/O shapes, lifecycle states) live in [`@anchorage/contracts`](../packages/contracts/src) and are the executable spec. The two stay in lockstep under the docs-never-drift discipline (see [CLAUDE.md](../CLAUDE.md)) — a contract change without a doc change, or vice versa, is a bug. Parameters deliberately deferred to the adversary-testbed phase — calibration ratios, reputation decay rates, vote thresholds — remain unspecified here; they will be tuned against simulation rather than guessed.

---

## Architecture overview

Anchorage is one canonical service layer behind two client surfaces:

```
                         ┌─────────────────────────────┐
                         │   Canonical service layer   │
  ┌──────────────────┐   │  ─ graph store              │   ┌──────────────────┐
  │  MCP server      │◀─▶│  ─ write-path tools         │◀─▶│  Web UI          │
  │  (mcp.…)         │   │  ─ verification engine      │   │  (anchorage.…)   │
  │  contributor /   │   │  ─ governance machinery     │   │  read & browse   │
  │  agent surface   │   │  ─ reputation & calibration │   │  for humans      │
  └──────────────────┘   │  ─ projection engine        │   └──────────────────┘
                         └─────────────────────────────┘
```

- **MCP server** (`mcp.anchorage.science`): primary write-path interface. Most traffic is agents acting as a human contributor's delegate (see [Identity](#identity)) — connected from any MCP-capable client and pulling assignments during idle time. Direct human contribution and the simulated populations in the testbed connect through the same surface. Tools are typed; verification is server-side.
- **Web UI** (`anchorage.science`): read-mostly human surface. Browse causes, sub-topics, graphs, frontiers, and manuscript projections. Calls the same canonical service layer.
- **Service layer**: the trust boundary. Every mutation passes through verification, governance gates, and reputation updates here. Clients are untrusted regardless of identity.

This is a deliberate architectural commitment, not an implementation note. Federation between Anchorage instances later is MCP-to-MCP. The testbed connects via the same MCP interface real clients use — *no stub APIs*. The architectural commitment is what the testbed depends on; the broader claim that simulated populations cover the real contributor distribution is qualified in the [manifesto](./manifesto.md#testability-is-the-secret-weapon) and the [testbed coverage section](#what-the-testbed-does-not-cover).

---

## Data model

### Multi-scale structure

Three layers, each with the shape suited to its job:

- **Cause** — the umbrella unit of belonging ("colon cancer"). Causes are created by maintainers; they are not user-creatable in v0.
- **Sub-topic** — scope envelope within a cause ("ctDNA-MRD in stage II resected CRC"). Sub-topics are first-class objects: they have IDs, descriptions, scope-envelope queries (e.g. PubMed search definition), creation status (proposed / active / archived), and curator approval state. In v0 sub-topic creation requires curator approval; later phases admit auto-discovery from graph state.
- **Claim graph** — the per-cause structure where work happens, partitioned across sub-topics by node *home* and connected across them by *scope memberships*.

A node has **exactly one home sub-topic** and **zero or more scope memberships** in other sub-topics within the same cause. The two are different jobs:

- The **home** sub-topic owns the node for review purposes: it determines which reviewer pool evaluates the proposal and where the contributor's per-sub-topic reputation accrues.
- A **scope membership** is a (node, sub-topic) edge stating "this node is in scope for this sub-topic." Memberships are themselves proposable, reviewable claims — small, atomic, and decomposable. A landmark trial excerpt or a definition node ("MSI-high CRC") can legitimately be in scope for several sub-topics simultaneously without being duplicated, re-fetched, or forked across supersedes chains.

This single structure replaces the older "exactly one sub-topic, with cross-links between" rule. Cross-links as a separate edge type are gone; their use case is subsumed by memberships, with stricter semantics (memberships are reviewable assertions about scope; they do not propagate `derives` lineage across sub-topics by themselves).

### Nodes

Every node has:

- `id` — opaque identifier
- `home_sub_topic_id` — the sub-topic that owns the node for review and reputation purposes
- `scope_memberships` — set of additional sub-topic IDs (within the same cause) this node is in scope for; each membership is an independently reviewable assertion
- `kind` — one of:
  - `anchor` — external source (paper, dataset, definition). Has `external_ref` (PMID, DOI, URL) that must resolve.
  - `excerpt` — tight claim tied to a specific anchor parent. Has a `quoted_span` field; the verification engine matches it against the resolved source. Excerpts cannot exist without a verified span. The `content` is the atomic claim; the `quoted_span` is the verbatim slice that anchors verification. They are not required to be identical — `content` may paraphrase to atomize a claim the span supports — but `content` must be an assertion the span supports under a charitable reading. The verification engine confirms the span resolves; the reviewer confirms `content` follows from it. Span verification is necessary but not sufficient: cherry-picking a true span out of context (negation-stripping, hedge-stripping) is a known attack and is part of the reviewer's responsibility to catch.
  - `synthesis` — explicit inferential step derived from multiple parents. The agent or contributor sets `kind=synthesis` when the content is not a straight excerpt.
  - `open_question` — scoped uncertainty with edges to what it depends on. Surfaces as a frontier item.
- `content` — the claim text (single atomic claim per node)
- `external_ref` — for anchors only, structured pointer (PMID/DOI/URL). Excerpts do not carry an `external_ref`; their grounding flows through the `derives` edge to the parent anchor, where verification rests. Duplicating the field on excerpts would create two places for it to drift.
- `content_hash` — for anchors only, hash of the fetched source content; set by the server post-fetch and used for re-verification (see [Verification engine](#verification-engine)).
- `quoted_span` — for excerpts, the verifiable span text + offset within the source
- `status` — `staged` (under review), `active` (merged), `superseded` (replaced), `rejected` (review failed), `unresolvable` (anchors only — re-verification has failed and the node surfaces as a frontier item; see [Verification engine](#verification-engine))
- `created_by`, `created_at`, `updated_at`

The **active node rule** (matching Galleon's contract): a node is *inactive* if it is the `from` end of a `supersedes` edge.

### Edges

- `derives` — parent (support) → child (derived claim). Direction matches storage. Lineage walks backward along `derives` until it hits anchors. `derives` parents must be `active` at the moment of acceptance: a child cannot be merged with a `staged` or `rejected` parent. A `derives` edge is valid when the parent and child share at least one sub-topic — either both home there, or one home and the other a scope-member, or both scope-members. Lineage chains can therefore cross sub-topic boundaries through *shared scope memberships* without being separate edges.
- `supersedes` — old → replacement. Marks the old node inactive. The `to` end (the replacement) must be `active` at the time the supersedes is proposed. Supersedes cycles (A → B → C → A) are forbidden by the verification engine.

Other edge types are rejected. The minimal vocabulary is load-bearing: more edge types create more places for governance disputes without proportionally more expressive power. Note that *scope membership* is a property of the node, not a separate edge type — a node carries its set of sub-topic memberships directly.

### Scope membership

A scope membership says: "node X is in scope for sub-topic S." It is proposable (`propose_membership`), reviewable, and revocable through the same governance machinery as any other claim — because it *is* a claim. Memberships are evaluated by reviewers from the *target* sub-topic S (the one the node is being claimed to be in scope for), since they are the ones with the expertise to judge the scope claim.

Memberships are how cross-sub-topic concerns compose without duplication, without forking supersedes chains, and without smuggling lineage. A definition node ("MSI-high CRC") homed in a screening sub-topic can be a member of Lynch-surveillance, ctDNA-MRD, and immunotherapy-eligibility sub-topics — one node, one verification, one supersedes chain, four sub-topics that all see and review it.

**Credit accrues to the proposer at the home sub-topic only**; downstream memberships do not multiply credit. Contributors who propose memberships (claiming a node is in scope for a sub-topic they work in) accrue a separate, smaller credit on those memberships.

### Change of home

Sometimes a node is initially homed in the wrong sub-topic. `propose_change_of_home` moves the home sub-topic to a different one within the same cause, subject to curator approval. Other memberships are unaffected; the one exception is that if the new home was previously a scope membership, it is removed from the membership list — the home is implicitly in scope, so leaving it in `scope_memberships` would be a redundant duplicate. This is a real but rare operation; most apparent "wrong sub-topic" cases turn out to be membership-needed cases instead.

### Manuscript projection

A *projection* is a derived view of a sub-topic's graph plus editorial choices (section order, narrative voice, scope of inclusion). Projections are not a separate truth ledger — they are a function of (graph state, projection config). The graph is canonical; projections come and go.

The *projection config* is itself a governance artifact, not a private editorial document. Changes to a projection config — what's in scope, section ordering, which nodes are emphasized — affect which nodes are load-bearing for argument structure and therefore which contributors get credit. Projection configs are version-controlled in the graph; changes to them route through the standard governance-change CI process; authorship disputes resolve as governance changes to the projection config rather than as private negotiations.

---

## MCP tool surface

The MCP server exposes a small, verification-heavy set of tools. The minimum write surface is:

A separate **admin surface** — not exposed as MCP tools — covers the curator-only operations the contributor flow assumes already happened: minting an identity (Phase 1: by curator action; Phase 2+: behind whatever identity-cost mechanism is set, see [Identity](#identity)), binding agent credentials to it, creating a cause, and seeding sub-topics. These are not MCP tools because they are not contributor actions; making them tools would either require a privileged-tool concept (which the testbed would then have to teach its synthetic populations not to call) or open a sybil/cause-spam vector. The same operations are how the testbed sets up scenarios — sim and prod use the same admin surface, by the same indistinguishability rule that governs the tool surface.

### Write-path tools

The default contribution path is *assignment-driven*: contributors declare capacity at the **cause** level (not the sub-topic level — sub-topic granularity would reopen the laundering vector by letting contributors cherry-pick easy sub-topics), the system draws assignments from the frontier across all sub-topics in the cause (gap-closing tasks: orphan anchors needing excerpts, syntheses needing parents, contested claims needing review), and reputation accrues on assigned work. A contributor-initiated path exists but with weaker rep weighting (see [Reputation](#reputation)).

**Capacity and assignment**

- **`set_capacity`** `{ cause_id, rate, kinds }` → `{ ok }`
  - Contributor declares availability at the cause level: a maximum rate (a cap, not a schedule) and which kinds of work they will accept (`propose_excerpt`, `review`, `propose_synthesis`, etc.). Sub-topic is the system's choice, not the contributor's. Assignments are always *pulled* via `request_assignment` — typically by a delegated agent during idle time — never pushed; rate caps how many will be granted in a window. Capacity is the only way the system learns availability.
- **`request_assignment`** `{ cause_id, kind? }` → `{ assignment_id, task }`
  - Pull a task from the frontier within declared capacity. The system selects across all sub-topics in the cause based on frontier priority (gap urgency, sub-topic activity), expertise fit (where measurable from history), and capacity-balancing. The task is concrete: a specific node-shape to propose, or a specific proposal to review, in a specific sub-topic.
- **`accept_assignment`** `{ assignment_id }` → `{ ok }` and **`decline_assignment`** `{ assignment_id, reason }` → `{ ok }`
  - Declining individual assignments is non-punitive on its own — a legitimate narrow specialist (e.g., a genetic counselor who works only on Lynch-syndrome questions) declines outside their wheelhouse, and that's fine. What is *not* allowed is opt-in selectivity: capacity is cause-level, not sub-topic-level. Decline patterns are tracked; sustained pattern-declining of specific sub-topics, contributors, or claim classes is an abuse signal handled at the curator layer. The handling has two surfaces: a curator-side projection (`declinePatterns`) that ranks per-(cause, reviewer) cumulative decline rate and lets a curator drop the small-sample floor when they're hunting for something specific, and an assignment-time gate (`assignment_max_decline_rate`, `assignment_decline_min_offers`) that consumes the same signal at `request_assignment` and refuses callers above threshold with the same `not_found` mode the rep gates use. Same null-policy as the recent-activity gate — callers below the offers floor bypass — and the contributor-initiated review path (`cast_review_vote` without an `assignment_id`) doesn't traverse the gate, so a contributor whose decline rate has spiked retains the recovery path declines are non-punitive precisely *to* preserve. The testbed sweeps the threshold; production-instance threshold is operationally private.
- **`submit_assigned_proposal`** `{ assignment_id, payload }` → `{ proposal_id }`
  - Submit work for an assignment whose task kind is a proposal (anchor / excerpt / synthesis / supersedes / membership). Payload shape matches the task kind. Verification engine applies as for any proposal. Review-kind assignments are fulfilled via `cast_review_vote` with `assignment_id` set, not through this tool.

**Contributor-initiated proposals** (allowed but weighted lower for reputation):

- **`propose_anchor`** `{ cause_id, home_sub_topic_id, memberships?, content, external_ref }` → `{ proposal_id }`
  - Creates a staged anchor node. Server fetches `external_ref`, confirms resolution, and rejects on failure. `memberships` is an optional list of additional sub-topic IDs in the same cause; each becomes a separately-reviewable membership claim.
- **`propose_excerpt`** `{ cause_id, home_sub_topic_id, memberships?, parent_anchor_id, content, quoted_span }` → `{ proposal_id }`
  - Creates a staged excerpt node. Server matches `quoted_span` against the resolved source. Mismatch → rejection. No exceptions.
- **`propose_synthesis`** `{ cause_id, home_sub_topic_id, memberships?, parent_ids, content, kind }` → `{ proposal_id }`
  - Creates a staged synthesis or open_question node with `derives` edges from each parent. Atomic — either all edges create or none do. `kind` is `synthesis` or `open_question`.
- **`propose_supersedes`** `{ from_node_id, to_node_id, rationale }` → `{ proposal_id }`
  - Stages a supersedes edge with the reasoning attached.
- **`propose_membership`** `{ node_id, sub_topic_id }` → `{ proposal_id }`
  - Stages a scope-membership claim that `node_id` is in scope for `sub_topic_id`. Reviewed by the *target* sub-topic's reviewer pool.
- **`propose_change_of_home`** `{ node_id, new_home_sub_topic_id, rationale }` → `{ proposal_id }`
  - Curator-approved.
- **`cast_review_vote`** `{ proposal_id, decision, rationale, assignment_id? }` → `{ vote_id }`
  - `decision` is `accept`, `reject`, or `revise`. `rationale` is required and may itself be promoted to a graph node (typically `open_question`) by curators; promoted rationale-nodes pass standard review. When `assignment_id` is present, the vote fulfills a review assignment and accrues full assigned-review reputation; without it, the review is contributor-initiated and weighted lower on the same terms as contributor-initiated proposals. This tool is therefore the fulfillment path for review-kind assignments as well as the contributor-initiated review entry point.
- **`propose_sub_topic`** `{ cause_id, name, description, scope_query }` → `{ proposal_id }`
  - Subject to curator approval in v0.

### Read-path tools and resources

Read-path is largely MCP *resources* (passive), with a few active tools for queries:

- **Resource: `cause://...`** — list of causes; structured cause metadata.
- **Resource: `sub-topic://{id}`** — sub-topic metadata, status, scope query, recent activity.
- **Resource: `node://{id}`** — node + immediate neighbors.
- **Resource: `subgraph://{sub-topic-id}`** — full or filtered subgraph in a structured form.
- **Tool: `query_frontier`** `{ cause_id?, sub_topic_id?, frontier_kind? }` → ordered list of frontier items (work to be done).
- **Tool: `query_proposals`** `{ status?, sub_topic_id?, assigned_to_me? }` → list of proposals matching filter.
- **Tool: `fetch_calibration_batch`** `{ sub_topic_id }` → calibration-material projection: accepted-from-validated-history proposals routed to the sub-topic, in [`ReviewBatchItem`](../packages/contracts/src/tools.ts) shape (`proposal_id` + `payload`, status/proposer/timestamps stripped). The reviewer-facing calibration path runs through `request_assignment` (see [Calibration batches](#calibration-batches)) — a calibration item is delivered as a review-kind assignment indistinguishable from real review work, scored on `cast_review_vote` against ground truth. `fetch_calibration_batch` is the diagnostic projection of the same pool: the testbed inspects it; production reviewers do not call it directly.

Tool surface is intentionally small. Each tool has tight typing, server-side validation, and clear failure modes.

---

## Verification engine

The verification engine is the security boundary. Every write tool routes through it.

- **Anchor verification.** External references must resolve. PMIDs hit NCBI E-utilities; DOIs resolve via Crossref; URLs must return 200 with substantive content. Anchors are *content-addressed*: the hash of the fetched content is stored alongside the `external_ref`, and re-verification compares against the stored hash rather than only against a live fetch. URL-anchors are second-class — metadata-unstable and cloaking-prone — and may be subject to stricter regimes (or refused entirely in v0). When re-verification fails (retraction, content drift, host gone), the anchor moves to an `unresolvable` status and surfaces as a frontier item rather than silently rotting.
- **Span verification.** For excerpts, the `quoted_span` must be a substring of the fetched source after normalization (whitespace, quote-style, and a small set of typographic equivalences specified in the verification spec, not left to "light normalization" hand-waving). Failure rejects the proposal at write time, not at review time. Span verification confirms the quote exists; it does not confirm the proposed `content` follows from it — that is the reviewer's job.
- **Lineage validation.** A `derives` edge is valid when its parent and child share at least one sub-topic membership (home or scope). At acceptance, every `derives` parent must be `active` (not `staged`, `rejected`, or `superseded`); the `to` end of a `supersedes` must be `active` at proposal time; supersedes cycles are rejected. A manuscript projection in sub-topic S walks `derives` lineage that stays within S's home + scope-member graph.
- **Reputation gates.** Some operations require minimum reputation (per-(cause, sub-topic) or per-cause). Below the threshold, proposals land staged but are not advanced into the review queue without curator action. Specific thresholds are tuned in the testbed.
- **Rate limits and abuse signals.** Per-identity rate limits on proposals; suspicious patterns (sudden burst of proposals, calibration-failure clustering) flag for curator review. Specific signals are operationally private.

---

## Governance machinery

### The contribution flow

The default flow is assignment-driven. The contributor-initiated flow is a special case (steps 0a/0b are skipped; rep weighting is reduced).

0a. **Capacity** — contributor declares availability at the cause level — rate cap and accepted work kinds (`set_capacity`). Sub-topic granularity is deliberately not allowed; it would reopen the rep-laundering vector by letting contributors cherry-pick easy sub-topics.
0b. **Assignment** — system draws a frontier task matching capacity and assigns it (`request_assignment`); contributor accepts or declines.
1. **Submit / Propose** — assigned contributor submits work via `submit_assigned_proposal`; contributor-initiated path uses the `propose_*` tools directly.
2. **Verify** — verification engine accepts or rejects synchronously based on grounding/lineage/rate.
3. **Stage** — accepted proposals enter the review queue. Visible and citable as proposals; not part of the canonical graph.
4. **Assign reviewers** — N reviewers are drawn from the eligible pool of the home sub-topic (or the target sub-topic, for membership proposals), with calibration items mixed in.
5. **Review** — reviewers vote with rationale via `cast_review_vote`.
6. **Resolve** — convergent vote merges; divergent vote routes to a richer review path (more reviewers, curator escalation, or carrying the divergence forward as parallel synthesis nodes / `open_question`); long-unresolved divergences archive (status `unresolved-archived`).
7. **Settle** — reputation updates for the contributor and the reviewers, weighted by outcome correctness, by claim difficulty, and by whether the work was assignment-driven or contributor-initiated.

### Reviewer assignment

Reviewers are drawn from the eligible pool — contributors with cause-level capacity declared and sufficient per-(cause, sub-topic) reputation — by stratified random sampling. Stratification partitions the pool into expertise *strata* and prefers draws across strata, so a single bias zone cannot fill a proposal's reviewer slots even when the bias-aligned reviewers individually meet eligibility. Capacity is at the cause, not the sub-topic; reviewers do not pre-select which sub-topics they will be drawn for.

The v0 stratum primitive is the **vote-pattern co-occurrence cluster**: two reviewers fall in the same stratum when their pairwise vote agreement on shared past proposals exceeds a threshold over a rolling window. Coalition members coordinating on bias-zone proposals concentrate into a single cluster by their own behavior; honest reviewers spread across clusters by their independence. New reviewers (no shared history yet) sit each in their own singleton cluster, contributing maximally to diversity by default. Window sizes, agreement thresholds, and cross-stratum draw weights are testbed-tuned; the *signal* — vote-history clustering as the v0 stratum — is committed.

Pairwise edges are **contention-weighted**: each shared proposal contributes weight `2 * min(accepts, rejects) / total_votes` to the agreement metric, so unanimous-easy proposals contribute 0 and split-contentious proposals contribute up to 1. The pair edges only when (a) the raw shared-proposal count meets the brand-new-reviewer floor, (b) the weighted agreement ratio meets the threshold, and (c) some non-zero contention has accumulated in the shared history. Without weighting, an honest pool that happens to share unanimous priming history collapses into a single cluster, the cross-stratum draw rule fires against its own honest members, and coalition members who avoided the priming walk through the gate the honest reviewers were locked out of — the [adversary testbed](#adversary-testbed) wires that pathology end-to-end and the contention-weighted variant closes it cleanly.

Anti-correlation is a separate cluster cue alongside agreement: a pair that systematically votes the *opposite* way on shared proposals is also displaying coordinated behavior — just inversely. Treating perfect anti-correlation (1.0 disagreement ratio) as a co-stratum edge catches the decorrelating-coalition variant cleanly, since a coalition that defeats the agreement metric by voting opposite on every shared priming proposal lights up the disagreement metric instead. The testbed scenario for the decorrelating coalition closes against this defense at threshold 1.0; the threshold is testbed-tuned, with weaker thresholds catching noisier adversaries at the cost of admitting honest reviewers who happen to systematically disagree as false positives.

The encounter domain extends from `{accept, reject}` to `{accept, reject, decline}` when `stratum_include_declines` is on, so the cluster primitive sees declines as first-class encounters alongside votes. Without this widening, a coalition that paired-declines as the routing primitive (each member solo-rejects one contested target and declines the partner's) shares zero vote-history by construction and the cluster signal has no edge metric to fire on. With it on, "Carol votes A and declines B; Dave declines A and votes B" reads as 100% pair-disagreement on two shared encounters under the existing anti-correlation primitive, the cross-stratum gate trips against the partner at the next assignment, and the seam closes at the same primitive that already catches vote-only decorrelating coalitions. A real vote takes priority over a decline on the same `(reviewer, proposal)` pair (a contributor-initiated vote after declining is "I changed my mind"), and decline-involved encounters under contention-weighting count at full weight (declines are inherently informative — opting out is a stance, not noise — and the per-proposal accept/reject tally would underweight them by construction). Defaults to off so existing scenarios are unaffected.

The decline-aware × contention-weighting interaction has a load-bearing refinement: the full-weight rule for declines only applies once the pair has met a **paired-decline floor** (`stratum_decline_min_paired`, default 2). Without the floor, a single asymmetric decline-involved encounter (one reviewer declines a proposal, another votes on it) carries weight 1 against an honest pair whose entire vote-vote history sits on unanimous-easy items (contention 0 → weight 0); the pair's weighted-disagreement ratio collapses to 1.0 and the anti-correlation edge fires against an honest pair that shared no coalition signal — the honest pool false-clusters with itself and the cross-stratum gate strangles honest review on the next contested target. The paired-decline closure that the full-weight rule has to preserve has 2 decline-involved encounters per pair by construction (one in each direction), so a floor of 2 closes the over-clustering pathology without weakening the closure: below the floor, decline-involved encounters contribute 0 weight and the pair stays decline-blind for cluster purposes; at and above the floor they count at full weight as before. Raw shared count is unaffected — the brand-new-reviewer floor still applies. The testbed scenario for the over-clustering pathology runs at `stratum_decline_min_paired=1` (no floor) to pin the buggy regime and at `stratum_decline_min_paired=2` (default) to confirm the closure, with the same defense stack on both halves.

A mixed-strategy coalition (a 50/50 vote pattern — two agreed, two disagreed across four shared proposals) defeats either refinement *alone*: the raw mix sits at agreement 0.5 and disagreement 0.5, below threshold 1.0 in both directions. The composition closes the gap. With contention weighting, agreement on unanimous-easy items contributes 0 weight and disagreement on contentious items contributes the full weight, so the weighted disagreement ratio collapses to 1.0 and the anti-correlation edge fires. The testbed scenarios run both halves: the mixed-strategy bypass standing open with each refinement individually, and closing under the composition (contention-weighted + anti-correlation, both at threshold 1.0). The seam that remains open is a coalition that avoids co-voting on any contentious item — but suppressing the contested target inherently creates a contentious item, and priming with non-contentious co-votes either lights up the positive-agreement edge or fails to inflate shared history above the brand-new-reviewer floor. The next testbed target on this seam is whatever adaptation works around that constraint; calibration-item-specific agreement (contrasted against calibration record) and payload-feature vote patterns remain the candidate refinements if that adaptation surfaces.

The draw rule is **prefer not-yet-represented strata first**. Within a target reviewer count N, the assignment selector visits strata in priority order, taking at most one reviewer per stratum until N strata are filled, then loosens to per-stratum saturation if the pool is exhausted. This compounds with [pool-size scaling](#adversary-testbed): in a pool that holds K+1 honest reviewers, stratification keeps a K-coalition from monopolizing the slots; in a pool too small to furnish K+1 — the small-sub-topic regime — stratification still draws *across* whatever clusters exist, and if fewer than N strata are reachable the proposal is flagged **stratification-degraded**.

Stratification-degraded propagates into convergence: a degraded proposal requires a higher distinct-reviewer count and/or a higher weighted-vote sum to converge, making the small-sub-topic case slower to close but not capturable by the pool-fits-the-coalition dynamic. The flag is visible to the contributor, factored into convergence-threshold logic (see [Calibration batches](#calibration-batches) for the weighted-vote tally), and logged for periodic audit. Specific tightened thresholds are testbed-tuned.

Reviewer pools are evaluated in this fallback ladder:

1. **Home-sub-topic rep.** Standard path. Reviewers homed in this sub-topic.
2. **Membership-sub-topic rep.** When the home pool is exhausted, draw from contributors whose work is *scope-member* of this sub-topic — they have proven legitimate stake without being homed here.
3. **Cause-rep with stratification-degraded flag.** When 1 + 2 are exhausted, draw from cause-rep contributors and flag the proposal as stratification-degraded — same flag the cross-stratum draw raises when fewer than N strata are reachable; convergence tightens identically.
4. **Curator escalation.** When even the cause-rep pool is insufficient or when stratification-degraded persists across several proposals in a sub-topic, escalate to curator review.

At sub-topic launch, both the eligible pool *and* vote-history are thin by construction, so stratification-degraded fires immediately and calibration items are drawn from the cause's validated history rather than from the sub-topic's. The doc states this explicitly so it is not mistaken for a vulnerability when reviewers notice it.

Convergence and divergence thresholds are claim-class-aware: high-stakes claim classes (e.g., quantitative effect-size syntheses) draw larger pools and tighter convergence thresholds than low-stakes ones (e.g., terminological clarifications). Specific class definitions and threshold values are testbed-tuned; the *machinery* being class-aware is a design commitment.

Divergence has a closure mechanism. Divergent proposals are routed to richer review or carried forward as parallel synthesis nodes / `open_question`, but not indefinitely: divergences without further evidence within a tunable window are archived (status `unresolved-archived`) rather than perpetually re-routed. This prevents the queue from accumulating reviewer-noise as if it were principled disagreement.

### Calibration batches

Reviewer batches contain a mix of real proposals and calibration items. Calibration items are drawn from the graph's own validated history — proposals that survived multiple confirmations and have been stable. They are intended to be statistically indistinguishable from real frontier work in *the dimensions a reviewer can act on*: a reviewer evaluating one batch should not be able to tell which items are calibration. The harder question — whether a *patient* adversary observing many batches can build a classifier on re-use frequency, age, or other batch-level signatures — is real, and the methodology actively defends against it: calibration sampling is biased toward fresh-but-validated history, items rotate aggressively, and the sampling distribution itself is part of what the testbed evaluates as an attack surface.

Calibration items arrive on the same surface as real review work — `request_assignment` returns a review-kind task whose `proposal_id` may point at a staged proposal (real review) or at an accepted-from-history proposal (calibration). The reviewer cannot distinguish the two from the task they receive. When the reviewer votes via `cast_review_vote`, the server scores the vote against ground truth (calibration items have a known outcome — `accept` is correct, `reject` is incorrect) and adjusts the reviewer's reputation accordingly. Calibration votes do not re-resolve the underlying proposal; they only meter the reviewer. This makes calibration "just another assigned task" from the reviewer's perspective and a server-side scoring channel from the system's, which is what closes the [strategic-coalition vector](#adversary-testbed-and-simulation-first-governance) — a coalition that votes biased on real proposals also votes biased on calibration items they cannot identify, paying for the bias even when they win the convergence battle.

Reviewers who fail calibration lose reputation; the calibration corpus grows as the graph grows.

The reviewer's calibration record is also available to the convergence layer as a vote-weighting signal: a per-(cause, sub-topic) net-passes count that scales the weight a reviewer's vote carries when the server tallies convergence. Convergence requires both a minimum count of distinct reviewers (the redundant-peer-review invariant) and a minimum *weighted* sum (the bias-resistance signal); a reviewer whose calibration record went sour can hold a convergence open but cannot drive it. The [stratification-degraded](#reviewer-assignment) flag tightens both — distinct-reviewer count and weighted sum — when the assignment selector could not draw a diverse enough pool, so a proposal that lost its diversity defense recovers it through a higher convergence bar. This compounds with the rep-ledger penalty rather than replacing it: a coalition that misfires on calibration items pays once on the rep ledger and once at convergence. Calibration-aware adversaries — bias on real proposals, ground-truth on calibration items (a known PRD §Adversary-testbed target) — bypass this layer; they remain testbed work that builds on the seam, not regressions of it. Specific weight functions and minimum-count thresholds are testbed-tuned.

**Specific calibration items in active rotation are operationally private.** Published items are burned. Methodology — including the rotation regime and the sampling-distribution defenses against batch-level correlation attacks — is fully public; specific tuning is not.

### Reviewer-as-staking

Reviewers gain reputation when they accept proposals that survive and reject proposals that get rejected by other reviewers. They lose reputation when they accept proposals that are later reverted or fail calibration. This makes lazy rubber-stamp review costly without requiring reviewers to do more than they would already do well. The risk that staking selects against reviewers willing to engage hard syntheses is addressed by claim-difficulty-normalized review-credit (see [Reputation](#reputation)).

### Sub-topic creation

In v0:

- Proposed via `propose_sub_topic`.
- Curator evaluates against the criteria in [seed-topic.md](./seed-topic.md): articulable scope envelope, real disagreement, real audience, manageable corpus size, low political risk.
- The system computes feasibility hints from existing graph state: corpus density (do anchors exist?), anchor coverage (how much of the proposed scope envelope already has nodes?), projected closure distance.
- Curator accepts as `active`, defers as `proposed`, or rejects.

In Phase 3+: auto-discovery surfaces tractable scope envelopes from graph state; curator review remains as a check.

---

## Identity

The identity model is a requirements sketch in v0; specific tech (OIDC providers, key formats, attestations) is a Phase 1 implementation choice, but the *contract* the rest of the design depends on is fixed here.

- **Bounded identities-per-real-person.** Identity creation has a non-trivial cost — email verification at minimum, third-party OIDC (GitHub, ORCID, institutional SSO) preferred. The cost is tunable; the testbed sweeps it as a parameter. Zero-cost identities are not supported.
- **Agents act as a human's delegate.** The human is the identity holder; agents are credentialed clients authorized to act on their behalf. Reputation, capacity, calibration outcomes, and accountability all attach to the human, not the agent. A human may bind several agents (a desktop MCP client, a long-running daemon, custom tooling) under the same identity; they all draw from the same per-(cause, sub-topic) reputation pool and the same cause-level capacity declaration. Agent credentials are individually revocable by the human — losing a laptop or retiring a daemon does not require revoking the underlying identity — and curator revocation acts on the human, transitively disabling their agents. From the system's perspective an agent contributing on idle time and a human contributing directly are indistinguishable: both are tool calls authenticated as the same identity, drawing from the same capacity, accruing reputation to the same account. The bounded-identities-per-real-person property is preserved by construction; the agent layer does not multiply identities.
- **Pseudonymity is supported; anonymity is not.** A contributor may operate under a stable pseudonym; the system retains a binding between the pseudonym and the underlying identity-establishing credentials (email, OIDC subject) that curators can use under documented escalation. The graph and the public surface show the pseudonym; the binding is private.
- **Named credit on manuscript projections is opt-in.** Pseudonymous credit is allowed, but the project's recommendation is real-name credit for high-impact projections to retain academic legibility. Pseudonymous co-authorship is unusual and contributors should make that choice deliberately.
- **Revocation.** Identities can be revoked (sybil farms, terms-of-service violations). Revocation invalidates future participation without rewriting graph history; revoked contributions remain in the graph with the revocation flagged.
- **Cross-cause anti-abuse.** Public reputation is per-cause (see below). Anti-abuse signals (rate-limit accounting, identity-clustering for sybil detection) are *global per identity*, with documented governance and audit. The asymmetry — per-cause reputation, global anti-abuse — is intentional: sybil farms working two causes are more detectable than ones working one, and the cost of opacity here is small relative to the defense it enables.

The identity model is the foundation that sybil-resistance, calibration integrity, and reputation accounting all rest on. None of them composes meaningfully without it.

---

## Reputation

Reputation is structured to resolve a real trilemma the design cannot wave away: *slow* decay rewards consistency (the design goal) but lets patient adversaries stockpile; *fast* decay neutralizes stockpiles but disenfranchises episodic experts (the part-time clinician is exactly the contributor we want); *review-as-staking* punishes lazy review but selects against accepting hard syntheses (which are riskier to stand behind). Acknowledging this directly:

- **Two-component reputation.** A *demonstrated-competence* component, slow-decay, gates eligibility tiers (who is in the reviewer pool at all). A *recent-activity* component, fast-decay, gates assignment (who is drawn for a given proposal). A patient adversary can stockpile competence but must remain currently active to be assigned — and visible activity is detectable.
- **Per-(cause, sub-topic), accrued from assigned work.** Anchored at the cause level (the unit of belonging), refined by which sub-topics a contributor's *assigned* work has actually landed in. Sub-topic rep is therefore an emergent record of where the system has routed someone, not a self-declared specialty. This closes both the rep-laundering vector (no easy-sub-topic shopping) and the coalition vector (contributors can't pre-arrange to land on each other's proposals). Contributor-initiated work earns sub-topic rep at a substantially reduced weight, conditional on independent confirmation, to preserve a genuine novel-synthesis path without making it the laundering route.
- **Earned through confirmed contributions and accurate reviews.** Both contributing nodes that survive *and* reviewing accurately count.
- **Lost through reverted contributions and inaccurate reviews.** Supersedes and rejected calibration items both decrease reputation. Self-supersedes (a contributor superseding their own node) do not count toward survivorship — only supersedes by other contributors do.
- **Review-credit normalized by claim difficulty.** Without normalization, the regime selects for reviewers who accept easy proposals. Difficulty proxies — review effort, prior divergence, sub-topic frontier-distance — weight review-credit so that engaging hard syntheses is not dominated by rubber-stamping easy ones. The first-iteration difficulty proxy is the same per-proposal contention signal the cluster-stratification refinement already computes (`2 * min(accepts, rejects) / total_votes`): unanimous-easy items contribute zero contention to the cluster signal and earn reduced rep credit by the same primitive; perfectly-split contentious items contribute the full signal both places. The wired knob is `review_credit_contention_alpha`: reviewer rep deltas (gain on accurate, loss on inaccurate) scale by `alpha + (1 - alpha) * contention`, where `alpha = 1` (default) recovers the v0 uniform-credit regime exactly and `alpha < 1` is the difficulty-aware regime. *Implementation status:* the alpha primitive is wired and pinned end-to-end at three cells (alpha=0 unanimous → zero reviewer credit, alpha=0 split → contention-scaled credit, alpha=0.5 unanimous → half-credit). Default 1.0 preserves the v0 behavior; calibration credit (PRD §Calibration batches) flows through `bumpReputation` directly and is *not* alpha-scaled — the calibration path is ground-truth-individual, not convergence-derived, and stays a pure-honesty channel for the patient archetype's accumulation. The fifth parameter sweep cube re-baselines the patient-adversary gate-threshold cube under alpha < 1: with cube #2's thresholds (recent=0.5, demo=1.5) calibrated against the alpha=1 bootstrap demonstrated of 2.0, alpha=0.5 cuts the bootstrap demonstrated to 1.0 and the demo gate's value-comparison threshold (1.5) false-positive-locks-out honest reviewers at first request_assignment — the patient archetype's drift never starts, but the closure observation is misleading because honest review collapsed at the same gate. The cube reads ASR alongside a separate lockout-rate metric so "attack closed by gate" is distinguishable from "honest pool collapsed at the same threshold," and pins re-tuned thresholds at alpha=0.5 (recent=0.5, demo=0.75) that recover cube-#2's closure without the false-positive — demo scales by alpha to preserve honest-pool headroom; recent scales less because its quiet-window decay is dominated by alpha-invariant calibration credit. The patient-adversary signature (priming through easy unanimous accepts on well-grounded excerpts to harvest rep cheaply) is exactly the pattern alpha < 1 makes expensive on the convergence path; the calibration path stays the same drift-bandwidth seam it was at alpha=1. Proposer rep deltas are unscaled (the PRD passage scopes difficulty-normalization to *review* credit; the proposer's accept/reject outcome carries its own weight independent of how much disagreement the reviewers had on the way there).
- **Eligibility tiers public; numeric reputation private.** Contributors can see what tier they are in (and what gates the next tier); raw numbers are not leaderboards. Reviewers receive batch-level performance feedback after-the-fact, not in real time.
- **Non-transferable, non-monetizable.** Reputation is a coordination signal, not a token.
- **Specific formulas tuned in testbed.** Initial values are chosen for testbed simulation; production values are confirmed against attack-success-rate measurements.

---

## Credit

When a sub-topic produces a manuscript projection, contributor credit is computable from graph state.

The basic shape of the credit function:

- **Node provenance.** For each node included in the projection, who proposed it, who reviewed it, when.
- **Survivorship weighting.** Nodes that survived multiple supersedes events count more than nodes that barely survived one review.
- **Load-bearing weighting.** Nodes whose removal would break a projection chain count more than peripheral nodes.
- **Review weighting.** Reviewers who voted correctly accrue partial credit, weighted lower than proposers.

Credit is **deterministic given graph state and projection config**. It is not negotiated in a meeting. Authorship disputes route to (a) a versioned change to the projection config, evaluated by the same governance-change CI as any other governance change, or (b) a governance change to the credit function itself, also CI-evaluated. Both paths are public and auditable. Projection configs are not a back-channel.

Specific weights are deferred to the testbed.

---

## Adversary testbed

The testbed is the project's continuous-integration story for governance — and the cheapest credible artifact Anchorage can ship.

### Architecture

- **Real graph schema.** The testbed uses the same schema, the same write-path tools, the same MCP server interface as the public instance.
- **Simulated contributor population.** Synthetic contributors connect via the same MCP protocol, salted with the adversary taxonomy below.
- **Parameter sweeps.** Calibration ratios, reviewer-pool sizes, reputation decay rates, vote thresholds — swept over reasonable ranges, attack-success rates measured. Sweeps share an aggregate shape: each cell asserts the per-(attack pattern, defense config) outcome directly, and a paired aggregate test groups cells by defense config to lock in the per-config attack-success-rate. The first wired cube sweeps the cluster-signal knobs (anti-correlation threshold × contention-weighted edges) against the decorrelating and mixed-strategy coalitions; the second sweeps the assignment-gate thresholds (recent × demonstrated) against the patient-adversary and sybil-amplified-coalition archetypes, surfacing the orthogonal-defenses property — each gate closes its named pattern independent of the other knob, with full composition closing both. The third sweeps the encounter-domain widening (`stratum_include_declines` ∈ {off, on}) against the co-voting decorrelated and paired-decline multi-round coalitions and reads the *additive lift* declines provide on top of the vote-only signal: 50% ASR vote-only, 0% ASR decline-aware. The fourth cube is the companion measurement on the contention-weighting × paired-decline-floor interaction (`stratum_contention_weighted` × `stratum_decline_min_paired`) against the paired-decline coalition and the over-clustering false-positive that tests whether the floor preserves the closure under the small-honest-pool case where there's no fresh-singleton bypass; the (cw=on, floor=2) composition is the stable point at 0% ASR, (cw=on, floor=1) sits at 50% (the over-clustering pathology lands directly on contested), and the cw=off rows are inert because the full-weight rule for declines is a cw=on branch.
- **Public results.** Methodology and results published. Adversary populations and harness code open. Specific calibration items remain private.

### Why assignment-driven contribution closes several attack surfaces

Several adversary vectors that previously needed elaborate defenses collapse under assignment-driven contribution:

- **Reputation laundering** (build rep on easy sub-topics, parlay into contested ones) — closed by construction. Capacity is cause-level; sub-topic is the system's choice; sub-topic rep is an emergent record of routing.
- **Coalition pre-arrangement** (multiple identities landing on each other's proposals) — closed by construction. Reviewer assignment is system-driven; coalitions cannot pre-arrange the queue.
- **Calibration distinguishability via batch-level signatures** — narrowed substantially. Calibration items already arrive via assignment; with proposals also arriving via assignment, calibration is structurally indistinguishable from "the rest of the work" — it is just another assigned task.
- **Cherry-picking proposals to review** — closed. Reviewers do not select proposals; the system assigns them.

What remains, and what the testbed continues to exercise:

- **Patient adversary accepting clean assignments** to build rep over time, then drifting on a contested assigned proposal. Decay + two-component reputation + class-aware thresholds are the defenses.
- **Decline-pattern abuse** — declining everything outside the adversary's preferred sub-topic to approximate selectivity. Decline-tracking + curator escalation handle this.
- **Sybil farms providing capacity to absorb assignments** — global anti-abuse signals, identity-cost.
- **Hallucinated submissions on assigned tasks** — verification engine + reviewer responsibility.

### Adversary taxonomy

The testbed exercises the regime against the following synthetic contributor populations:

- **Honest-weak.** Modest-capability honest contributor (e.g. small local model). Should largely succeed; failure-to-contribute rate measures friction.
- **Honest-strong.** Frontier-model honest contributor on hard synthesis tasks. Should succeed even on cases where simpler contributors stall.
- **Lazy.** Reviewer that votes without reading. Should be caught by calibration.
- **Hallucinator.** High-temperature model with no grounding discipline. Should be caught at the verification engine (span mismatch, unresolved citations) before review.
- **Strategic adversary.** Hidden-objective model — instructed to bias the graph toward outcome X while passing calibration. Tests whether redundant peer review and reputation gates close the attack surface.
- **Patient adversary.** Strategic adversary with a long horizon — builds reputation honestly for months before drift attempts. Tests whether per-(cause, sub-topic) reputation tracking and review-as-staking prevent slow drift.
- **Sybil farm.** One operator running many identities at the per-identity cost set in the [identity model](#identity). Tests whether identity-binding, rate limits, and global anti-abuse signals prevent flood attacks.
- **Coalition.** Multiple identities coordinating reviews on each other's proposals. Tests whether reviewer-assignment stratification, calibration random-sampling, and the collusion-detection sample-size floor defeat coordination — and how the regime degrades on small sub-topics where the floor isn't reached.

### Continuous integration

Every governance change — calibration ratio, reputation formula, reviewer-assignment algorithm, sub-topic-creation rule, credit-function weight — runs against the adversary suite before merging. Proposals that fail simulation against known attacks do not merge.

The CI envelope has two tiers. A *fast loop* (cheap simulated populations, large numbers, low compute) runs on every governance-change PR. A *deep loop* (expensive populations including frontier-model adversaries, smaller numbers, higher compute) runs on a slower cadence and on changes that the fast loop flags as borderline. The honest framing is "a year of patient adversarial behavior in an hour" applies to the fast loop's cheap populations; the deep loop is where frontier-model patient adversaries live, and that loop is genuinely expensive.

Threshold definitions ("what counts as passing") are themselves versioned. Threshold changes go through the same CI process; threshold-loosening proposals require multi-curator approval and are publicly logged. The testbed protects against the simulated attacks; the threshold-versioning regime protects the testbed from being defeated by changing the meaning of "pass."

CI fails-shut: if the testbed infrastructure or model APIs are unavailable, governance changes do not merge. Liveness is sacrificed for safety. This is a deliberate choice and is acknowledged.

### What the testbed does *not* cover

- **Sophisticated human adversaries with out-of-band coordination.** State actors, well-funded interest groups, attackers willing to coordinate by phone, and attackers exerting political pressure on identifiable curators are not simulated. The residual risk is met by non-simulation defenses: curator vigilance, audit log, post-hoc forensics, and federation as an exit.
- **Senior expert hand-prose contributions.** Models do not reproduce these well. The simulation under-approximates the friction the regime imposes on them. Worth measuring against real contributors as soon as Phase 2 begins.
- **Phase 3+ failure modes.** Cross-cause reputation transfer, federation-induced collusion, multi-instance state synchronization. These are out-of-scope for Phase 1 testbed by design and gain testbed coverage when their phases open.
- **Novel attacks not yet in the adversary suite.** Passing the testbed is necessary, not sufficient. Continuous addition of new adversary archetypes is part of the testbed's maintenance cost.

This is the core load-bearing claim of the project, stated honestly. Wikipedia debates policy changes for years because it cannot test them; Anchorage tests them in an afternoon for the threat classes the testbed covers, and is honest about the threat classes it does not.

---

## What's deliberately not specified here

These are intentionally open until the testbed surfaces them:

- **Numeric calibration ratios** (what fraction of a reviewer's batch is calibration items).
- **Reputation formula constants** (gain weights for proposing, reviewing, surviving supersedes; decay rates).
- **Reviewer pool sizes** (N for a given proposal class).
- **Vote-aggregation thresholds** (what counts as convergent vs divergent).
- **Cross-cause reputation transfer** (does reviewer credibility on cause A transfer to cause B? Probably not in v0; testbed will check.)
- **Federation contracts** (Phase 3+ — when independent Anchorage instances exist, how their state and reviewer pools relate).

Specifying these before testing them would be guessing. The testbed exists exactly to replace guessing with measurement.

---

## What's deliberately not in this document

- **Operational moderation specifics.** Calibration items in active rotation, abuse-signal heuristics, specific moderation actions on the public instance. These are operationally private.
- **UI/UX design.** The web UI's specific surfaces are a separate document, written when the UI is built.
- **Implementation details.** Database choice, hosting, deployment story, specific languages and frameworks. These are not load-bearing for the design and will be decided when the code surface opens.

---

## References to internal documents

- [README.md](../README.md) — elevator pitch and mental model.
- [docs/manifesto.md](./manifesto.md) — why this exists, why now, why this shape.
- [docs/governance.md](./governance.md) — roles, contribution flow, reputation, calibration, dispute resolution at a higher abstraction level.
- [docs/seed-topic.md](./seed-topic.md) — the v0 cause and starter sub-topics.
- [ROADMAP.md](../ROADMAP.md) — phase plan and exit criteria.
