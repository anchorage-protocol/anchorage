# Contributing to Anchorage

Anchorage is in Phase 2 (single-cause public instance, opened 2026-05-14; Phase 1's adversary testbed closed the same day). The design docs, the v0 MCP server, the testbed harness, and the Phase 2 slice plan are all open to contribution; what's appropriate right now is Phase 2 slice work (the slices in [ROADMAP §Phase 2](./ROADMAP.md#phase-2--single-cause-public-instance-opened-2026-05-14), starting with live-fetch verification), plus the standing surfaces — testbed extension, design pressure-testing, editorial sharpening. This file describes the surfaces and the flow.

## Surfaces to contribute to

Three surfaces, roughly in order of how often they take changes today:

1. **The design docs.** [README.md](./README.md), [docs/manifesto.md](./docs/manifesto.md), [docs/governance.md](./docs/governance.md), [docs/prd.md](./docs/prd.md), [docs/seed-topic.md](./docs/seed-topic.md), [ROADMAP.md](./ROADMAP.md). Pressure-testing, editorial sharpening, prior-art pointers — see priorities below.
2. **The adversary testbed.** New synthetic archetypes, attack scenarios, parameter-sweep cubes that pin defense closures as CI-checked ASR properties, refinements of cluster-signal / assignment-gate / reputation primitives. The testbed is where governance changes are validated before they touch user-facing surfaces (see Phase 1 in [ROADMAP.md](./ROADMAP.md)).
3. **The v0 MCP server.** Schema changes (in `packages/contracts`), tool implementations (in `packages/server`), and the MCP transport surface. Schema changes ride the docs-never-drift discipline — every commit that changes a contract updates both the contracts package and the matching PRD section in the same commit.

The contributions we want, in priority order:

1. **Pressure-testing the design and the testbed.** Specific failure modes — *"this governance scheme is vulnerable to attack X because Y"*, *"this archetype's behavior misses pattern Z"*, *"the cluster signal collapses when W happens."* Concrete > abstract. Bonus points if the failure mode comes with a testbed scenario that pins it.

2. **New attack patterns and defense refinements.** A new adversary archetype, a new parameter-sweep cube measuring an interaction the existing cubes don't, or a refinement to one of the cluster-signal / calibration / assignment-gate primitives. See ROADMAP §Status for the current frontier.

3. **Sub-topic candidates within colon cancer** (the locked v0 cause — see [docs/seed-topic.md](./docs/seed-topic.md) for the rationale). Suggestions that fit the criteria in seed-topic.md. Final v0 starter set is locked at instance-launch time, not now. Post-v0 causes are a separate flow once the public instance is running.

4. **Prior-art pointers.** Projects, papers, governance regimes, or simulation work we should be reading and citing. We try to list everything we owe to in the README's *Prior art* section; gaps there are real.

5. **Editorial sharpening.** Places where the docs are vague, contradictory, or overclaim. Smaller patches welcome.

## How to contribute

- **Open an issue.** Use the templates in [.github/ISSUE_TEMPLATE/](./.github/ISSUE_TEMPLATE/) — they help us route and respond.
- **Or open a PR directly.** For editorial changes, just send the diff. For substantive design changes, an issue first is usually faster.

## Code contribution flow

- **PR-based.** Discussion in the PR; reviewer (initially the maintainer) merges or requests changes.
- **DCO required.** Sign your commits with `git commit -s`. This is the [Developer Certificate of Origin](https://developercertificate.org/) — a lightweight assertion that you have the right to contribute the change. We do not require a CLA. Inbound = outbound (your contribution is licensed under the same terms as the project: AGPL-3.0 for code, CC BY-SA 4.0 for data).
- **Tests required.** Adversary-testbed and server changes both need tests; the testbed is how we know governance changes work, and the server's behavior is the surface the testbed exercises.
- **Docs-never-drift.** Commits that change a contract (data model, tool surface, governance rule, parameter range) update the matching PRD section in the same commit. Commits that wire a new defense or close a new attack update ROADMAP §Status. The docs are the spec, not retrospective documentation.
- **Direct push to `main`** for the maintainer; everyone else goes through PR review.

## Later: graph contributions (different from code)

When the public instance launches, *graph contributions* — proposing nodes, edges, anchors, syntheses, reviews — go through a different path entirely: the in-instance review queue, calibration, and reputation system described in [docs/governance.md](./docs/governance.md). That is the real cooperative-research workflow; this file is about contributing to *the project*, not *to a graph*.

## Code of Conduct

By participating, you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md). The short version: be kind, be honest, be specific. Disagree with the idea, not the person.

## License

Contributions are licensed under [AGPL-3.0](./LICENSE) (code) or [CC BY-SA 4.0](./LICENSE-DATA) (data and documents), matching the project's outbound license.
