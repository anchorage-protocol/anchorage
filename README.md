# Anchorage

> Open, cooperative research where every step is auditable, every contribution is checkable, and the work compounds across contributors instead of evaporating in chat windows.

Pick a cause that matters — colon cancer, antibiotic resistance, long-horizon climate response. Join. Your contributions, and those of every other contributor who cares about the same cause, accumulate into a shared, auditable map of what the literature actually supports. The map is alive: it grows, it heals, it identifies its own gaps, and on a regular cadence it produces published syntheses with named contributor credit.

Anchorage is the protocol and the public instance for that. The unit of contribution is small and verifiable. The unit of belonging is the cause. The graph is the work product, the calibration corpus, the credit ledger, and the review queue — one artifact, four roles, all open.

## What is this, in 60 seconds

The project is **multi-scale by design**:

- **Topics** are *causes*. Umbrella-scale, easy to relate to: "colon cancer," "antibiotic resistance," "post-acute sequelae of COVID-19." This is what contributors join. This is what fits on a poster. *"I'm helping fight colon cancer."*
- **Sub-topics** are *scope envelopes within a cause*: "ctDNA-guided adjuvant chemo decisions in resected stage II colon cancer," "Lynch syndrome surveillance intervals." This is where closure happens. This is where syntheses ship.

Sub-topics are first-class objects discovered through the system, not chosen up front. Contributors propose sub-topics; the graph state tells the system which proposals are tractable (corpus density, anchor coverage, projected closure distance); good ones attract effort and produce manuscripts; bad ones quietly fade.

Within a cause, the structure is a **claim graph** partitioned across sub-topics:

- **Anchors** are external sources (papers, datasets, definitions) with verifiable identifiers (PMID, DOI, URL).
- **Excerpts** are tight claims tied to a specific anchor, with a quoted span the system can verify against the source.
- **Synthesis** nodes are explicit inferential steps derived from multiple parents — the bridges, contrasts, and consolidations that turn a pile of citations into an argument.
- **Open questions** are scoped uncertainties with edges to what they depend on.

Each node has one **home sub-topic** (where it's reviewed and where its contributor's per-sub-topic reputation accrues) and zero or more **scope memberships** (other sub-topics it is legitimately in scope for). Memberships are themselves reviewable claims, so a definition or a landmark trial excerpt can serve several sub-topics without duplication. Edges are minimal: `derives` (parent supports child) and `supersedes` (this replaces that). Lineage walks backward along `derives` until it hits anchors. Every non-trivial assertion in the projected manuscript traces to nodes in the graph, or it gains nodes before it ships.

Contributors and agents connect via **MCP** (the primary write-path interface — Claude Desktop, Cursor, custom agents, lab-internal tooling all work out of the box); humans browse the same backend through a web UI. Contribution is *assignment-driven* by default: contributors declare cause-level capacity (rate, kinds of work) and the system routes specific tasks from the frontier; sub-topic selection is the system's choice, not the contributor's. This closes the easy-sub-topic-shopping vector that would otherwise let reputation be laundered. A contributor-initiated path exists for genuinely novel synthesis but accrues reputation at a reduced weight. Proposals are reviewed by system-assigned peers, salted with calibration items drawn from the graph's own validated history. Reputation is per-topic, emerging from where the system has routed each contributor. Hard syntheses get redundant attempts; convergence is signal, divergence becomes an `open_question`.

The output, when a sub-topic matures, is a **manuscript-shaped projection** of its graph: a publishable review or perspective where every claim is auditable and every contributor's stake is computable from their place in the graph that gave rise to the document. A topic doesn't produce a single manuscript; it produces a steady stream of sub-topic syntheses over years.

## Why now

Two things changed at once.

**Individual contribution to research got cheap.** LLMs let a curious person ground a claim, fetch a citation, propose a synthesis, or review a peer's reasoning at a fraction of the time and cost it took five years ago. The bottleneck for cooperative research stopped being individual capability and started being coordination, trust, and curation.

**Adversarial contribution got cheap too.** The same tools that help honest contributors let bad-faith actors flood any open system with plausible-sounding nonsense, fabricated citations, and patient drift toward biased syntheses. Wikipedia's governance regime took two decades to stabilize against motivated humans; LLM-era systems face the same adversaries at machine speed and machine cost.

