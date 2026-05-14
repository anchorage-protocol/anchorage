# Anchorage — Claude project context

> Project-scoped briefing for Claude sessions working in this repo. Read this first.

## What Anchorage is, in one paragraph

A protocol and public instance for **cooperative open research with auditable lineage**. Contributors join a *cause* (colon cancer, antibiotic resistance, etc.); within a cause they work in *sub-topics* (narrow scope envelopes); within a sub-topic the work is **atomic claims with explicit parents** that the system can verify, peer-review, and project into manuscript-shaped output with named contributor credit. The graph is the work product, the calibration corpus, the credit ledger, and the review queue — one artifact, four roles, all open.

## What lives where

| File | What it commits to | When to update it |
|---|---|---|
| [README.md](./README.md) | Elevator pitch, mental model, status, prior art, license, doc index | When the public face of the project changes substantively |
| [docs/manifesto.md](./docs/manifesto.md) | The "why this exists, why now, why this shape" longer narrative | When the framing or the bet changes — load-bearing reasoning |
| [docs/prd.md](./docs/prd.md) | Technical north star: data model, governance machinery, calibration, credit, adversary testbed | When design specifics change. This is where details that are too granular for the manifesto live. |
| [docs/governance.md](./docs/governance.md) | Roles, contribution flow, reputation, calibration, dispute resolution, what's operationally private | When governance commitments evolve. Skeleton today; expanded as Phase 1 specifies parameters. |
| [docs/seed-topic.md](./docs/seed-topic.md) | Locked umbrella cause + starter sub-topic candidates + elimination rationale | When the seed cause or starter sub-topics are re-evaluated (rare; this is supposed to be stable) |
| [ROADMAP.md](./ROADMAP.md) | Phase plan and exit criteria for each | When a phase finishes or a new phase opens |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to contribute, contribution priorities, DCO requirement | When the contribution flow changes |
| [packages/contracts](./packages/contracts) | Executable spec: zod schemas + types for nodes, edges, identity, causes, sub-topics, proposals, assignments, MCP tool I/O. The field-level source of truth. | Whenever a contract changes — and update the matching PRD section in the same commit (docs-never-drift). |
| [packages/server](./packages/server) | The MCP server: graph store, verification, governance machinery, identity. The trust boundary. | When server-internal behavior changes. Public surface changes go through `contracts`. |
| [packages/testbed](./packages/testbed) | Adversary harness + synthetic contributor archetypes. Talks to the server over MCP only — by build-system construction, no path to server internals. | When archetypes, harness behavior, or parameter sweeps change. |
| [LICENSE](./LICENSE) | AGPL-3.0 (code) | Don't |
| [LICENSE-DATA](./LICENSE-DATA) | CC BY-SA 4.0 (data and documents) | Don't |

## Phase awareness

**Phases 0 and 1 closed 2026-05-14.** Anchorage is between phases — Phase 1's exit criterion (a comprehensive adversary testbed with a published results snapshot, see [docs/phase1-results.md](./docs/phase1-results.md)) is met, and Phase 2 (single-cause public instance with real human contributors) has not yet begun. This gates what kind of work is appropriate:

- **Between Phase 1 and Phase 2**: testbed extension is welcome (more cube cells, more drift kinds, more closure-stack experiments) but no longer load-bearing for any phase exit — every named axis already has measured coverage. The lockstep doc-update discipline still applies to any contract change. New work that anticipates Phase 2 (auth, identity backend, web UI scaffolding, live-fetch verification) is not yet appropriate — wait for the phase to formally open.
- **Phase 2**: single-cause public instance with real human contributors. Documented in [ROADMAP.md](./ROADMAP.md).
- **Phase 3+**: documented in [ROADMAP.md](./ROADMAP.md).

**The user-exposure boundary between Phase 1 and Phase 2 is what's load-bearing**: no real users meet the system until Phase 2's scaffolding lands. Doc-then-code sequencing is *not* load-bearing; sim-then-prod sequencing is.

