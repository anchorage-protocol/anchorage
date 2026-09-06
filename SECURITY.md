# Security policy

Anchorage runs a public instance ([anchorage.science](https://anchorage.science) for reading, `mcp.anchorage.science` for the write path) that hosts its own OAuth 2.1 authorization server and holds contributor identities. Vulnerabilities in it are worth reporting, and this file says how.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability**, or [open a report directly](https://github.com/anchorage-protocol/anchorage/security/advisories/new). That channel is private between you and the maintainers until we publish an advisory together.

Please do not open a public issue for a vulnerability. Public issues are the right home for everything else, including the design pressure-testing this project actively wants — see [CONTRIBUTING.md](./CONTRIBUTING.md).

A useful report names the surface (`/mcp`, the OAuth endpoints, the web read-UI, the `anchorage-admin` CLI, the verifier's outbound fetches), what an attacker gets, and the smallest sequence that demonstrates it. A proof-of-concept against your own local instance is ideal; `docs/deploy.md` covers standing one up.

## What we commit to

This is a single-maintainer project, and the honest version of a disclosure policy says so rather than quoting enterprise SLAs:

- We acknowledge a report within **7 days**, and tell you whether we think it is a vulnerability within **30 days**.
- We fix what we agree is a vulnerability on the public instance first, then in the repository, and we publish an advisory once a fix is deployed.
- We credit reporters by name in the advisory unless you ask us not to.
- **There is no bug bounty.** Anchorage has no revenue and none planned ([README §What's open](./README.md#whats-open)); we cannot pay, and we would rather say that plainly than imply otherwise.

If a report stalls past those windows, escalating publicly is a reasonable thing to do — we would rather be embarrassed than have a live hole sit quietly.

## Testing against the public instance

Please test against a local instance where you can. Against the public one:

- **In bounds:** finding that a request is accepted or refused when it should not be, probing the OAuth flows with your own identity, checking the anonymous read surface.
- **Out of bounds:** denial of service and load testing (the instance is one small machine and the throttles are the thing you would break), attacks on other contributors' identities or content, mass-minting identities, and anything against NCBI or Crossref, whom the verifier calls on our behalf and who did not sign up for this.

If you need to exceed those bounds to demonstrate something real, ask first in a private report.

## What is not a vulnerability here

Two categories get reported to research platforms that are not security issues in this project, and knowing the difference saves everyone time:

- **A wrong or biased claim in the graph** is a research-quality problem, and the review machinery is the remedy: propose a supersedes, cast a review vote, raise it with a curator. That the graph can contain a wrong claim is the premise of the design, not a defect in it ([docs/governance.md](./docs/governance.md)).
- **A governance mechanism you can argue is gameable** is a design pressure-test, which this project wants in public. Open an issue with the design-pressure-test template, ideally with a testbed scenario that pins the failure. The testbed exists precisely so those arguments can be settled with measurements ([docs/phase1-results.md](./docs/phase1-results.md)).

The line between the second category and a vulnerability is roughly: if it needs the governance regime's own rules to be *followed* to work, it is a design question; if it works by breaking out of what the code lets a caller do, it is a vulnerability. When in doubt, report it privately and we will move it if it belongs in the open.

## Operational note

Anchorage keeps some enforcement detail operationally private — calibration items in rotation, abuse heuristics, specific moderation actions — under the principle that exposure should help reviewers more than attackers ([README §What's open](./README.md#whats-open)). An advisory may therefore describe a fixed vulnerability precisely while leaving the tuning that detects abuse of it unstated. Everything about the *rules* stays public.
