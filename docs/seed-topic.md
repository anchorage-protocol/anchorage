# Seed topic

> The first cause Anchorage's public instance will host, the starter sub-topics it ships with, and the rationale behind both.

## The umbrella cause: colon cancer

Anchorage's first cause is **colon cancer**. *"I'm helping fight colon cancer"* is the sentence a contributor says about the project — and a sentence many people would happily say.

Why colon cancer specifically:

- **High social value, immediately relatable.** Second-leading cause of cancer death. Almost everyone has a friend or relative who has been touched. The cause-as-unit-of-belonging works without explanation.
- **Stable, well-indexed corpus.** PubMed handles it cleanly, full-text access is decent for major journals, identifiers are stable. The verifiable-anchor write path works out of the box.
- **Deep enough that sub-topics will keep emerging for years.** Screening, hereditary syndromes, microbiome, immunotherapy, surgical oncology, ctDNA, chemoprevention, survivorship — many sub-areas with their own literatures and specialists.
- **Real disagreement across many sub-areas.** Anchorage's machinery (multi-parent synthesis, parallel positions, `open_question` nodes) earns its keep where the field actually disagrees, not where it has settled.
- **Decidable scope.** "Colon cancer" has well-understood boundaries. Not the "all of medicine" failure mode.
- **Manageable political surface.** Disagreements are evidentiary, not culture-war. Pharma stakes exist (chemo, immunotherapy) but are bounded — not the level of GLP-1 obesity or aducanumab.

## Why not other strong candidates

For the *first* cause, several otherwise-strong candidates were eliminated:

| Eliminated cause | Why not for v0 |
|---|---|
| Long COVID (neurological subtypes) | Identity-politics overlay; bad first impression for governance |
| GLP-1 RAs for non-diabetic obesity | Too active (hundreds of papers/month); pharma stakes too high; first-mover-of-attack risk |
| Aducanumab / Lecanemab for early Alzheimer's | Pharma-political minefield |
| Microplastics and human health | Bad-science-to-good-science ratio could overwhelm v0 governance — *exactly the case Anchorage will eventually shine on*, but only after the testbed has hardened the regime against a noisier corpus |
| Vitamin D supplementation outcomes | Corpus too wide; sub-topics fragment without coherent umbrella |
| LR schedules for chinchilla-optimal LLM training | Fights the "open research as public good" recruitment narrative the first cause depends on |

These are not bad causes. Several may be excellent later-phase causes, especially microplastics. But none is the right *first* cause.

## Starter sub-topics

When the public instance launches, it ships with **one** hand-seeded starter sub-topic so contributors arrive to something concrete; the second and third are seated from the shortlist below on a maturity-or-contributor signal, not all at launch — concentration, not breadth, is what lets the redundant-review mechanic work at low contributor count (see [ROADMAP §Phase 2](../ROADMAP.md#phase-2--single-cause-public-instance-opened-2026-05-14)). The shortlist below is the candidate set; which sub-topic opens first is locked at launch, the rest as the instance matures.

### Strongly favored

**ctDNA-guided adjuvant chemo decisions in resected stage II colon cancer.** Tight corpus (~300-600 papers post-2018), active disagreement (CIRCULATE-Japan, DYNAMIC, GALAXY, BESPOKE-CRC are the spine), real clinical-decision impact, low political risk. Manuscript projection target: a synthesis of when ctDNA-positive justifies escalation and when ctDNA-negative justifies de-escalation, traceable to specific trials.

**Lynch syndrome surveillance intervals.** Narrow hereditary-CRC question, real disagreement on optimal colonoscopy intervals by gene (MLH1 vs MSH2 vs MSH6 vs PMS2), bounded corpus, clear audience (genetic counselors and GI clinicians). Manuscript projection target: a synthesis of gene-specific intervals with the evidence chain explicit.

**Screening age initiation for average-risk CRC in the US.** The 45-vs-50 question. Bounded, contested, recently moved by USPSTF, clear primary-care audience. Slight risk of being "too settled" by the time the synthesis ships — but closure is a feature in that case, not a failure.

### Held in reserve

**Aspirin for CRC chemoprevention in average-risk adults.** 50-year literature, real disagreement (USPSTF moved the recommendation back and forth), recent landmark trials (ASPREE, CRC-specific data). Solid candidate but slightly more settled than ctDNA-MRD; better as a second-wave sub-topic.

**Microbiome signatures predictive of CRC risk.** A claim graph is uniquely valuable here — the field has clarity problems, and making the evidence chain explicit would separate established from speculative claims. *But* the corpus noise is exactly what would stress v0 governance hardest. Defer until the regime has been exercised on cleaner sub-topics first.

### Tentative v0 starter set

ctDNA-MRD + Lynch surveillance + screening age. Covers three distinct dimensions of the cause (treatment, hereditary, screening), each with real audience and real disagreement. Final selection happens at launch.

## Criteria a sub-topic must meet to be hand-seeded

For instance launches, a sub-topic is acceptable as a starter only if it meets all of the following:

- **One-sentence question** that names the population, the intervention/exposure, and the outcome of interest.
- **Articulable scope envelope** — typically expressible as a PubMed query that returns roughly 200 to 1500 papers. Wider drowns the graph; narrower starves it.
- **Real disagreement** — not "edge case nobody cares about." Two reasonable expert groups genuinely disagree, and the disagreement decomposes into specific claims rather than vibes.
- **A real audience** that would *use* the projected manuscript. ~500 readers minimum is a reasonable bar; if it's "5 people," skip.
- **Stable identifier infrastructure** — PMID/DOI for the corpus. (Span verification in v0 is *abstract-level*: the verifier matches against the PubMed abstract / Crossref title+abstract, not full text — see [PRD §Verification engine](./prd.md#verification-engine). Full-text span verification is the Phase-3 target this criterion anticipates; until it lands, claims grounded in full-text-only detail can't be anchored honestly.)
- **Low first-instance political risk.** Evidentiary disagreement is welcome; culture-war and pharma-political disagreement is for after the regime has hardened.

## Out-of-scope sub-topics (for v0 specifically)

Even within colon cancer, certain sub-topics are deliberately not v0 candidates:

- **Anything tied to a single drug currently being marketed in active commercial pressure** (specific immunotherapy regimens with active pharma campaigns).
- **Diet-and-CRC questions broadly.** The literature is messy in ways that mirror microbiome — defer until governance has been exercised on cleaner cases.
- **Patient-decision-aid synthesis** as a v0 sub-topic. The audience is real but the work shape is more advocacy than synthesis; better as a downstream projection of clinical sub-topics.

## Process for adding sub-topics later

After v0, sub-topic creation follows the curator-gated process described in [governance.md](./governance.md): anyone proposes via issue or in-instance proposal; curators evaluate against the criteria above; the system tracks corpus density and anchor coverage to inform the decision. Auto-discovery is a Phase 3 feature.
