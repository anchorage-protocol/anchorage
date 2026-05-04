# PRD

> The technical north star: data model, interfaces, governance machinery, calibration, credit, adversary testbed. Where the [manifesto](./manifesto.md) explains *why* and [governance](./governance.md) sketches *who decides what*, this document specifies *how*.

This is a **design document**, not implementation specification. It captures commitments precise enough to build from, with parameters deliberately deferred to the adversary-testbed phase where they will be tuned against simulation rather than guessed.

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

- **MCP server** (`mcp.anchorage.science`): primary write-path interface. Contributors, agents, and the simulated populations in the testbed all connect here. Tools are typed; verification is server-side.
- **Web UI** (`anchorage.science`): read-mostly human surface. Browse causes, sub-topics, graphs, frontiers, and manuscript projections. Calls the same canonical service layer.
- **Service layer**: the trust boundary. Every mutation passes through verification, governance gates, and reputation updates here. Clients are untrusted regardless of identity.

This is a deliberate architectural commitment, not an implementation note. Federation between Anchorage instances later is MCP-to-MCP. The testbed connects via the same MCP interface real clients use — *no stub APIs*. This makes "the contributor population is in-distribution for simulation" architecturally enforced rather than aspirational.

---

## Data model

### Multi-scale structure

Three layers, each with the shape suited to its job:

- **Cause** — the umbrella unit of belonging ("colon cancer"). Causes are created by maintainers; they are not user-creatable in v0.
- **Sub-topic** — scope envelope within a cause ("ctDNA-MRD in stage II resected CRC"). Sub-topics are first-class objects: they have IDs, descriptions, scope-envelope queries (e.g. PubMed search definition), creation status (proposed / active / archived), and curator approval state. In v0 sub-topic creation requires curator approval; later phases admit auto-discovery from graph state.
- **Claim graph** — the per-sub-topic structure where work happens.

A claim node belongs to exactly one sub-topic. Cross-sub-topic relationships are expressed via designated *cross-link edges* (see Edges).

### Nodes

Every node has:

- `id` — opaque identifier
- `sub_topic_id` — the sub-topic this node belongs to
- `kind` — one of:
  - `anchor` — external source (paper, dataset, definition). Has `external_ref` (PMID, DOI, URL) that must resolve.
  - `excerpt` — tight claim tied to a specific anchor parent. Has a `quoted_span` field; the verification engine matches it against the resolved source. Excerpts cannot exist without a verified span.
  - `synthesis` — explicit inferential step derived from multiple parents. The agent or contributor sets `kind=synthesis` when the content is not a straight excerpt.
  - `open_question` — scoped uncertainty with edges to what it depends on. Surfaces as a frontier item.
- `content` — the claim text (single atomic claim per node)
- `external_ref` — for anchors, structured pointer (PMID/DOI/URL); for excerpts, references the parent anchor's external_ref
- `quoted_span` — for excerpts, the verifiable span text + offset within the source
- `status` — `staged` (under review), `active` (merged), `superseded` (replaced), `rejected` (review failed)
- `created_by`, `created_at`, `updated_at`