The original Phase 1 exit criterion called for "third-party replication" of the published results; this was a category error and has been corrected ([ROADMAP §Phase 1](./ROADMAP.md#phase-1--adversary-testbed-closed-2026-05-14) carries the rationale). Sim and prod are by-construction indistinguishable from the system's perspective; cassettes pin every byte across the wire; the model is a published API; the code is open. A third-party rerun has no epistemic advantage over an in-house rerun. Reproducibility was the load-bearing property and is satisfied. Extending the sweep is incremental work in the same testbed and does not gate Phase 2.

## Load-bearing design commitments

These are settled. Challenge them only with strong new evidence, not casual rethinking.

- **Multi-scale graph**: cause → sub-topic → claim. Recruitment runs at the cause; closure runs at the sub-topic; verification runs at the claim.
- **MCP-first architecture**: the primary write-path interface is an MCP server (`mcp.anchorage.science`). Any MCP-capable client (Claude Desktop, Cursor, custom agents, simulated populations in the testbed) participates without bespoke SDKs. Web UI exists for human browsing of the same backend. Federation between instances is MCP-to-MCP.
- **Agent-as-delegate identity**: the human is the identity holder; agents are credentialed delegates acting on the human's behalf. Reputation, capacity, and accountability attach to the human, not the agent. One human may bind several agents under the same identity. Bounded-identities-per-real-person is preserved by construction; the agent layer does not multiply identities.
- **Simulation-first governance**: every governance change CI-checked against simulated adversarial populations before merging. The testbed is permanent infrastructure, not a launch tool. **Sim and prod are by-construction indistinguishable from the system's perspective** — same MCP interface, same identity model, same auth, same verification, same reputation, same governance state machine. The only difference is who is on the other end of the connection. No `if (sim) ...` branching in the codebase, ever. This is what lets testbed results transfer to production by construction; without it the testbed is a fiction.
- **Verifiable-anchor write path**: excerpts must include a quoted span the backend matches against the source; PMID/DOI must resolve. Enforced at the tool layer.
- **Redundant peer review with calibration**: N reviewers per proposal, salted with calibration items drawn from the graph's own validated history. Reviewer-as-staking.
- **Reputation per-(cause, sub-topic)**: anchored at cause, refined by sub-topic. Non-transferable, non-monetizable, no token.
- **Credit from graph**: contributor credit on manuscript projection is computable from graph state.
- **Sub-topic creation is curator-gated in v0**; auto-discovery is a Phase 3 feature (PRD §Sub-topic creation, ROADMAP §Phase 3).
- **No CLA. DCO sign-off only.** Inbound = outbound.
- **Direct push to `main`** for maintainers; PRs for everyone else.

## Conventions for working in this repo

- **Improve the repo proactively.** When you spot a solid opportunity — a contradiction between docs, an underspecified load-bearing point, prose hiding an ambiguity a careful reader would catch, a section out of step with a more recent commitment — flag it and, if the fix fits the current phase, do it. Don't wait to be asked. The bar is "solid opportunity," not "any nit"; load-bearing commitments aren't casually relitigated, and improvements stay inside the current phase's allowed work. When unsure about scope, surface the observation rather than acting silently. This applies to every agent that ever inspects this repo, not just the current session.
- **Docs and code never drift apart.** Every commit that changes a contract (data model, tool surface, governance rule, parameter range, identity model) updates both the docs and the code in the same commit. The docs are the spec, not retrospective documentation; a commit that updates one without the other is a bug. This is what made concurrent Phase 0 + 1 development safe — without lockstep discipline, "concurrent" degenerates into "code is truth, docs are aspirational." The discipline holds beyond Phase 0 closure because the underlying invariant is unchanged: the docs are still the spec.
- **Reference PRD content by section, not by line number.** Cite `PRD §Section name` (with a quoted distinctive phrase if finer granularity is needed), never `PRD line N`. Line numbers shift every time the PRD is edited; section anchors don't. Applies to ROADMAP, code comments, test names, and commit messages.
- **Doc edits go to `main` directly** when made by the maintainer; no PR ceremony for design-doc work. PRs are for external contributions.
- **Commits are DCO-signed** (`git commit -s`).
- **No emojis in repo files** unless explicitly requested.
- **Don't write new docs that aren't referenced from README.md** — orphan files signal disorder. If a new doc is needed, link it from README.
- **Don't add files implying activity that hasn't happened** — no CHANGELOG, no contributor stats, no fake-mature signals.
- **Prior art belongs in the README's *Prior art* section.** Lessons we owe specific projects belong in PRD or manifesto sections that reference them.

## What's *not* in this repo (and shouldn't drift in)

- The genesis register / how-it-all-began story. That lives in the platform repo at `apps/hull/docs/anchorage.md` (private). Don't recreate it here.
- Operational moderation specifics (calibration items in active rotation, abuse heuristics tuning). These are deliberately operationally private — public methodology, private specifics.
- Any token, marketplace, paid tier, or monetization scheme. Anchorage is funded by reputation and credit, not money.

## Naming finality

The name is **Anchorage**. It survived five rounds of collision checks. Don't propose renames — every obvious alternative in this space is taken. If you find yourself thinking "wouldn't X be a better name?", check whether X has been ruled out in the genesis register first. Almost certainly yes.

## Working style

- Match the doc tone: substantive, honest about uncertainty, no fake-mature signals, no hedging-for-hedging's-sake. The README and manifesto are the style references.
- Prefer editing existing docs over creating new ones.
- When in doubt about whether something belongs in manifesto vs PRD vs governance: manifesto is *why*, PRD is *how*, governance is *who decides what*.