These are the same problem. A system that's robust to weak honest contributors is most of the way to being robust against strategic adversaries — both push the same defenses (verifiable anchors, redundant review, calibration, staked reputation, simulation testing) into the design from day one.

Anchorage is a bet that **a system small enough to test exhaustively against a simulated adversarial population is large enough to make real cooperative research happen on top of it.** The unique technical asset is that a meaningful slice of the contributor population — the cheap-attack threat surface — is in-distribution for simulation: every governance change can be evaluated against simulated populations before it ships, with the residual classes (sophisticated human adversaries, senior expert hand-prose) addressed through non-simulation defenses. The [manifesto](./docs/manifesto.md#testability-is-the-secret-weapon) is honest about what the testbed does and does not cover.

## What's open

- **The protocol** — data model, write-path tools, governance machinery, scoring and credit logic. AGPL-3.0.
- **The graph data** — every node, edge, citation, and review on the public instance. CC BY-SA 4.0.
- **The simulation testbed** — adversary population, harness, parameter sweeps, results.
- **The roadmap** — what's planned, what's hand-waved, what's load-bearing and what isn't.

What stays operationally private:

- **Specific calibration items** in active rotation. Published items get burned.
- **Live-instance abuse signals and reviewer-fraud heuristics.** Methodology is public; specific tuning is not.
- **Specific moderation actions** on the public instance, by analogy with Wikipedia oversight.

The principle is simple: **the rules of the game are public; the enforcement details are operationally private only where exposure helps attackers without helping reviewers.**

There is no contributor license agreement. Inbound = outbound. DCO sign-off in commits is the only thing required.

## Status

Design phase. No code yet.

This repository currently contains the design and governance documents. Code, simulation testbed, and the first public instance follow once the design is stable enough to build from. Track [ROADMAP.md](./ROADMAP.md) for phasing.

## Documents

- [Manifesto](./docs/manifesto.md) — why this exists, why now, why this shape.
- [PRD](./docs/prd.md) — data model, governance, calibration, credit, adversary testbed.
- [Governance](./docs/governance.md) — contribution norms, review responsibilities, dispute resolution.
- [Roadmap](./ROADMAP.md) — phased plan from simulation testbed to public instance.
- [Seed topic](./docs/seed-topic.md) — the first cause the public instance will host, the starter sub-topics, and why. *(TBD)*

## Contributing

While the project is in design phase, the most useful contributions are:

- **Pressure-testing the design.** Issues that point at specific failure modes in the governance design are gold.
- **Seed cause and sub-topic candidates** that fit the criteria in [docs/seed-topic.md](./docs/seed-topic.md) once that file lands.
- **Prior-art pointers** we should be reading and citing — adjacent projects, governance regimes, simulation work — that aren't yet acknowledged.

Code contributions will open up once there is a code surface to contribute to. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the (currently lightweight) process.

## Prior art

Anchorage would not exist without — and owes its design to — work that came before:

- **Wikipedia** for the demonstration that open, peer-curated knowledge is possible at scale, and for the two decades of governance lessons we are reading carefully so we don't have to relearn them all.
- **Folding@home / SETI@home / BOINC** for distributed scientific computation and the credit/validation patterns that make donated compute trustworthy.
- **The Polymath Project** as a spiritual ancestor — open mathematical collaboration with named contributors and explicit positions.
- **Galaxy Zoo** for the redundant-classification pattern that turns disagreement into data.
- **OpenStreetMap** for the model of one shared truth with a rich talk layer.
- **Stack Overflow** for fast, structured peer review with reputation-as-coordination.
- **arXiv, Zenodo, OpenAlex, Crossref** for the open-science infrastructure stack we plug into.

We are an LLM-era descendant of all of them, not a replacement for any of them.

## License

- Code: [AGPL-3.0](./LICENSE)
- Data: [CC BY-SA 4.0](./LICENSE-DATA)
- The "Anchorage" name and any associated marks are reserved by the project to protect contributors and downstream users from impersonation. The code and data licenses above govern reuse; naming is a separate concern.
