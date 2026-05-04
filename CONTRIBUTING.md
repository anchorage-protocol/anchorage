# Contributing to Anchorage

Anchorage is in design phase. There is no code surface to contribute to yet — the most useful contributions today are *to the design itself*. This file describes how to do that, and what the contribution flow will look like as the project grows.

## Right now: design contributions

The artifacts that exist today are documents: [README.md](./README.md), [docs/manifesto.md](./docs/manifesto.md), [docs/governance.md](./docs/governance.md), [ROADMAP.md](./ROADMAP.md), and (eventually) the PRD and seed-topic spec. These are the surface to contribute to.

The contributions we want, in priority order:

1. **Pressure-testing the design.** Issues that name specific failure modes — *"this governance scheme is vulnerable to attack X because Y"*, *"this calibration approach has flaw Z"*, *"the credit-from-graph model breaks when W happens."* Concrete > abstract. Specific > philosophical.

2. **Seed cause and sub-topic candidates.** Once `docs/seed-topic.md` lands, suggestions that fit its criteria are valuable. Until then, criteria suggestions are also welcome.

3. **Prior-art pointers.** Projects, papers, governance regimes, or simulation work we should be reading and citing. We try to list everything we owe to in the README's *Prior art* section; gaps there are real.

4. **Editorial sharpening.** Places where the docs are vague, contradictory, or overclaim. Smaller patches welcome.

How to contribute:

- **Open an issue.** Use the templates in [.github/ISSUE_TEMPLATE/](./.github/ISSUE_TEMPLATE/) — they help us route and respond.
- **Or open a PR directly.** For editorial changes, just send the diff. For substantive design changes, an issue first is usually faster.

## Later: code contributions

Once there is code, the flow will be standard:

- **PR-based.** Discussion in the PR; reviewer (initially the maintainer) merges or requests changes.
- **DCO required.** Sign your commits with `git commit -s`. This is the [Developer Certificate of Origin](https://developercertificate.org/) — a lightweight assertion that you have the right to contribute the change. We do not require a CLA. Inbound = outbound (your contribution is licensed under the same terms as the project: AGPL-3.0 for code, CC BY-SA 4.0 for data).
- **Tests required where they exist.** Adversary-testbed contributions especially need tests, since they're how we know governance changes work.
- **Direct push to `main`** for the maintainer; everyone else goes through PR review.

## Later: graph contributions (different from code)

When the public instance launches, *graph contributions* — proposing nodes, edges, anchors, syntheses, reviews — go through a different path entirely: the in-instance review queue, calibration, and reputation system described in [docs/governance.md](./docs/governance.md). That is the real cooperative-research workflow; this file is about contributing to *the project*, not *to a graph*.

## Code of Conduct

By participating, you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md). The short version: be kind, be honest, be specific. Disagree with the idea, not the person.

## License

Contributions are licensed under [AGPL-3.0](./LICENSE) (code) or [CC BY-SA 4.0](./LICENSE-DATA) (data and documents), matching the project's outbound license.