The **active node rule** (matching Galleon's contract): a node is *inactive* if it is the `from` end of a `supersedes` edge.

### Edges

- `derives` — parent (support) → child (derived claim). Direction matches storage. Lineage walks backward along `derives` until it hits anchors.
- `supersedes` — old → replacement. Marks the old node inactive.
- `cross_link` — explicit reference between sub-topics within the same cause. Used sparingly to express that a claim in one sub-topic depends on or relates to a claim in another. Cross-links do not propagate `derives` lineage across sub-topic boundaries; they are annotations.

Other edge types are rejected. The minimal vocabulary is load-bearing: more edge types create more places for governance disputes without proportionally more expressive power.

### Manuscript projection

A *projection* is a derived view of a sub-topic's graph plus editorial choices (section order, narrative voice, scope of inclusion). Projections are not a separate truth ledger — they are a function of (graph state, projection config). The graph is canonical; projections come and go.

---

## MCP tool surface

The MCP server exposes a small, verification-heavy set of tools. The minimum write surface is:

### Write-path tools

- **`propose_anchor`** `{ cause_id, sub_topic_id, content, external_ref }` → `{ proposal_id }`
  - Creates a staged anchor node. Server fetches `external_ref`, confirms resolution, and rejects on failure.
- **`propose_excerpt`** `{ cause_id, sub_topic_id, parent_anchor_id, content, quoted_span }` → `{ proposal_id }`
  - Creates a staged excerpt node. Server matches `quoted_span` against the resolved source. Mismatch → rejection. No exceptions.
- **`propose_synthesis`** `{ cause_id, sub_topic_id, parent_ids, content, kind }` → `{ proposal_id }`
  - Creates a staged synthesis or open_question node with `derives` edges from each parent. Atomic — either all edges create or none do. `kind` is `synthesis` or `open_question`.
- **`propose_supersedes`** `{ from_node_id, to_node_id, rationale }` → `{ proposal_id }`
  - Stages a supersedes edge with the reasoning attached.
- **`propose_cross_link`** `{ from_node_id, to_node_id, kind }` → `{ proposal_id }`
  - For cross-sub-topic references within the same cause.
- **`cast_review_vote`** `{ proposal_id, decision, rationale }` → `{ vote_id }`
  - `decision` is `accept`, `reject`, or `revise`. `rationale` is required and may itself be promoted to a graph node (typically `open_question`) by curators.
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
- **Tool: `fetch_calibration_batch`** `{ sub_topic_id }` → reviewer's review batch (real items + calibration items, indistinguishable from each other).

Tool surface is intentionally small. Each tool has tight typing, server-side validation, and clear failure modes.

---

## Verification engine

The verification engine is the security boundary. Every write tool routes through it.

- **Anchor verification.** External references must resolve. PMIDs hit NCBI E-utilities; DOIs resolve via Crossref; URLs must return 200 with substantive content. The fetched content is cached; cache age affects re-verification.
- **Span verification.** For excerpts, the `quoted_span` must be a substring of the fetched source (after light normalization for whitespace and quote-style). Failure rejects the proposal at write time, not at review time.
- **Lineage validation.** `derives` edges must connect nodes within the same sub-topic. `cross_link` edges may cross sub-topics within the same cause. `derives` from a non-existent or rejected node fails.
- **Reputation gates.** Some operations require minimum reputation (per-(cause, sub-topic) or per-cause). Below the threshold, proposals land staged but are not advanced into the review queue without curator action. Specific thresholds are tuned in the testbed.
- **Rate limits and abuse signals.** Per-identity rate limits on proposals; suspicious patterns (sudden burst of proposals, calibration-failure clustering) flag for curator review. Specific signals are operationally private.

---

## Governance machinery

### The contribution flow

1. **Propose** — write-path tool creates a *staged* node or edge.
2. **Verify** — verification engine accepts or rejects synchronously based on grounding/lineage/rate.
3. **Stage** — accepted proposals enter the review queue. Visible and citable as proposals; not part of the canonical graph.
4. **Assign** — N reviewers are randomly selected from the eligible pool, salted with calibration items drawn from the graph's own validated history.
5. **Review** — reviewers vote with rationale via `cast_review_vote`.
6. **Resolve** — convergent vote merges; divergent vote routes to a richer review path (more reviewers, curator escalation, or carrying the divergence forward as parallel synthesis nodes / `open_question`).
7. **Settle** — reputation updates for the contributor and the reviewers, weighted by outcome correctness.

### Reviewer assignment

Reviewers are drawn from the eligible pool — contributors with sufficient per-(cause, sub-topic) reputation — by stratified random sampling. Stratification balances reviewer expertise (where measurable) and reduces collusion risk. Specific stratification weights are tuned in the testbed.

### Calibration batches

Reviewer batches contain a mix of real proposals and calibration items. Calibration items are drawn from the graph's own validated history — proposals that survived multiple confirmations and have been stable. They are *indistinguishable* from real frontier work. Reviewers who fail calibration lose reputation; calibration corpus grows as the graph grows.

**Specific calibration items in active rotation are operationally private.** Published items are burned. Methodology is fully public; tuning is not.

### Reviewer-as-staking

Reviewers gain reputation when they accept proposals that survive and reject proposals that get rejected by other reviewers. They lose reputation when they accept proposals that are later reverted or fail calibration. This makes lazy rubber-stamp review costly without requiring reviewers to do more than they would already do well.

### Sub-topic creation

In v0:

- Proposed via `propose_sub_topic`.
- Curator evaluates against the criteria in [seed-topic.md](./seed-topic.md): articulable scope envelope, real disagreement, real audience, manageable corpus size, low political risk.
- The system computes feasibility hints from existing graph state: corpus density (do anchors exist?), anchor coverage (how much of the proposed scope envelope already has nodes?), projected closure distance.
- Curator accepts as `active`, defers as `proposed`, or rejects.

In Phase 3+: auto-discovery surfaces tractable scope envelopes from graph state; curator review remains as a check.

---

## Reputation

- **Per-(cause, sub-topic).** Anchored at the cause level (the unit of belonging), refined by sub-topics actually worked in (the unit of expertise).
- **Earned through confirmed contributions and accurate reviews.** Both contributing nodes that survive *and* reviewing accurately count.
- **Lost through reverted contributions and inaccurate reviews.** Supersedes and rejected calibration items both decrease reputation.
- **Slow-moving, with decay.** Tuned to reward consistency, not bursts. Inactive reputation decays over time.
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

Credit is **deterministic given graph state and projection config**. It is not negotiated in a meeting. Authorship disputes route to (a) re-running the credit function with corrected projection config, or (b) governance change to the credit function itself, which goes through the standard governance-change CI process.

Specific weights are deferred to the testbed.

---

## Adversary testbed

The testbed is the project's continuous-integration story for governance — and the cheapest credible artifact Anchorage can ship.

### Architecture

- **Real graph schema.** The testbed uses the same schema, the same write-path tools, the same MCP server interface as the public instance.
- **Simulated contributor population.** Synthetic contributors connect via the same MCP protocol, salted with the adversary taxonomy below.
- **Parameter sweeps.** Calibration ratios, reviewer-pool sizes, reputation decay rates, vote thresholds — swept over reasonable ranges, attack-success rates measured.
- **Public results.** Methodology and results published. Adversary populations and harness code open. Specific calibration items remain private.

### Adversary taxonomy

The testbed exercises the regime against the following synthetic contributor populations:

- **Honest-weak.** Modest-capability honest contributor (e.g. small local model). Should largely succeed; failure-to-contribute rate measures friction.
- **Honest-strong.** Frontier-model honest contributor on hard synthesis tasks. Should succeed even on cases where simpler contributors stall.
- **Lazy.** Reviewer that votes without reading. Should be caught by calibration.
- **Hallucinator.** High-temperature model with no grounding discipline. Should be caught at the verification engine (span mismatch, unresolved citations) before review.
- **Strategic adversary.** Hidden-objective model — instructed to bias the graph toward outcome X while passing calibration. Tests whether redundant peer review and reputation gates close the attack surface.
- **Patient adversary.** Strategic adversary with a long horizon — builds reputation honestly for months before drift attempts. Tests whether per-(cause, sub-topic) reputation tracking and review-as-staking prevent slow drift.
- **Sybil farm.** One operator running many low-rep identities. Tests whether identity-binding and rate limits prevent flood attacks.
- **Coalition.** Multiple identities coordinating reviews on each other's proposals. Tests whether reviewer-assignment stratification and calibration random-sampling defeat coordination.

### Continuous integration

Every governance change — calibration ratio, reputation formula, reviewer-assignment algorithm, sub-topic-creation rule, credit-function weight — runs against the adversary suite before merging. Proposals that fail simulation against known attacks do not merge.

This is the core load-bearing claim of the project. Wikipedia debates policy changes for years because it cannot test them; Anchorage tests them in an afternoon. That tempo difference compounds.

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
