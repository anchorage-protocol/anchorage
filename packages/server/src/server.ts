import {
  type AgentCredential,
  type AnchorNode,
  type Assignment,
  type AssignmentId,
  type AssignmentTask,
  CastReviewVoteInput,
  type CastReviewVoteOutput,
  type Cause,
  type CauseDirectory,
  type CauseId,
  type ContributorProfile,
  type CreditAttribution,
  type DerivesEdge,
  type Edge,
  type ExcerptNode,
  FetchCalibrationBatchInput,
  type FetchCalibrationBatchOutput,
  type FrontierItem,
  type Identity,
  type IdentityId,
  type Manuscript,
  type ManuscriptCitation,
  type ManuscriptSection,
  type Node,
  type NodeId,
  type NodeNeighborhood,
  type OpenQuestionNode,
  type PrincipalStatus,
  type Proposal,
  type ProposalId,
  type ProposalPayload,
  ProposeAnchorInput,
  type ProposeAnchorOutput,
  ProposeChangeOfHomeInput,
  type ProposeChangeOfHomeOutput,
  ProposeExcerptInput,
  type ProposeExcerptOutput,
  ProposeMembershipInput,
  type ProposeMembershipOutput,
  ProposeSubTopicInput,
  type ProposeSubTopicOutput,
  ProposeSupersedesInput,
  type ProposeSupersedesOutput,
  ProposeSynthesisInput,
  type ProposeSynthesisOutput,
  type PublicReputationEntry,
  type PublicReputationTier,
  QueryFrontierInput,
  type QueryFrontierOutput,
  QueryProposalsInput,
  type QueryProposalsOutput,
  QueryReputationInput,
  type QueryReputationOutput,
  type Reputation,
  type ReputationEntry,
  RequestAssignmentInput,
  type RequestAssignmentOutput,
  type ReviewBatchItem,
  type ReviewVote,
  type Subgraph,
  type SubTopic,
  type SubTopicDetail,
  type SubTopicId,
  type SupersedesEdge,
  type SynthesisNode,
  Timestamp,
  WorkKind,
} from '@anchorage/contracts';
import { z } from 'zod';
import {
  type Authenticator,
  type Caller,
  HarnessAuthenticator,
  hashBearerSecret,
  resolveCaller,
} from './auth.js';
import { type Clock, SystemClock } from './clock.js';
import { ServerError } from './errors.js';
import { type IdGen, RandomIdGen } from './id-gen.js';
import { MemoryStore, type Store } from './store.js';
import { StructuralVerifier, type Verifier } from './verifier.js';

// Bootstrap input schemas. These are admin-surface inputs and are
// deliberately separate from the contributor-facing MCP tool I/O in
// `@anchorage/contracts/tools.ts` — see PRD §MCP tool surface
// (admin-surface paragraph: "A separate admin surface — not exposed
// as MCP tools — covers the curator-only operations").
const MintIdentityInput = z
  .object({
    display_name: z.string().min(1).max(100),
    // PRD §Identity bullet 1: the IdP records `attestation_level` at
    // mint, opaque to the server (the server gates on threshold; it
    // does not interpret the level's units). Optional in the admin
    // input — testbed scenarios that don't exercise the gate mint at
    // 0 by default and inherit the inert-gate behavior.
    attestation_level: z.number().nonnegative().optional(),
    // Slice 3c: the IdP that issued this identity. Defaults to
    // `'harness'` for admin/testbed mints (the previous behavior).
    // The `GithubOAuthAuthenticator` mints via this same admin
    // surface with `identity_provider: 'github'` + a subject; the
    // entry point is unified by construction so sim and prod produce
    // structurally identical records.
    identity_provider: z.enum(['harness', 'github']).optional(),
    // Required when `identity_provider` is an IdP-driven provider
    // (anything other than `'harness'`); refused otherwise. Server
    // validates this conditionally at mint time — the strict schema
    // can't express the dependency, so the check lives in the
    // bootstrap method.
    identity_provider_subject: z.string().min(1).max(200).optional(),
    // Slice 4b: the role the minted identity carries. Defaults to
    // `'contributor'`. `'curator'` is gated to `'harness'`-provider
    // mints only — the bootstrap method refuses
    // `(identity_provider: 'github', role: 'curator')` so an OAuth
    // signin can never auto-promote into the curator pool. The
    // admin CLI (`anchorage-admin mint-curator`) is the only path
    // that produces curator identities.
    role: z.enum(['contributor', 'curator']).optional(),
  })
  .strict();
type MintIdentityInput = z.infer<typeof MintIdentityInput>;

const BindAgentCredentialInput = z
  .object({
    identity_id: z.string().min(1),
    label: z.string().min(1).max(100),
  })
  .strict();
type BindAgentCredentialInput = z.infer<typeof BindAgentCredentialInput>;

// The caller receives both the stored record and the freshly-minted
// bearer secret. The secret is the opaque token an MCP client presents
// at the Authenticator seam (PRD §Identity); it is not stored anywhere
// — the server keeps only `credential.secret_hash` — so this is the
// only moment the plain value is available. The caller is responsible
// for forwarding it to the agent that will use it (or, in tests, for
// stashing it in a local variable).
export interface BindAgentCredentialResult {
  credential: AgentCredential;
  secret: string;
}

const CreateCauseInput = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().min(1),
  })
  .strict();
type CreateCauseInput = z.infer<typeof CreateCauseInput>;

const SeedSubTopicInput = z
  .object({
    cause_id: z.string().min(1),
    name: z.string().min(1).max(200),
    description: z.string().min(1),
    scope_query: z.string().min(1),
  })
  .strict();
type SeedSubTopicInput = z.infer<typeof SeedSubTopicInput>;

// Vote-aggregation thresholds and reputation weights (PRD §What's deliberately not specified here,
// testbed-tuned). Defaults here are starting points for the testbed to
// swap as it sweeps; they are deliberately small so basic walking-
// skeleton scenarios converge inside one or two votes and produce
// observable reputation deltas.
export interface ReviewConfig {
  // Number of `accept` votes needed before the proposal auto-accepts
  // (without curator action). PRD §The contribution flow (Resolve step): convergent vote merges.
  votes_to_accept: number;
  // Number of `reject` votes needed before the proposal auto-rejects.
  votes_to_reject: number;
  // Reputation gain to the proposer when their proposal converges to
  // accepted (PRD §Reputation: "Earned through confirmed
  // contributions"). Multiplied by `contributor_initiated_factor` for
  // proposals not tied to an assignment_id (PRD §Reputation).
  proposer_accepted_gain: number;
  // Reputation loss to the proposer when their proposal converges to
  // rejected (PRD §Reputation: "Lost through reverted contributions").
  proposer_rejected_loss: number;
  // Reputation gain to a reviewer who voted with the converged
  // outcome (PRD §Reputation: "reviewing accurately").
  reviewer_accurate_gain: number;
  // Reputation loss to a reviewer who voted against the converged
  // outcome (PRD §Reputation: "inaccurate reviews").
  reviewer_inaccurate_loss: number;
  // Multiplier applied to *proposer* gain/loss when the proposal was
  // contributor-initiated rather than assignment-driven. PRD
  // §Reputation: "Contributor-initiated work earns sub-topic rep at
  // a substantially reduced weight." 0 ≤ factor ≤ 1; defaults to 0.5.
  contributor_initiated_factor: number;
  // Curator escalation tiebreak rule: how the between-rounds curator
  // pass (`escalateStuckProposals` in `population-loop.ts`) interprets a
  // `revise` vote when resolving a stuck proposal. v0 default (false):
  // `revise` is ignored in the escalation tally — only `accept` and
  // `reject` votes count, and the rule is `r > a ? reject : accept`
  // (accept on a tie, including the no-votes case where every excerpt
  // here already passed span verification at write time so accept is
  // the productive default). v1 (true): `revise` is counted toward the
  // reject side — `r + revise > a ? reject : accept` — capturing the
  // load-bearing fact that a careful reviewer voting "revise" is not
  // endorsing the proposal. The cube's `borderline-contested` cell
  // recorded the v0 closure failure that motivated this knob (PRD
  // §Continuous integration): a strategic adversary's drift accept + an
  // honest reviewer's careful revise + another honest reviewer's reject
  // resolved to accept under v0 because revise didn't count; the
  // `borderline-contested-v1` cell flips this knob on, the same
  // 1-accept-1-reject-1-revise tally now resolves to reject. The knob
  // only governs the *escalation* tiebreak — the auto-closure
  // thresholds (`votes_to_accept` / `votes_to_reject`) are unchanged,
  // so the load-bearing distinction (revise-as-non-endorsement) lands
  // only where it matters for closure (when no affirmative majority
  // formed in the round, a stuck proposal with revise votes resolves
  // to reject rather than slipping through on the accept-on-tie
  // default). Defaults false so every existing scenario, golden
  // cassette, and scripted-cube cell preserves its v0 outcome; the cube
  // sweeps v0 vs v1 on the borderline-contested item to read the
  // closure delta.
  escalation_revise_counts_as_reject: boolean;
  // Curator escalation affirmative-threshold rule. v0 default (false):
  // the curator escalation closes a stuck proposal accept whenever the
  // accept side wins (or ties, with `escalation_revise_counts_as_reject`
  // governing how revise factors in) — so a single accept vote, or a
  // 1-1 tie with no revise vote, escalates to accept. v1 (true):
  // escalation-to-accept additionally requires `accepts >= votes_to_accept`
  // — the same affirmative-supermajority threshold the auto-closure path
  // already enforces during normal voting (PRD §The contribution flow,
  // Resolve step). Composes orthogonally with
  // `escalation_revise_counts_as_reject`: that knob handles the
  // revise-in-the-tally case; this one handles the case where the
  // accept side is thin regardless of revise — a single accept or a
  // plain 1-1 tie on a contested item should not slip through the
  // escalation pass on the accept-by-default rule. Together they
  // tighten the escalation rule into "accepts beat all non-accept
  // votes AND accepts meet the same affirmative-supermajority floor
  // the auto-closure path uses". The cube's `borderline-contested-v2`
  // cell records the real-model run under both knobs on (the strict
  // stack); the harness pair in `population-loop.test.ts` pins the
  // load-bearing 1-1-0 delta this knob alone catches that
  // `escalation_revise_counts_as_reject` alone doesn't. Defaults false
  // so every existing scenario, golden cassette, and scripted-cube cell
  // preserves its v0 outcome.
  escalation_requires_votes_to_accept: boolean;
  // Auto-close-accept and escalation-to-accept threshold for *contested*
  // proposals — those whose vote tally has accumulated any `reject` or
  // `revise` vote. 0 (default) leaves the knob inert and both paths fall
  // back to `votes_to_accept`. When > 0, the auto-close-accept path
  // (`resolveByConvergence`) uses this value as the affirmative threshold
  // whenever the proposal has any reject or revise vote — so a
  // 2-accept-1-revise tally that would auto-close accept under v0 at
  // `votes_to_accept=2` does not auto-close at
  // `contested_votes_to_accept=3` because `acceptCount=2 < 3`; the
  // proposal is held for the curator escalation pass. The escalation
  // path (`escalateStuckProposals`) applies the same contested floor as
  // an additional constraint on escalation-to-accept: with dissent
  // present, `accepts >= contested_votes_to_accept` is required for
  // accept; otherwise the proposal escalates reject. Self-contained:
  // composes with v1 (`escalation_revise_counts_as_reject`) and v2
  // (`escalation_requires_votes_to_accept`) but does not require them —
  // v3 alone closes the auto-close-path failure the cube's
  // `borderline-contested-v2` cell recorded (PRD §Continuous
  // integration), where a strategic adversary's drift accept + a
  // confused honest accept + a careful honest revise hit
  // `votes_to_accept=2` on the standard vote path and auto-closed
  // accepted before the curator escalation pass could see it. The
  // v1/v2 escalation knobs only govern the curator tiebreak; v3 is the
  // first knob to touch the auto-close-accept path. Defaults 0 (inert)
  // so every existing scenario, golden cassette, and scripted-cube cell
  // preserves its v0 outcome; the harness pair in
  // `population-loop.test.ts` pins the load-bearing v0/v3 delta
  // byte-for-byte against scripted deciders on the
  // 2-accept-1-revise tally.
  contested_votes_to_accept: number;
  // Calibration injection cadence. PRD §Calibration batches: reviewer
  // batches mix real proposals with calibration items drawn from
  // validated history; PRD §Why assignment-driven contribution closes several attack surfaces settles that calibration arrives
  // via the same assignment surface as real work, so it is structurally
  // indistinguishable from "the rest of the work." 0 disables; N>0 means
  // every Nth review-task offer to a given (caller, cause) is replaced
  // with a calibration draw (an accepted-from-history proposal). The
  // testbed sweeps this; baseline is disabled so non-calibration
  // scenarios remain unaffected.
  calibration_inject_every_n: number;
  // Reputation gain when a reviewer correctly accepts a calibration
  // item (PRD §Calibration batches: "Reviewers who fail calibration lose
  // reputation" — the dual gain is the symmetric incentive). Smaller
  // than reviewer_accurate_gain by default so calibration is a
  // confirmation channel, not a rep-laundering one.
  calibration_pass_gain: number;
  // Reputation loss when a reviewer rejects (or asks for revision on,
  // by the contrapositive — but revise is a no-op here, see below) a
  // calibration item. PRD §Calibration batches + §Reputation: failing calibration
  // and inaccurate reviews both deduct rep.
  calibration_fail_loss: number;
  // Calibration-aware convergence: when true, resolveByConvergence
  // weights votes by the reviewer's per-(cause, sub-topic) calibration
  // record (passes minus fails) at convergence time. Convergence
  // requires both a minimum count of distinct reviewers AND a minimum
  // *weighted* sum, both equal to votes_to_X. The two conditions
  // collapse to today's count-based behavior when every reviewer's
  // weight is 1 (calibration record (0,0)) and only differ once
  // calibration history starts moving weights. Defaults to off so the
  // existing scenarios that count votes 1:1 are unaffected.
  //
  // The defense closes the convergence half of the strategic-coalition
  // attack: a coalition whose bias misfires on calibration items pays
  // for it twice — once on the rep ledger (already wired) and once at
  // convergence, where their reduced weight no longer drives a
  // bias-aligned suppression past the threshold. The seam relies on
  // the calibration corpus being non-trivial for the bias predicate
  // (PRD §Calibration batches: calibration items "drawn from the
  // graph's own validated history" are by construction not bias-
  // engineered). Calibration-aware adversaries (PRD §Adversary taxonomy (Strategic adversary): passing
  // calibration despite holding bias) are wired in the testbed as
  // the calibration-aware-coalition scenario, with structural
  // closures (pool-size scaling at K+1 honest reviewers, stratified-
  // by-history assignment for the small-pool case) building on this
  // seam rather than regressing it (PRD §Reviewer assignment,
  // ROADMAP §Status).
  calibration_aware_convergence: boolean;
  // Stratified-by-history reviewer assignment (PRD §Reviewer
  // assignment). When true, the assignment selector partitions the
  // eligible reviewer pool into vote-pattern co-occurrence clusters
  // and prefers draws across clusters; convergence reads the same
  // partition to mark proposals that lost their diversity defense as
  // stratification-degraded and tighten thresholds. Defaults to off
  // so existing scenarios that don't sweep stratification are
  // unaffected.
  stratification_enabled: boolean;
  // Two reviewers are co-stratum when they have voted on at least
  // this many shared past proposals AND their pairwise agreement on
  // those shared proposals is >= stratum_agreement_threshold. Below
  // the shared-proposal floor, the pair is treated as no-edge — the
  // signal isn't there yet. Smaller floors detect bias clusters
  // earlier but accept more noise; the testbed sweeps this.
  stratum_min_shared_proposals: number;
  // Pairwise agreement threshold for cluster-edge formation. 1.0 is
  // "always voted the same way on every shared proposal"; 0.5 is
  // chance for binary vote outcomes. Default 0.8 — high enough to
  // distinguish coordinated bias from independent agreement on
  // strongly-grounded proposals, low enough to detect a coalition
  // that doesn't perfectly synchronize.
  stratum_agreement_threshold: number;
  // Target distinct strata count per proposal. When the eligible
  // pool can't furnish at least this many strata, the proposal is
  // marked stratification-degraded and convergence tightens.
  // Defaults to votes_to_accept — same target as the redundant-
  // peer-review invariant.
  stratum_target_count: number;
  // Extra distinct-reviewer count and weighted-sum required for
  // convergence on a stratification-degraded proposal. PRD commits
  // "tighter" without committing the shape; v0 uses a fixed additive
  // bump over both the count and the weighted-sum thresholds for
  // testability. Multiplicative tightening is a future testbed
  // sweep.
  stratification_degraded_extra: number;
  // Contention-weighted edge formation for the cluster primitive
  // (PRD §Reviewer assignment, "weighting shared proposals by
  // contention"). When true, pairwise edges are weighted by per-
  // proposal contention — `2 * min(accepts, rejects) / total_votes`,
  // so unanimous proposals contribute 0 weight and perfect-split
  // proposals contribute 1. The pair edges when (a) at least
  // stratum_min_shared_proposals raw shared votes exist (the brand-
  // new-reviewer floor stays in place) AND (b) weighted_agreement /
  // weighted_shared >= stratum_agreement_threshold AND (c)
  // weighted_shared > 0 (some non-zero contention has accumulated).
  // Closes the over-aggregation failure mode where unanimous-easy
  // priming collapses honest reviewers into one cluster, strangling
  // the cross-stratum draw rule. Does *not* close the decorrelating-
  // coalition vector, since a pair that disagrees on every shared
  // proposal still has weighted_agreement = 0; that vector is closed
  // by stratum_anti_correlation_threshold below. Defaults to off so
  // existing scenarios that rely on raw cluster semantics are
  // unaffected.
  stratum_contention_weighted: boolean;
  // Anti-correlation edge formation (PRD §Reviewer assignment,
  // "detecting anti-correlation as a separate cue"). When > 0, a
  // pair edges into the same stratum when their (weighted)
  // disagreement ratio meets this threshold — i.e., they
  // systematically vote the *opposite* way on shared proposals.
  // Coalition members deliberately decorrelating to defeat the
  // co-occurrence cluster look unmistakably anti-correlated; treating
  // that as co-stratum closes the cross-stratum gate against them.
  // The brand-new-reviewer raw-shared floor still applies, and when
  // stratum_contention_weighted is on the disagreement ratio is
  // weighted by per-proposal contention exactly the way agreement is.
  // 0 disables (default) — existing scenarios are unaffected. 1.0 is
  // "always voted the opposite way on every shared proposal"; values
  // below 1.0 admit organic disagreement as honest false positives,
  // which is the signal/cost trade-off the testbed sweeps.
  stratum_anti_correlation_threshold: number;
  // Half-life (in seconds) of the *demonstrated*-competence reputation
  // component. PRD §Reputation: "A demonstrated-competence component,
  // slow-decay, gates eligibility tiers." Applied as exponential decay
  // on read (and on write, to land subsequent bumps on a freshly
  // decayed value). Default `Infinity` means no decay — preserves the
  // single-cumulative-score behavior of pre-two-component scenarios so
  // tests that don't care about decay are unaffected. The testbed
  // sweeps the production value alongside attack-success-rate
  // measurements.
  demonstrated_half_life_seconds: number;
  // Half-life (in seconds) of the *recent*-activity reputation
  // component. PRD §Reputation: "A recent-activity component, fast-
  // decay, gates assignment." Same decay shape as demonstrated, only
  // shorter — what's currently active is what's recently bumped.
  // Default `Infinity` for the same back-compat reason as demonstrated.
  // In production, the gap between the two half-lives is the
  // patient-adversary defense lever: a long-priming adversary can
  // stockpile demonstrated but cannot keep recent high without
  // actually being recently active, and visible activity is detectable
  // (PRD §Reputation).
  recent_half_life_seconds: number;
  // Minimum *recent*-component value (across the caller's rep entries
  // in the requested cause) required to be assigned a task. PRD
  // §Reputation: "A recent-activity component, fast-decay, gates
  // assignment." The gate is a soft floor — callers with no rep
  // entries in the cause bypass (fresh reviewers must be able to
  // bootstrap), and contributor-initiated voting (which never reaches
  // request_assignment) is unaffected so a drained-but-honest
  // contributor can re-bootstrap their recent. Default 0 leaves the
  // gate inert and preserves existing-scenario behavior. Together
  // with a finite recent_half_life_seconds, this is what tightens
  // the patient-adversary drift bandwidth: a long-priming adversary
  // who stops voting between drift attempts watches their recent
  // drain below threshold and can no longer be assigned a fresh
  // proposal to drift on. The gate applies uniformly to calibration
  // injection and frontier-derived tasks — leaving calibration
  // injection un-gated would let an adversary use calibration items
  // to keep recent topped up.
  assignment_min_recent: number;
  // Minimum *demonstrated*-component value (across the caller's rep
  // entries in the requested cause) required to be assigned a task.
  // PRD §Reputation: "A demonstrated-competence component, slow-
  // decay, gates eligibility tiers (who is in the reviewer pool at
  // all)." The opposite null-policy from the recent gate: callers
  // with *no* rep entries in the cause FAIL the gate when threshold
  // > 0 — the demonstrated tier is "have you proven yourself yet?",
  // and an unproven identity is by construction not in the pool. The
  // bootstrap path is contributor-initiated voting (cast_review_vote
  // with no assignment_id) and direct proposing, both of which earn
  // reputation without going through request_assignment; once the
  // caller's demonstrated rises above threshold, the gate opens.
  // This is the architectural cost a fresh-identity sybil-amplified
  // coalition pays: each new identity must accumulate visible
  // contribution history before it can be drawn for review, exposing
  // it to the cluster signal, calibration record, and curator
  // surfaces that need accumulated activity per identity. Default 0
  // leaves the gate inert and preserves existing-scenario behavior.
  assignment_min_demonstrated: number;
  // Seconds after which an unresolved single-holder slot is
  // *additionally* shadow-offered to a backup contributor (PRD
  // §Write-path tools, "Assignment": TTL-as-shadow-reassignment). Not
  // a holder-expiry — the holder keeps their slot; a parallel shadow
  // re-offer is created lazily on the next caller's pull and whichever
  // resolves first releases both. Default Infinity disables shadowing
  // entirely (no `ttl_at` is ever stamped), so every pre-TTL scenario
  // is unaffected; the testbed sweeps the production value.
  assignment_ttl_seconds: number;
  // Difficulty-normalization mix for reviewer rep deltas. PRD
  // §Reputation: "Review-credit normalized by claim difficulty.
  // Without normalization, the regime selects for reviewers who
  // accept easy proposals." When `alpha < 1`, reviewer rep deltas
  // (gain on accurate, loss on inaccurate) are scaled by
  // `alpha + (1 - alpha) * contention`, where contention is the same
  // `2 * min(accepts, rejects) / total_votes` proxy the cluster
  // signal already uses (PRD §Reviewer assignment). Unanimous-easy
  // proposals yield contention 0 and earn the reviewer `alpha *
  // base_delta`; perfectly-split contentious proposals yield
  // contention 1 and earn the full `base_delta`. Default 1.0 leaves
  // the v0 uniform-credit regime intact (every accurate review
  // credits the same independent of difficulty), preserving the
  // assignment-gate threshold tuning the patient-adversary cube
  // calibrates against; opt-in `alpha < 1` is the wedge that lets
  // the testbed re-baseline those thresholds against the
  // difficulty-aware regime. Only applies to reviewer deltas (the
  // PRD passage scopes difficulty-normalization to review credit);
  // proposer deltas stay unscaled so the proposer's accept/reject
  // outcome carries its own weight independent of how much
  // disagreement the reviewers had on the way there.
  review_credit_contention_alpha: number;
  // Minimum attestation level required to call any write tool. PRD
  // §Identity bullet 1 (binding cost): the IdP records
  // `attestation_level` on the identity at mint, opaque to the
  // server (the server gates on threshold; it does not interpret
  // what the level *means*). The gate fires at every tool that
  // resolves a caller for write — `request_assignment`, all
  // `propose_*` tools, and `cast_review_vote`
  // — refusing with
  // `unauthorized` mode rather than the rep gates' `not_found`
  // opacity, because the binding-cost mismatch is identity-level (a
  // stable property of the IdP-issued credential) and there's no
  // opaque-refusal value to protect: the adversary already knows
  // their own attestation level. The first of the four
  // sybil-resistance layers PRD
  // §Identity specs; the cost-multiplier on the population axis
  // the testbed harness's adversary-budget model reads against.
  // Default 0 leaves the gate inert and preserves existing-scenario
  // behavior (which mints all synthetic identities at
  // attestation_level 0 by default).
  min_attestation_level: number;
  // Maximum number of write actions a single identity can perform
  // per epoch. PRD §Identity bullet 3 (per-identity rate-limit
  // accounting): the third of the four sybil-resistance layers.
  // The cap is on observable write actions across all write tools
  // (`request_assignment`, all `propose_*` tools, `cast_review_vote`)
  // — single bucket rather than per-tool, so the cap measures total
  // throughput per identity per epoch directly. The cost-multiplier
  // reads as the per-sybil-throughput axis: at K sybils with
  // per-sybil cap T, the coalition's per-epoch action budget is
  // K × T. Refusal
  // mode is `rate_limited` (a new ServerErrorCode parallel to
  // `not_found` and `unauthorized`) — distinct from the
  // attestation gate's `unauthorized` and the rep gates'
  // `not_found` because the recovery path is "wait for the next
  // epoch," not "obtain a higher attestation" or "no work
  // available." Default Infinity leaves the gate inert; finite
  // values opt the gate in for the testbed's adversary-budget
  // model. Counted *after* schema parse, auth, and the attestation
  // gate, but *before* tool-specific business logic — so malformed
  // inputs and unauthorized callers don't burn budget, but
  // valid-input-but-business-logic-failed calls do (an adversary
  // can't probe the system with bogus business inputs without
  // paying budget for each).
  rate_limit_actions_per_epoch: number;
  // Epoch window for rate-limit accounting, in seconds. PRD
  // §Identity bullet 3: epochs are wall-clock windows (not sliding
  // windows) — counter resets at epoch boundary, advanced lazily
  // when the gate fires. Default Infinity is a single never-ending
  // epoch (counter accumulates forever), which together with
  // `rate_limit_actions_per_epoch=Infinity` keeps the gate inert
  // by construction. Finite values (e.g., 60 for one-minute
  // epochs) opt the gate in. The harness's `FakeClock.advance(ms)`
  // is what scenarios use to cross epoch boundaries deliberately.
  rate_limit_epoch_seconds: number;
  // Minimum distinct-reviewer count required for an accepted proposal
  // to be eligible as a calibration item — applied at both
  // `fetchCalibrationBatch` (the public read-path) and
  // `drawCalibrationTask` (the assignment-injection seam). PRD
  // §Calibration batches commits the calibration corpus as
  // accepted-from-history proposals with recency-biased draw; the
  // corpus-contamination dynamic surfaces when bias-aligned excerpts
  // converge accepted mid-run and join the corpus before independent
  // confirmation has accumulated, lifting a coalition member's
  // calibration weight off the floor on subsequent reviewers' draws
  // (the corpus-contamination scenario pins the dynamic). The floor
  // is the corpus-composition closure: a proposal must have
  // distinct-reviewer count ≥ floor over the vote store to be
  // eligible — accumulating more reviewers than the convergence
  // threshold required (post-convergence confirmation). At v0
  // votes_to_accept=2, floor=3 requires at least one independent
  // confirmation past the original convergence pair before the item
  // enters the corpus, closing the within-first-review-session
  // bypass the contamination scenario reads. Anchors are exempt by
  // kind (`payload.kind === 'anchor'`) — they are the ground-truth
  // substrate, not synthesis-from-review, and the "first review
  // session" framing doesn't apply; counting their accumulated
  // calibration-vote reviewers against the floor would otherwise
  // mis-trip the gate against the substrate itself. Default 0 leaves
  // the filter inert and preserves existing-scenario behavior;
  // finite values opt in for the testbed's corpus-composition sweeps.
  corpus_confirmation_depth_floor: number;
  // Manuscript projection credit weights (PRD §Credit). Specific
  // numeric weights are testbed-tunable; v0 defaults below capture
  // the *shape* PRD §Credit commits to — proposers count more than
  // reviewers, survivorship and load-bearing scale the contribution
  // per-node. The defaults are non-zero by construction because
  // there is no "baseline behavior" to preserve here (the projection
  // is new); the testbed will sweep them once a Phase-2 corpus
  // exists to read deltas off of.
  //
  //   - `credit_proposer_weight`: base units a proposer accrues
  //     for an included node before survivor/load scaling.
  //   - `credit_reviewer_weight`: base units a converged-aligned
  //     reviewer accrues for an included node. Strictly smaller
  //     than the proposer weight per PRD §Credit ("weighted lower
  //     than proposers").
  //   - `credit_survivor_bonus_per_supersede`: added to the per-
  //     contribution multiplier for each active supersedes edge
  //     terminating at this node (i.e., each predecessor this node
  //     replaced and that the graph still records). Captures the
  //     PRD §Credit "survivorship weighting" factor.
  //   - `credit_load_bonus_per_induced_derives`: added to the per-
  //     contribution multiplier for each active derives edge in the
  //     *induced* subgraph (both endpoints in the included node
  //     set) where this node is either endpoint. Captures the PRD
  //     §Credit "load-bearing weighting" factor — a node that
  //     participates in more in-scope chains counts more.
  credit_proposer_weight: number;
  credit_reviewer_weight: number;
  credit_survivor_bonus_per_supersede: number;
  credit_load_bonus_per_induced_derives: number;
}

const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  votes_to_accept: 2,
  votes_to_reject: 2,
  proposer_accepted_gain: 1,
  proposer_rejected_loss: 1,
  reviewer_accurate_gain: 1,
  reviewer_inaccurate_loss: 1,
  contributor_initiated_factor: 0.5,
  escalation_revise_counts_as_reject: false,
  escalation_requires_votes_to_accept: false,
  contested_votes_to_accept: 0,
  calibration_inject_every_n: 0,
  calibration_pass_gain: 1,
  calibration_fail_loss: 1,
  calibration_aware_convergence: false,
  stratification_enabled: false,
  stratum_min_shared_proposals: 3,
  stratum_agreement_threshold: 0.8,
  stratum_target_count: 2,
  stratification_degraded_extra: 1,
  stratum_contention_weighted: false,
  stratum_anti_correlation_threshold: 0,
  demonstrated_half_life_seconds: Infinity,
  recent_half_life_seconds: Infinity,
  assignment_min_recent: 0,
  assignment_min_demonstrated: 0,
  assignment_ttl_seconds: Number.POSITIVE_INFINITY,
  review_credit_contention_alpha: 1,
  min_attestation_level: 0,
  rate_limit_actions_per_epoch: Number.POSITIVE_INFINITY,
  rate_limit_epoch_seconds: Number.POSITIVE_INFINITY,
  corpus_confirmation_depth_floor: 0,
  credit_proposer_weight: 1.0,
  credit_reviewer_weight: 0.25,
  credit_survivor_bonus_per_supersede: 0.5,
  credit_load_bonus_per_induced_derives: 0.25,
};

export interface ServerDeps {
  clock?: Clock;
  idGen?: IdGen;
  store?: Store;
  verifier?: Verifier;
  review?: Partial<ReviewConfig>;
  // Trust-boundary Authenticator (PRD §Identity, Authenticator seam).
  // Default is `HarnessAuthenticator` over the Server's Store — the
  // testbed and in-process tests get the deterministic no-network path
  // for free; the production runtime (slice 4) injects a
  // `GithubOAuthAuthenticator` here.
  authenticator?: Authenticator;
}

// v0 cap on calibration items per fetch. Small enough to keep batch
// composition (real proposals + calibration items) reviewer-tractable;
// the right value is testbed-tuned and changes alongside the broader
// batch-sizing knob.
const CALIBRATION_BATCH_SIZE = 3;

// Exponential decay of a reputation component magnitude. `Infinity`
// half-life and zero elapsed both collapse to identity; finite
// half-lives apply value * 0.5^(elapsed/halfLife). Sign is preserved
// — a negative reputation balance decays toward zero from below the
// same way a positive one decays toward zero from above.
function decayValue(value: number, elapsedSeconds: number, halfLifeSeconds: number): number {
  if (value === 0) return 0;
  if (!Number.isFinite(halfLifeSeconds)) return value;
  if (elapsedSeconds <= 0) return value;
  return value * 0.5 ** (elapsedSeconds / halfLifeSeconds);
}

interface MaterializationResult {
  node: Node | null;
  edges: readonly Edge[];
  nodeUpdates: readonly Node[];
  subTopicCreates: readonly SubTopic[];
}

// Stable tiebreaker for frontier ordering when priorities tie. Each
// kind carries a different id-bearing field; we project onto a single
// string for deterministic sort.
function frontierTiebreakerKey(item: FrontierItem): string {
  switch (item.kind) {
    case 'orphan_anchor':
    case 'unresolvable_anchor':
      return `${item.kind}:${item.anchor_id}`;
    case 'needs_review':
      return `${item.kind}:${item.proposal_id}`;
    case 'needs_synthesis':
      return `${item.kind}:${item.parent_ids.join(',')}`;
  }
}

// The work kind a task represents. AssignmentTask is keyed by `kind`
// values that already match WorkKind one-to-one — see assignments.ts
// — so the projection is identity in spirit. Made explicit so future
// task-kind additions surface here as compile errors.
function taskWorkKind(task: AssignmentTask): WorkKind {
  return task.kind;
}

// A stable string identifying the *target* of an assignment, for
// double-offer prevention. Two tasks targeting the same proposal-to-
// review or the same parent-anchor-to-excerpt are the same target —
// even if they sit in different assignments at different times.
function assignmentTaskKey(task: AssignmentTask): string {
  switch (task.kind) {
    case 'review':
      return `review:${task.proposal_id}`;
    case 'excerpt':
      return `excerpt:${task.parent_anchor_id}`;
    case 'synthesis':
    case 'open_question':
      return `${task.kind}:${[...task.parent_ids].sort().join(',')}`;
    case 'supersedes':
      return `supersedes:${task.from_node_id}`;
    case 'membership':
      return `membership:${task.node_id}:${task.sub_topic_id}`;
    case 'anchor':
      return `anchor:${task.sub_topic_id}`;
  }
}

// Server is the trust boundary. All mutation goes through it. The
// `bootstrap` namespace holds curator/admin operations not exposed as
// MCP tools (cause creation, sub-topic seeding, identity issuance);
// the `tools` namespace holds the contributor-facing MCP tools, added
// incrementally and 1-to-1 with the I/O contracts in
// @anchorage/contracts/tools.
export class Server {
  readonly clock: Clock;
  readonly idGen: IdGen;
  readonly store: Store;
  readonly verifier: Verifier;
  readonly review: ReviewConfig;
  // Authenticator is settable post-construction so authenticators
  // that depend on the Server itself (e.g. `GithubOAuthAuthenticator`,
  // which needs `server.bootstrap.mintIdentity` and
  // `bindAgentCredential` to mint on first signin) can be wired in
  // two steps: construct the Server with the default
  // `HarnessAuthenticator`, then `setAuthenticator(new
  // GithubOAuthAuthenticator({ server, ... }))`. The field is
  // otherwise stable — `buildMcpServer` reads it once at connection
  // time. PRD §Identity (Authenticator seam): downstream gates see
  // only the resolved Caller regardless of which authenticator
  // produced it.
  authenticator: Authenticator;

  constructor(deps: ServerDeps = {}) {
    this.clock = deps.clock ?? new SystemClock();
    this.idGen = deps.idGen ?? new RandomIdGen();
    this.store = deps.store ?? new MemoryStore();
    this.verifier = deps.verifier ?? new StructuralVerifier();
    this.review = { ...DEFAULT_REVIEW_CONFIG, ...(deps.review ?? {}) };
    this.authenticator = deps.authenticator ?? new HarnessAuthenticator(this.store);
  }

  setAuthenticator(authenticator: Authenticator): void {
    this.authenticator = authenticator;
  }

  // Resolve a sub-topic that must exist, be active, and live under the
  // expected cause. Used by every tool that takes a sub-topic id, so
  // it lives on the Server rather than each tool re-implementing it.
  private requireActiveSubTopicInCause(
    subTopicId: SubTopicId,
    causeId: CauseId,
    label: string,
  ): SubTopic {
    const st = this.store.subTopics.get(subTopicId);
    if (!st) {
      throw new ServerError('not_found', `${label} sub-topic not found: ${subTopicId}`);
    }
    if (st.cause_id !== causeId) {
      throw new ServerError(
        'invalid_input',
        `${label} sub-topic ${subTopicId} does not belong to cause ${causeId}`,
      );
    }
    if (st.status !== 'active') {
      throw new ServerError('invalid_state', `${label} sub-topic is ${st.status}`);
    }
    return st;
  }

  private requireActiveCause(causeId: CauseId): Cause {
    const cause = this.store.causes.get(causeId);
    if (!cause) {
      throw new ServerError(
        'not_found',
        `cause not found: ${causeId} — call query_causes for the active cause ids`,
      );
    }
    if (cause.status !== 'active') {
      throw new ServerError('invalid_state', `cause is ${cause.status}`);
    }
    return cause;
  }

  // Resolve an active node that lives in the given cause. The cause
  // check follows the node through its home sub-topic, since nodes
  // don't carry a cause_id directly — they're partitioned across sub-
  // topics, and sub-topics belong to a cause.
  private requireActiveNodeInCause(nodeId: NodeId, causeId: CauseId): Node {
    const node = this.store.nodes.get(nodeId);
    if (!node) {
      throw new ServerError('not_found', `node not found: ${nodeId}`);
    }
    if (node.status !== 'active') {
      throw new ServerError('invalid_state', `node ${nodeId} is ${node.status}`);
    }
    const home = this.store.subTopics.get(node.home_sub_topic_id);
    if (!home || home.cause_id !== causeId) {
      throw new ServerError('invalid_input', `node ${nodeId} does not belong to cause ${causeId}`);
    }
    return node;
  }

  private requireActiveAnchorInCause(nodeId: NodeId, causeId: CauseId): AnchorNode {
    const node = this.requireActiveNodeInCause(nodeId, causeId);
    if (node.kind !== 'anchor') {
      throw new ServerError('invalid_input', `node ${nodeId} is not an anchor`);
    }
    return node;
  }

  // The cause an existing node lives under, found via its home sub-topic.
  // Used by tools that take node ids without a redundant cause_id (PRD's
  // `propose_supersedes`, `propose_membership`, `propose_change_of_home`):
  // the cause is implicit in the node, and re-passing it would create a
  // surface for inconsistency.
  private causeOfNode(node: Node): CauseId {
    const home = this.store.subTopics.get(node.home_sub_topic_id);
    if (!home) {
      throw new ServerError(
        'invalid_state',
        `node ${node.id} home sub-topic ${node.home_sub_topic_id} not found`,
      );
    }
    return home.cause_id;
  }

  // Derive frontier items from current graph state. Frontier items
  // are *not* stored — they are projections over the existing nodes,
  // edges, and proposals. This keeps the frontier consistent with the
  // graph by construction: a state change that closes a gap (an
  // excerpt landing on an orphan anchor; a review vote arriving on a
  // staged proposal) makes the frontier item disappear on the next
  // call without bookkeeping. Used by `query_frontier` and by
  // `request_assignment` (both wired and routed through this single
  // projection — the assignment loop draws from the same frontier
  // items the read-path query surfaces).
  //
  // v0 covers three of the four FrontierKind variants:
  //
  //   - `orphan_anchor`         — active anchor with no active derives
  //                               child edge.
  //   - `unresolvable_anchor`   — anchor whose status is unresolvable
  //                               (PRD §Verification engine).
  //   - `needs_review`          — proposal in `staged` status whose
  //                               kind admits review-pool review.
  //                               Curator-only kinds (`sub_topic`,
  //                               `change_of_home`) are excluded.
  //
  // `needs_synthesis` is deferred — there is no testbed-validated
  // heuristic for "a synthesis would close a visible gap" yet, and
  // shipping a guess would just bias the simulator. v1 introduces it
  // alongside the closure-distance metric.
  //
  // Priorities are coarse v0 hints, not contracts about scale: review
  // queue clearing is highest, broken sources next, productive-but-
  // not-blocking orphans lowest. Real ordering is testbed-tuned and
  // lives in the assignment-selection layer, not here.
  private deriveFrontier(filters: {
    cause_id?: CauseId;
    sub_topic_id?: SubTopicId;
    frontier_kind?: FrontierItem['kind'];
  }): FrontierItem[] {
    const items: FrontierItem[] = [];

    // Build the set of node ids that are the `from` end of an active
    // derives edge — used to identify orphan anchors. Membership in
    // this set means at least one excerpt has landed.
    const hasDerivesChild = new Set<NodeId>();
    for (const e of this.store.edges.values()) {
      if (e.kind === 'derives' && e.status === 'active') {
        hasDerivesChild.add(e.from);
      }
    }
    // An anchor with a *staged* excerpt proposal isn't orphan either.
    // Re-offering it for excerpt work creates duplicate assignments
    // for the same parent across different contributors that the
    // loop's per-contributor double-offer guard can't deduplicate.
    // PRD treats orphan_anchor as "needs work to be productive";
    // staged work-in-flight already covers that need, even before
    // acceptance materializes the derives edge.
    const hasStagedExcerptChild = new Set<NodeId>();
    for (const p of this.store.proposals.values()) {
      if (p.status === 'staged' && p.payload.kind === 'excerpt') {
        hasStagedExcerptChild.add(p.payload.parent_anchor_id);
      }
    }
    // Same reasoning, one step earlier in the lifecycle: an anchor
    // with an in-flight excerpt assignment (offered or accepted, not
    // yet submitted / declined / expired) isn't orphan. The window
    // between a contributor pulling an excerpt assignment for an
    // anchor and staging the proposal would otherwise let other
    // contributors pull the same anchor concurrently — exactly the
    // duplicate-work the staged-proposal guard above closes, but it
    // only kicks in once the proposal exists. A population of N
    // concurrent contributors hits this window N-deep on a fresh
    // frontier without it.
    //
    // A slot past its `ttl_at` stops covering: the anchor re-enters the
    // frontier so the next caller's pull mints a `shadow_of` re-offer
    // (PRD §Write-path tools, "Assignment": TTL-as-shadow). Liveness
    // without a curator expiry sweep — a permanently-dead holder simply
    // stops shielding the work once its TTL passes.
    const nowMs = Date.parse(this.clock.now());
    const hasInFlightExcerptAssignment = new Set<NodeId>();
    for (const a of this.store.assignments.values()) {
      if (a.task.kind !== 'excerpt') continue;
      if (a.status !== 'accepted') continue;
      if (a.ttl_at !== undefined && Date.parse(a.ttl_at) <= nowMs) continue;
      hasInFlightExcerptAssignment.add(a.task.parent_anchor_id);
    }

    for (const node of this.store.nodes.values()) {
      if (node.kind !== 'anchor') continue;
      const home = this.store.subTopics.get(node.home_sub_topic_id);
      if (!home) continue;
      if (
        node.status === 'active' &&
        !hasDerivesChild.has(node.id) &&
        !hasStagedExcerptChild.has(node.id) &&
        !hasInFlightExcerptAssignment.has(node.id)
      ) {
        items.push({
          kind: 'orphan_anchor',
          cause_id: home.cause_id,
          sub_topic_id: node.home_sub_topic_id,
          anchor_id: node.id,
          priority: 5,
        });
      } else if (node.status === 'unresolvable') {
        items.push({
          kind: 'unresolvable_anchor',
          cause_id: home.cause_id,
          sub_topic_id: node.home_sub_topic_id,
          anchor_id: node.id,
          priority: 8,
        });
      }
    }

    for (const p of this.store.proposals.values()) {
      if (p.status !== 'staged') continue;
      const located = this.locateProposalForReview(p);
      if (!located) continue;
      items.push({
        kind: 'needs_review',
        cause_id: located.cause_id,
        sub_topic_id: located.sub_topic_id,
        proposal_id: p.id,
        priority: 10,
      });
    }

    const filtered = items.filter((it) => {
      if (filters.cause_id && it.cause_id !== filters.cause_id) return false;
      if (filters.sub_topic_id && it.sub_topic_id !== filters.sub_topic_id) return false;
      if (filters.frontier_kind && it.kind !== filters.frontier_kind) return false;
      return true;
    });

    // Stable order: priority descending, then ids alphabetical for
    // determinism. The testbed depends on stable ordering for replay
    // — randomness in selection lives at the assignment layer, not
    // the frontier query.
    filtered.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return frontierTiebreakerKey(a).localeCompare(frontierTiebreakerKey(b));
    });
    return filtered;
  }

  // PRD §Identity bullet 1 (binding cost) — the binding-cost gate
  // that fires at every write tool. The server doesn't mint
  // identities (that's the IdP's job, below the MCP layer); it
  // gates writes on the `attestation_level` recorded on the
  // identity at mint against the testbed-tunable
  // `min_attestation_level` threshold. Refusal mode is
  // `unauthorized` rather than the rep gates' `not_found` opacity
  // because the binding-cost mismatch is identity-level (a stable
  // property of the IdP-issued credential) and there's no opaque-
  // refusal value to protect. Inert when threshold = 0 (default).
  private requireMinAttestation(identity: Identity): void {
    if (this.review.min_attestation_level <= 0) return;
    if (identity.attestation_level >= this.review.min_attestation_level) return;
    throw new ServerError(
      'unauthorized',
      `attestation level ${identity.attestation_level} below minimum ${this.review.min_attestation_level} for ${identity.id}`,
    );
  }

  // PRD §Identity bullet 3 (per-identity rate-limit accounting) —
  // the third of the four sybil-resistance layers. Atomically
  // checks the per-(identity, epoch) write-action counter against
  // `rate_limit_actions_per_epoch` and increments on success, or
  // throws `ServerError('rate_limited', ...)` when the cap is
  // reached. Inert when the cap is Infinity (the `!isFinite`
  // shortcut means scenarios that don't exercise the gate pay zero
  // cost). The epoch index is derived lazily from wall-clock time
  // (`floor(now_ms / (epoch_seconds * 1000))`); the store keeps
  // one record per identity that the helper resets on epoch
  // boundary rather than maintaining one entry per (identity,
  // epoch) tuple — historical per-epoch counts aren't needed for
  // enforcement, and slice 4's curator-side identity-clustering
  // projection is where historical surveillance signals surface.
  // Called after `resolveCaller` and `requireMinAttestation` so
  // unauthorized callers don't burn budget; called before
  // tool-specific business logic so valid-input-but-failed-logic
  // calls *do* burn budget (an adversary can't probe the system
  // with bogus business inputs without paying for each).
  private accountWriteAction(identity: Identity): void {
    const cap = this.review.rate_limit_actions_per_epoch;
    if (!Number.isFinite(cap)) return;
    const epochSeconds = this.review.rate_limit_epoch_seconds;
    const epoch =
      Number.isFinite(epochSeconds) && epochSeconds > 0
        ? Math.floor(new Date(this.clock.now()).getTime() / (epochSeconds * 1000))
        : 0;
    const existing = this.store.rateLimits.get(identity.id);
    const current = existing && existing.epoch === epoch ? existing.count : 0;
    if (current + 1 > cap) {
      throw new ServerError(
        'rate_limited',
        `write-action budget exhausted for ${identity.id}: ${current}/${cap} in epoch ${epoch} (cap ${cap} actions per ${epochSeconds}s)`,
      );
    }
    this.store.rateLimits.set(identity.id, { epoch, count: current + 1 });
  }

  // Resolve an assignment that belongs to the given identity and sits
  // in one of the allowed states — the entry point for the single
  // contributor-driven transition. Fulfillment via a `propose_*` /
  // `cast_review_vote` allows `accepted` (a pulled slot is `accepted`
  // from `request_assignment` — there is no accept step and no
  // `offered` waiting state). There is no contributor-driven exit (no
  // `decline_assignment`): a slot the contributor cannot complete
  // resolves through precondition-lapse or TTL-shadow, never a refusal
  // (PRD §Write-path tools, "Assignment").
  private requireOwnedAssignment(
    assignmentId: AssignmentId,
    identityId: IdentityId,
    allowedStatuses: readonly Assignment['status'][] = ['accepted'],
  ): Assignment {
    const a = this.store.assignments.get(assignmentId);
    if (!a) {
      throw new ServerError('not_found', `assignment not found: ${assignmentId}`);
    }
    if (a.contributor_id !== identityId) {
      throw new ServerError(
        'unauthorized',
        `assignment ${assignmentId} does not belong to ${identityId}`,
      );
    }
    if (!allowedStatuses.includes(a.status)) {
      throw new ServerError(
        'invalid_state',
        `assignment ${assignmentId} is ${a.status} (expected ${allowedStatuses.join(' or ')})`,
      );
    }
    return a;
  }

  // Assert the payload submitted to fulfill an assignment matches
  // the task's pinned context. Same-kind has already been checked by
  // the caller; this validates the per-kind target fields.
  private assertPayloadMatchesTask(payload: ProposalPayload, task: AssignmentTask): void {
    if (payload.kind === 'anchor' && task.kind === 'anchor') {
      if (payload.cause_id !== task.cause_id) {
        throw new ServerError('invalid_input', 'payload cause_id does not match task cause');
      }
      if (payload.home_sub_topic_id !== task.sub_topic_id) {
        throw new ServerError(
          'invalid_input',
          'payload home_sub_topic_id does not match task sub-topic',
        );
      }
      return;
    }
    if (payload.kind === 'excerpt' && task.kind === 'excerpt') {
      if (payload.cause_id !== task.cause_id) {
        throw new ServerError('invalid_input', 'payload cause_id does not match task cause');
      }
      if (payload.home_sub_topic_id !== task.sub_topic_id) {
        throw new ServerError(
          'invalid_input',
          'payload home_sub_topic_id does not match task sub-topic',
        );
      }
      if (payload.parent_anchor_id !== task.parent_anchor_id) {
        throw new ServerError(
          'invalid_input',
          'payload parent_anchor_id does not match task parent',
        );
      }
      return;
    }
    if (
      (payload.kind === 'synthesis' || payload.kind === 'open_question') &&
      (task.kind === 'synthesis' || task.kind === 'open_question')
    ) {
      if (payload.cause_id !== task.cause_id) {
        throw new ServerError('invalid_input', 'payload cause_id does not match task cause');
      }
      if (payload.home_sub_topic_id !== task.sub_topic_id) {
        throw new ServerError(
          'invalid_input',
          'payload home_sub_topic_id does not match task sub-topic',
        );
      }
      // Parent set must match exactly (set equality, order-insensitive).
      const taskParents = new Set(task.parent_ids);
      const payloadParents = new Set(payload.parent_ids);
      if (
        taskParents.size !== payloadParents.size ||
        [...taskParents].some((p) => !payloadParents.has(p))
      ) {
        throw new ServerError('invalid_input', 'payload parent_ids do not match task parents');
      }
      return;
    }
    if (payload.kind === 'supersedes' && task.kind === 'supersedes') {
      if (payload.from_node_id !== task.from_node_id) {
        throw new ServerError(
          'invalid_input',
          'payload from_node_id does not match task from_node',
        );
      }
      return;
    }
    if (payload.kind === 'membership' && task.kind === 'membership') {
      if (payload.node_id !== task.node_id) {
        throw new ServerError('invalid_input', 'payload node_id does not match task node');
      }
      if (payload.sub_topic_id !== task.sub_topic_id) {
        throw new ServerError(
          'invalid_input',
          'payload sub_topic_id does not match task sub-topic',
        );
      }
      return;
    }
    // sub_topic and change_of_home are curator-only, excluded from
    // WorkKind, and carry no `assignment_id` on their propose tools, so
    // they never reach here. Review-kind tasks are filtered out by the
    // caller (`resolveProposalAssignment`) before this is called.
    throw new ServerError(
      'invalid_input',
      `unsupported payload/task pair: ${payload.kind} / ${task.kind}`,
    );
  }

  // Validate the optional `assignment_id` on a `propose_*` call: when
  // set, it must name an assignment that belongs to `identityId`, is in
  // `accepted` state, carries a propose-kind task whose kind matches the
  // proposal about to be staged, and whose pinned context (sub-topic,
  // parent anchor, parent set — via `assertPayloadMatchesTask`) matches
  // the proposal's claim. Returns the assignment to fulfill, or
  // undefined for a contributor-initiated proposal. Mirrors the
  // optional-`assignment_id` shape `cast_review_vote` has for review
  // work: one tool per node kind, with or without an assignment.
  // Cause of a proposal payload, for the single-slot off-slot guard.
  // Mirrors `locateProposalForReview` but works on the bare payload
  // (no staged proposal yet). Curator-gated kinds carry no cause/slot
  // semantics and return undefined.
  private causeOfProposalPayload(p: ProposalPayload): CauseId | undefined {
    switch (p.kind) {
      case 'anchor':
      case 'excerpt':
      case 'synthesis':
      case 'open_question':
        return p.cause_id;
      case 'membership':
        return this.store.subTopics.get(p.sub_topic_id)?.cause_id;
      case 'supersedes': {
        const fromNode = this.store.nodes.get(p.from_node_id);
        if (!fromNode) return undefined;
        return this.store.subTopics.get(fromNode.home_sub_topic_id)?.cause_id;
      }
      case 'sub_topic':
      case 'change_of_home':
        return undefined;
    }
  }

  // Single-slot off-slot guard (PRD §Write-path tools / §Assignment).
  // A contributor-initiated write (`propose_*` or `cast_review_vote`
  // with no `assignment_id`) is off-slot work. While the caller holds
  // an unresolved (`accepted`, post-lapse) slot in `causeId`, refuse it:
  // single-slot means there is no parallel work channel to shop into
  // (PRD §Assignment: "you do not progress until this slot resolves, so
  // there is nothing to shop into"), so the held slot must be fulfilled
  // (echo its assignment_id) or allowed to resolve first. Cause-scoped
  // because single-slot is per (identity, cause): a slot held in
  // another cause does not block contributor-initiated work here. Runs
  // before anything is persisted, so a refused call records nothing and
  // the model's corrected re-call is not tripped by any
  // already-acted-this-turn rule (e.g. one-vote-per-(reviewer,
  // proposal)). Caught by the model-backed testbed: an honest reviewer
  // cast a correct vote without echoing assignment_id and — review
  // tasks never lapse on target resolution and are TTL-shadow-exempt —
  // was wedged out of all further work with no recovery.
  private assertNoHeldSlot(
    identityId: IdentityId,
    causeId: CauseId,
    ctx: { action: string; votingOnProposalId?: ProposalId },
  ): void {
    for (const a of this.store.assignments.values()) {
      if (a.contributor_id !== identityId) continue;
      if (this.causeOfTask(a.task) !== causeId) continue;
      const resolved = this.lapseIfPreconditionGone(a);
      if (resolved.status !== 'accepted') continue;
      const fulfillsThisVote =
        resolved.task.kind === 'review' &&
        ctx.votingOnProposalId !== undefined &&
        resolved.task.proposal_id === ctx.votingOnProposalId;
      const exit = fulfillsThisVote
        ? `re-call cast_review_vote with assignment_id=${resolved.id} to fulfill this review slot with this vote, or let it resolve first`
        : `fulfill or let assignment ${resolved.id} resolve before this contributor-initiated ${ctx.action}`;
      throw new ServerError(
        'invalid_state',
        `single-slot: ${identityId} holds an unresolved assignment (${resolved.id}, ${resolved.status}) in cause ${causeId} — a contributor-initiated ${ctx.action} is off-slot work; ${exit}`,
      );
    }
  }

  private resolveProposalAssignment(
    identityId: IdentityId,
    assignmentId: AssignmentId | undefined,
    payload: ProposalPayload,
  ): Assignment | undefined {
    if (assignmentId === undefined) {
      // Contributor-initiated propose: off-slot. Refuse while a slot is
      // held in this payload's cause (curator-gated kinds carry no
      // cause/slot semantics → undefined → no guard).
      const cause = this.causeOfProposalPayload(payload);
      if (cause) this.assertNoHeldSlot(identityId, cause, { action: `${payload.kind} proposal` });
      return undefined;
    }
    const a = this.requireOwnedAssignment(assignmentId, identityId, ['accepted']);
    if (a.task.kind === 'review') {
      throw new ServerError(
        'invalid_input',
        'review-kind assignments are fulfilled via cast_review_vote, not a propose_* tool',
      );
    }
    if (a.task.kind !== payload.kind) {
      throw new ServerError(
        'invalid_input',
        `assignment ${a.id} task kind ${a.task.kind} cannot be fulfilled by a ${payload.kind} proposal`,
      );
    }
    this.assertPayloadMatchesTask(payload, a.task);
    return a;
  }

  // Transition an assignment to `submitted`, pointing `fulfilled_by` at
  // the proposal that just fulfilled it. The caller has already staged
  // the proposal and stamped its `assignment_id`.
  //
  // TTL-shadow resolution invariant (PRD §Write-path tools,
  // "Assignment"): a single-holder task target (everything except
  // `review`, which is intentionally offered to N reviewers in
  // parallel) may have a shadow re-offer outstanding after its TTL
  // lapsed. The first accepted fulfillment by *anyone* resolves the
  // slot; every other still-unresolved assignment on the same target —
  // the original holder if a shadow won, or any shadow if the original
  // won — transitions to `lapsed`, releasing that holder with no
  // credit and no penalty. A later duplicate fulfillment of an
  // already-resolved slot cannot land: its assignment is now `lapsed`,
  // so `resolveProposalAssignment`'s `accepted`-state guard refuses it
  // before any proposal is staged (dropped, credited nothing).
  private fulfillAssignment(assignment: Assignment, proposalId: ProposalId): void {
    const now = this.clock.now();
    this.store.assignments.set(assignment.id, {
      ...assignment,
      status: 'submitted',
      fulfilled_by: proposalId,
      updated_at: now,
    });
    if (assignment.task.kind === 'review') return;
    const slotKey = assignmentTaskKey(assignment.task);
    for (const sibling of this.store.assignments.values()) {
      if (sibling.id === assignment.id) continue;
      if (sibling.status !== 'accepted') continue;
      if (sibling.task.kind === 'review') continue;
      if (assignmentTaskKey(sibling.task) !== slotKey) continue;
      this.store.assignments.set(sibling.id, {
        ...sibling,
        status: 'lapsed',
        updated_at: now,
      });
    }
  }

  // Lazy precondition-lapse (PRD §Write-path tools, "Assignment"):
  // returns the assignment, transitioned to `lapsed` if it is still
  // open (`offered`/`accepted`) but can no longer be honestly
  // completed — the slot resolves with no contributor action, no
  // credit, no penalty. Terminal assignments pass through unchanged.
  // Driven lazily (the single-slot walk in request_assignment, and
  // fulfillment) rather than by a scheduler — PRD commits no curator
  // expiry sweep for liveness.
  //
  // A lapsed precondition is *not* the same as an unresolvable-as-
  // fulfillment finding: a child whose parent anchor went `unresolvable`
  // lapses here (the work can't be done), whereas an anchor whose own
  // `external_ref` will not resolve materializes a real negative-result
  // fulfillment through `propose_supersedes`, not this path.
  private lapseIfPreconditionGone(a: Assignment): Assignment {
    if (a.status !== 'accepted') return a;
    if (!this.assignmentPreconditionHolds(a)) {
      const lapsed: Assignment = { ...a, status: 'lapsed', updated_at: this.clock.now() };
      this.store.assignments.set(a.id, lapsed);
      return lapsed;
    }
    return a;
  }

  // The precondition for an open assignment: its scope is still open
  // and its target still admits the work. Conservative — only the
  // committed lapse triggers (cause/sub-topic closed; review target
  // gone or archived-without-resolution; excerpt parent anchor gone
  // `unresolvable`). A review task is NOT lapsed merely because its
  // proposal left `staged`: a calibration review task is — by design,
  // structurally indistinguishable from a real one — pointed at an
  // `accepted` validated-history proposal, and a real review task
  // whose proposal resolved concurrently degrades to a calibration-
  // style late vote scored against ground truth. Only `unresolved-
  // archived` (divergence-closure, no ground truth) makes the review
  // genuinely moot.
  private assignmentPreconditionHolds(a: Assignment): boolean {
    if (a.task.kind === 'review') {
      const proposal = this.store.proposals.get(a.task.proposal_id);
      if (!proposal || proposal.status === 'unresolved-archived') return false;
      const route = this.locateProposalForReview(proposal);
      if (!route) return false;
      return this.scopeOpen(route.cause_id, route.sub_topic_id);
    }
    if (!this.scopeOpen(a.task.cause_id, a.task.sub_topic_id)) return false;
    if (a.task.kind === 'excerpt') {
      const parent = this.store.nodes.get(a.task.parent_anchor_id);
      if (!parent || (parent.kind === 'anchor' && parent.status === 'unresolvable')) {
        return false;
      }
    }
    return true;
  }

  private scopeOpen(causeId: CauseId, subTopicId: SubTopicId): boolean {
    const cause = this.store.causes.get(causeId);
    if (!cause || cause.status !== 'active') return false;
    const subTopic = this.store.subTopics.get(subTopicId);
    if (!subTopic || subTopic.status !== 'active') return false;
    return true;
  }

  // A finite `assignment_ttl_seconds` stamps an absolute `ttl_at` on
  // every minted assignment; past it the covering slot stops covering
  // its frontier item (`deriveFrontier`) so the next caller's pull
  // mints a `shadow_of` re-offer. Default Infinity → no stamp, no
  // shadowing: every pre-TTL scenario is unaffected.
  private ttlStamp(now: Timestamp): { ttl_at?: Timestamp } {
    const ttl = this.review.assignment_ttl_seconds;
    if (!Number.isFinite(ttl) || ttl <= 0) return {};
    return { ttl_at: Timestamp.parse(new Date(Date.parse(now) + ttl * 1000).toISOString()) };
  }

  // The covering slot (if any) that has gone past its `ttl_at` for a
  // single-holder task target — what makes a fresh pull on that target
  // a shadow re-offer rather than a first offer. Review tasks never
  // shadow (N parallel reviewers by design). Returns the oldest such
  // slot for a stable `shadow_of` target across concurrent shadows.
  private staleCoveringSlot(task: AssignmentTask): Assignment | undefined {
    if (task.kind === 'review') return undefined;
    const ttl = this.review.assignment_ttl_seconds;
    if (!Number.isFinite(ttl) || ttl <= 0) return undefined;
    const nowMs = Date.parse(this.clock.now());
    const key = assignmentTaskKey(task);
    let oldest: Assignment | undefined;
    for (const a of this.store.assignments.values()) {
      if (a.status !== 'accepted') continue;
      if (a.task.kind === 'review') continue;
      if (assignmentTaskKey(a.task) !== key) continue;
      if (a.ttl_at === undefined || Date.parse(a.ttl_at) > nowMs) continue;
      if (!oldest || a.created_at < oldest.created_at) oldest = a;
    }
    return oldest;
  }

  // The cause an assignment task is scoped to. Most task variants
  // carry cause_id explicitly; the review variant is scoped via the
  // proposal it targets. Used by the rate-cap counter so the same
  // contributor's assignments under different causes don't share a
  // budget.
  private causeOfTask(task: AssignmentTask): CauseId | null {
    if (task.kind === 'review') {
      const proposal = this.store.proposals.get(task.proposal_id);
      if (!proposal) return null;
      const located = this.locateProposalForReview(proposal);
      return located?.cause_id ?? null;
    }
    return task.cause_id;
  }

  // Map a frontier item to a concrete assignment task. Returns null
  // for frontier kinds that don't have a v0 task mapping
  // (`unresolvable_anchor` needs a re-anchor task variant the schema
  // doesn't carry; `needs_synthesis` has no v0 derivation heuristic).
  private frontierItemToTask(item: FrontierItem): AssignmentTask | null {
    switch (item.kind) {
      case 'orphan_anchor':
        return {
          kind: 'excerpt',
          cause_id: item.cause_id,
          sub_topic_id: item.sub_topic_id,
          parent_anchor_id: item.anchor_id,
        };
      case 'needs_review':
        return { kind: 'review', proposal_id: item.proposal_id };
      case 'unresolvable_anchor':
      case 'needs_synthesis':
        return null;
    }
  }

  // Per-proposal distinct-reviewer count for the corpus-confirmation
  // depth-floor filter (PRD §Calibration batches, corpus-composition
  // closure rule). Walks the vote store once and returns a Map; the
  // `corpus_confirmation_depth_floor` config is the threshold both
  // calibration-draw paths (`drawCalibrationTask`,
  // `fetchCalibrationBatch`) consult against. Default 0 makes the
  // count irrelevant (the per-candidate eligibility check short-
  // circuits before consulting the map), so the helper is only
  // computed when the gate is opted in.
  private corpusReviewerCounts(): Map<ProposalId, number> {
    const reviewersByProposal = new Map<ProposalId, Set<IdentityId>>();
    for (const v of this.store.reviewVotes.values()) {
      let set = reviewersByProposal.get(v.proposal_id);
      if (!set) {
        set = new Set();
        reviewersByProposal.set(v.proposal_id, set);
      }
      set.add(v.reviewer_id);
    }
    const counts = new Map<ProposalId, number>();
    for (const [pid, set] of reviewersByProposal.entries()) {
      counts.set(pid, set.size);
    }
    return counts;
  }

  // Corpus-confirmation depth-floor filter (PRD §Calibration batches,
  // corpus-composition closure rule). Anchors are structurally exempt
  // (`payload.kind === 'anchor'`) — they are the ground-truth
  // substrate, not synthesis-from-review, so the "first review
  // session" framing doesn't apply, and once they enter the corpus
  // they accumulate calibration-vote reviewers that would otherwise
  // mis-trip a count-only floor against the substrate itself. Every
  // other accepted-from-history kind is subject to the floor: the
  // distinct-reviewer count over the vote store must meet the floor
  // before the item is eligible as a calibration draw, requiring
  // accumulated independent confirmation past the convergence pair
  // before the item enters the corpus.
  private passesCorpusDepthFloor(proposal: Proposal, counts: Map<ProposalId, number>): boolean {
    const floor = this.review.corpus_confirmation_depth_floor;
    if (floor <= 0) return true;
    if (proposal.payload.kind === 'anchor') return true;
    const count = counts.get(proposal.id) ?? 0;
    return count >= floor;
  }

  // Pick a calibration target for a reviewer in this cause. Calibration
  // items are accepted-from-history proposals (PRD §Calibration batches:
  // "drawn from the graph's own validated history — proposals that
  // survived multiple confirmations and have been stable"). The
  // task wears the same `review` shape as a real review task; the
  // accepted-status seam is what tells `cast_review_vote` to score
  // against ground truth instead of running convergence. Conflict-of-
  // interest, already-voted, and no-double-offer gates mirror the
  // regular review-assignment path so a calibration item can't be
  // distinguished by being subject to laxer rules. Returns null when
  // no eligible candidate exists — e.g., a fresh sub-topic where no
  // proposal has yet been accepted.
  private drawCalibrationTask(
    causeId: CauseId,
    callerId: IdentityId,
    callerAssignments: readonly Assignment[],
  ): AssignmentTask | null {
    const reviewerCounts =
      this.review.corpus_confirmation_depth_floor > 0 ? this.corpusReviewerCounts() : null;
    const candidates: Proposal[] = [];
    for (const p of this.store.proposals.values()) {
      if (p.status !== 'accepted') continue;
      if (p.proposer_id === callerId) continue;
      const located = this.locateProposalForReview(p);
      if (!located || located.cause_id !== causeId) continue;
      // Corpus-confirmation depth floor — same filter
      // `fetchCalibrationBatch` applies on the public read-path. Both
      // calibration-draw seams must consult it, since the
      // assignment-injection path is what the testbed's calibration-
      // density scenarios drive against.
      if (reviewerCounts && !this.passesCorpusDepthFloor(p, reviewerCounts)) continue;
      let voted = false;
      for (const v of this.store.reviewVotes.values()) {
        if (v.proposal_id === p.id && v.reviewer_id === callerId) {
          voted = true;
          break;
        }
      }
      if (voted) continue;
      const taskKey = `review:${p.id}`;
      const alreadySeen = callerAssignments.some(
        (a) => a.status === 'accepted' && assignmentTaskKey(a.task) === taskKey,
      );
      if (alreadySeen) continue;
      candidates.push(p);
    }
    // Recency bias matches `fetchCalibrationBatch` (PRD §Calibration batches:
    // "biased toward fresh-but-validated history"). Tiebreak by id
    // for replay determinism.
    candidates.sort((a, b) => {
      if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at);
      return a.id.localeCompare(b.id);
    });
    const top = candidates[0];
    if (!top) return null;
    return { kind: 'review', proposal_id: top.id };
  }

  // Locate the (cause, sub-topic) for review-routing of a staged
  // proposal. Curator-only kinds (`sub_topic`, `change_of_home`)
  // return null — they are not surfaced to the reviewer pool.
  // Membership routes to the *target* sub-topic per PRD §Write-path tools (propose_membership).
  // Supersedes routes to the from-node's home (the home owns the node
  // being deactivated).
  private locateProposalForReview(
    p: Proposal,
  ): { cause_id: CauseId; sub_topic_id: SubTopicId } | null {
    switch (p.payload.kind) {
      case 'anchor':
      case 'excerpt':
      case 'synthesis':
      case 'open_question':
        return { cause_id: p.payload.cause_id, sub_topic_id: p.payload.home_sub_topic_id };
      case 'membership': {
        const target = this.store.subTopics.get(p.payload.sub_topic_id);
        if (!target) return null;
        return { cause_id: target.cause_id, sub_topic_id: p.payload.sub_topic_id };
      }
      case 'supersedes': {
        const fromNode = this.store.nodes.get(p.payload.from_node_id);
        if (!fromNode) return null;
        const home = this.store.subTopics.get(fromNode.home_sub_topic_id);
        if (!home) return null;
        return { cause_id: home.cause_id, sub_topic_id: fromNode.home_sub_topic_id };
      }
      case 'sub_topic':
      case 'change_of_home':
        return null;
    }
  }

  // Reject supersedes cycles (PRD §Edges: "Supersedes cycles A→B→C→A are
  // forbidden by the verification engine"). We walk the existing active
  // supersedes edges starting from the proposed `to` end and look for the
  // proposed `from` end. If the new edge would close a cycle, reject.
  // Linear in the number of supersedes edges; fine for an in-memory store
  // and the load profile of a single MCP server. When edges move to a
  // proper store the structure can be precomputed.
  private supersedesWouldCycle(fromId: NodeId, toId: NodeId): boolean {
    if (fromId === toId) return true;
    const successors = new Map<NodeId, NodeId[]>();
    for (const e of this.store.edges.values()) {
      if (e.kind !== 'supersedes' || e.status !== 'active') continue;
      const list = successors.get(e.from) ?? [];
      list.push(e.to);
      successors.set(e.from, list);
    }
    const seen = new Set<NodeId>();
    const stack: NodeId[] = [toId];
    while (stack.length > 0) {
      const cur = stack.pop() as NodeId;
      if (cur === fromId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const next = successors.get(cur);
      if (next) stack.push(...next);
    }
    return false;
  }

  readonly bootstrap = {
    mintIdentity: (input: MintIdentityInput): Identity => {
      const parsed = MintIdentityInput.parse(input);
      const provider = parsed.identity_provider ?? 'harness';
      // Conditional invariant the strict schema can't express:
      // IdP-driven providers carry a subject (identity-on-first-
      // signin pivots on it); `'harness'` mints do not (no external
      // subject to bind against — admin and testbed identities are
      // server-internal).
      if (provider === 'harness' && parsed.identity_provider_subject !== undefined) {
        throw new ServerError(
          'invalid_input',
          'identity_provider_subject is only valid with an IdP-driven identity_provider',
        );
      }
      if (provider !== 'harness' && parsed.identity_provider_subject === undefined) {
        throw new ServerError(
          'invalid_input',
          `identity_provider '${provider}' requires identity_provider_subject`,
        );
      }
      // Slice 4b role-provider invariant: only `'harness'` mints can
      // produce a curator. The admin CLI (`anchorage-admin
      // mint-curator`) is the production path for curator seating;
      // an IdP-driven mint that requested `role: 'curator'` would
      // open a coordination back-door (any GitHub account could
      // self-promote on first signin) that the operator-only
      // bootstrap precludes by construction. PRD §Identity (Roles).
      const role = parsed.role ?? 'contributor';
      if (role === 'curator' && provider !== 'harness') {
        throw new ServerError(
          'invalid_input',
          `curator role can only be minted under identity_provider 'harness'; got '${provider}'`,
        );
      }
      // Identity-on-first-signin: if the (provider, subject) pair
      // already names an existing identity, the IdP-mint path is a
      // bug — `GithubOAuthAuthenticator` resolves through
      // `identityProviderSubjects` *before* reaching here. The
      // server-side check is the second line of defense; minting
      // would otherwise silently fork the identity and break the
      // "one human, one identity" invariant the bounded-identities-
      // per-real-person commitment depends on (PRD §Identity).
      if (parsed.identity_provider_subject !== undefined) {
        const key = `${provider}|${parsed.identity_provider_subject}`;
        const existing = this.store.identityProviderSubjects.get(key);
        if (existing !== undefined) {
          throw new ServerError(
            'invalid_state',
            `identity already exists for (${provider}, ${parsed.identity_provider_subject}): ${existing}`,
          );
        }
      }
      const identity: Identity = {
        id: this.idGen.identityId(),
        display_name: parsed.display_name,
        status: 'active',
        created_at: this.clock.now(),
        attestation_level: parsed.attestation_level ?? 0,
        identity_provider: provider,
        ...(parsed.identity_provider_subject !== undefined
          ? { identity_provider_subject: parsed.identity_provider_subject }
          : {}),
        role,
      };
      this.store.identities.set(identity.id, identity);
      if (parsed.identity_provider_subject !== undefined) {
        const key = `${provider}|${parsed.identity_provider_subject}`;
        this.store.identityProviderSubjects.set(key, identity.id);
      }
      return identity;
    },

    bindAgentCredential: (input: BindAgentCredentialInput): BindAgentCredentialResult => {
      const parsed = BindAgentCredentialInput.parse(input);
      const identityId = parsed.identity_id as IdentityId;
      const identity = this.store.identities.get(identityId);
      if (!identity) {
        throw new ServerError('not_found', `identity not found: ${parsed.identity_id}`);
      }
      if (identity.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `cannot bind credential to ${identity.status} identity`,
        );
      }
      // Mint an opaque bearer secret; store only its hash. The plain
      // secret is returned to the caller exactly once (here) and is
      // never reachable from the store afterward. PRD §Identity
      // (Authenticator seam). The IdGen path is what makes
      // SeededIdGen-driven tests (cassettes, parity) deterministic;
      // RandomIdGen uses `randomBytes` for production-grade entropy.
      const secret = this.idGen.bearerSecret();
      const secret_hash = hashBearerSecret(secret);
      const credential: AgentCredential = {
        id: this.idGen.agentCredentialId(),
        identity_id: identity.id,
        label: parsed.label,
        status: 'active',
        created_at: this.clock.now(),
        secret_hash,
      };
      this.store.agentCredentials.set(credential.id, credential);
      this.store.agentCredentialSecrets.set(secret_hash, credential.id);
      return { credential, secret };
    },

    createCause: (input: CreateCauseInput): Cause => {
      const parsed = CreateCauseInput.parse(input);
      const cause: Cause = {
        id: this.idGen.causeId(),
        name: parsed.name,
        description: parsed.description,
        status: 'active',
        created_at: this.clock.now(),
      };
      this.store.causes.set(cause.id, cause);
      return cause;
    },

    // Curator-seeded sub-topics start `active`; contributor-proposed
    // sub-topics (via the wired `propose_sub_topic` tool) start
    // `proposed` and need curator approval (curator.acceptProposal)
    // to flip to `active`. PRD §Sub-topic creation governance.
    seedSubTopic: (input: SeedSubTopicInput): SubTopic => {
      const parsed = SeedSubTopicInput.parse(input);
      const causeId = parsed.cause_id as CauseId;
      const cause = this.store.causes.get(causeId);
      if (!cause) {
        throw new ServerError('not_found', `cause not found: ${parsed.cause_id}`);
      }
      if (cause.status !== 'active') {
        throw new ServerError('invalid_state', `cannot seed sub-topic under ${cause.status} cause`);
      }
      const subTopic: SubTopic = {
        id: this.idGen.subTopicId(),
        cause_id: cause.id,
        name: parsed.name,
        description: parsed.description,
        scope_query: parsed.scope_query,
        status: 'active',
        created_at: this.clock.now(),
      };
      this.store.subTopics.set(subTopic.id, subTopic);
      return subTopic;
    },
  };

  readonly tools = {
    // PRD §Write-path tools ("Assignment"): request_assignment pulls a
    // single task from the frontier. There is no capacity declaration —
    // the contributor holds one FIFO slot per (identity, cause), so the
    // only availability signal is the act of asking, and a fresh pull is
    // refused while the slot it would occupy is still unresolved.
    //
    // v0 maps two frontier kinds onto assignment tasks:
    //
    //   - `orphan_anchor`  → propose-excerpt task pinning the parent.
    //   - `needs_review`   → review task pinning the proposal.
    //
    // `unresolvable_anchor` and `needs_synthesis` are not assignment-
    // mappable yet — the former needs a re-anchor task variant the
    // current AssignmentTask schema doesn't carry; the latter has no
    // frontier-derivation heuristic. Both surface in query_frontier
    // and are reachable via contributor-initiated propose_* calls.
    //
    // Eligibility gates, in order:
    //
    //   1. Single-slot: the caller holds no unresolved (offered or
    //      accepted) assignment in this cause. This subsumes the old
    //      capacity rate cap entirely — over-pull is impossible without
    //      trusting client behavior, and frontier starvation becomes a
    //      non-property rather than a tuned bound. A held slot whose
    //      precondition has lapsed is auto-resolved here (lazily, no
    //      scheduler) before the gate is evaluated, so a contributor is
    //      never wedged by a slot that can no longer be completed.
    //   2. Reputation gates (`assignment_min_recent` /
    //      `assignment_min_demonstrated`, PRD §Reputation).
    //   3. `kind`, when supplied, is a strict per-kind filter — not a
    //      soft preference and not an expertise signal (PRD §Write-path
    //      tools, "No expertise routing": every task is a corpus task
    //      any contributor can pull).
    //   4. Caller isn't the proposer of a needs_review task — same
    //      conflict-of-interest invariant cast_review_vote enforces.
    //
    // The same review task may be offered to multiple contributors
    // simultaneously (PRD §Reviewer assignment: N reviewers per
    // proposal); cross-contributor exclusion is not enforced here. A
    // frontier item whose covering slot is past its `ttl_at` re-enters
    // the frontier and the assignment minted here carries `shadow_of`
    // pointing at the original slot — TTL-as-shadow-reassignment (PRD
    // §Write-path tools, "Assignment"), driven lazily by the next
    // caller rather than a curator expiry sweep.
    requestAssignment: async (
      caller: Caller,
      input: RequestAssignmentInput,
    ): Promise<RequestAssignmentOutput> => {
      const parsed = RequestAssignmentInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireMinAttestation(identity);
      this.accountWriteAction(identity);
      this.requireActiveCause(parsed.cause_id);

      // Single-slot enforcement (PRD §Write-path tools, "Assignment").
      // Walk the caller's assignments in this cause once: lazily resolve
      // any whose precondition has lapsed, then refuse the pull if an
      // unresolved slot remains. A `shadow_of` assignment counts as the
      // backup holder's working slot just like a directly-pulled one —
      // it is work in hand, not a second slot.
      const callerAssignmentsForTarget: Assignment[] = [];
      for (const a of this.store.assignments.values()) {
        if (a.contributor_id !== identity.id) continue;
        if (this.causeOfTask(a.task) !== parsed.cause_id) continue;
        const resolved = this.lapseIfPreconditionGone(a);
        callerAssignmentsForTarget.push(resolved);
        if (resolved.status === 'accepted') {
          throw new ServerError(
            'invalid_state',
            `single-slot: ${identity.id} already holds an unresolved assignment (${resolved.id}, ${resolved.status}) in cause ${parsed.cause_id} — fulfill or let it resolve before pulling another`,
          );
        }
      }

      // Reputation gates (PRD §Reputation). Two thresholds compose at
      // assignment time: `assignment_min_recent` ("fast-decay, gates
      // assignment") and `assignment_min_demonstrated` ("slow-decay,
      // gates eligibility tiers"). The two gates have *opposite*
      // null-policies and that is load-bearing:
      //
      //   - Recent gate: callers with no rep entries in the cause
      //     bypass — fresh reviewers must be able to bootstrap, and a
      //     missing entry has no decay state to fall below. The gate
      //     fires against contributors who once had recent rep and
      //     have let it drain (the patient-adversary signature).
      //
      //   - Demonstrated gate: callers with no rep entries in the
      //     cause FAIL — the demonstrated tier is "have you proven
      //     yourself yet?", and an unproven identity is by
      //     construction not in the pool. The gate fires against
      //     fresh identities (the sybil-amplified-coalition
      //     signature). Bootstrap is contributor-initiated voting
      //     (cast_review_vote with no assignment_id) and direct
      //     proposing — both earn rep without passing the gate.
      //
      // Default 0 on both leaves them inert; existing scenarios are
      // unaffected. Walked once across the caller's rep entries.
      if (this.review.assignment_min_recent > 0 || this.review.assignment_min_demonstrated > 0) {
        const now = this.clock.now();
        let maxRecent: number | null = null;
        let maxDemonstrated: number | null = null;
        for (const r of this.store.reputations.values()) {
          if (r.identity_id !== identity.id) continue;
          if (r.cause_id !== parsed.cause_id) continue;
          const decayed = this.decayedReputation(r, now);
          if (maxRecent === null || decayed.recent > maxRecent) {
            maxRecent = decayed.recent;
          }
          if (maxDemonstrated === null || decayed.demonstrated > maxDemonstrated) {
            maxDemonstrated = decayed.demonstrated;
          }
        }
        if (
          this.review.assignment_min_recent > 0 &&
          maxRecent !== null &&
          maxRecent < this.review.assignment_min_recent
        ) {
          throw new ServerError(
            'not_found',
            `recent-activity below assignment threshold (${maxRecent.toFixed(4)} < ${this.review.assignment_min_recent}) for ${identity.id} in cause ${parsed.cause_id}`,
          );
        }
        if (this.review.assignment_min_demonstrated > 0) {
          if (maxDemonstrated === null) {
            throw new ServerError(
              'not_found',
              `no demonstrated competence in cause ${parsed.cause_id} for ${identity.id} (eligibility tier requires demonstrated >= ${this.review.assignment_min_demonstrated}; bootstrap via contributor-initiated proposing or voting)`,
            );
          }
          if (maxDemonstrated < this.review.assignment_min_demonstrated) {
            throw new ServerError(
              'not_found',
              `demonstrated competence below eligibility threshold (${maxDemonstrated.toFixed(4)} < ${this.review.assignment_min_demonstrated}) for ${identity.id} in cause ${parsed.cause_id}`,
            );
          }
        }
      }

      // `kind` is a strict per-kind filter when supplied (PRD
      // §Write-path tools): not a soft preference, not an expertise
      // signal. Absent, every assignable work kind is in scope — there
      // is no declared-kinds set to intersect with anymore.
      const wantedKinds: ReadonlySet<WorkKind> = parsed.kind
        ? new Set<WorkKind>([parsed.kind])
        : new Set<WorkKind>(WorkKind.options);

      // Calibration injection. PRD §Calibration batches + §Why assignment-driven contribution closes several attack surfaces:
      // calibration items arrive on the same assignment surface as real
      // review work, structurally indistinguishable to the reviewer.
      // Cadence is config-driven so the testbed can sweep it; baseline
      // (every_n=0) is disabled and leaves the frontier-only path
      // unchanged. We count review-task offers to this caller in this
      // cause and inject every Nth one — deterministic given a fixed
      // history, which is what the testbed needs for replay. The draw
      // can fail (no validated history yet, or all candidates excluded
      // by conflict-of-interest / already-voted gates), in which case
      // we fall through to the regular frontier loop rather than fail
      // the request.
      if (this.review.calibration_inject_every_n > 0 && wantedKinds.has('review')) {
        let priorReviewOffers = 0;
        for (const a of callerAssignmentsForTarget) {
          if (a.task.kind === 'review') priorReviewOffers += 1;
        }
        if ((priorReviewOffers + 1) % this.review.calibration_inject_every_n === 0) {
          const calTask = this.drawCalibrationTask(
            parsed.cause_id,
            identity.id,
            callerAssignmentsForTarget,
          );
          if (calTask) {
            const now = this.clock.now();
            const assignment: Assignment = {
              id: this.idGen.assignmentId(),
              contributor_id: identity.id,
              task: calTask,
              status: 'accepted',
              created_at: now,
              updated_at: now,
              ...this.ttlStamp(now),
            };
            this.store.assignments.set(assignment.id, assignment);
            return { status: 'assigned', assignment_id: assignment.id, task: calTask };
          }
        }
      }

      const frontier = this.deriveFrontier({ cause_id: parsed.cause_id });
      for (const item of frontier) {
        const task = this.frontierItemToTask(item);
        if (!task) continue;
        if (!wantedKinds.has(taskWorkKind(task))) continue;

        // Conflict-of-interest: skip review tasks for the caller's
        // own proposals.
        if (task.kind === 'review') {
          const target = this.store.proposals.get(task.proposal_id);
          if (!target) continue;
          if (target.proposer_id === identity.id) continue;
          // And skip if the caller has already voted (their
          // contributor-initiated review already attached to the
          // proposal); re-offering would be redundant and the cast_
          // review_vote double-vote guard would reject submission.
          let voted = false;
          for (const v of this.store.reviewVotes.values()) {
            if (v.proposal_id === task.proposal_id && v.reviewer_id === identity.id) {
              voted = true;
              break;
            }
          }
          if (voted) continue;

          // Cross-stratum draw rule (PRD §Reviewer assignment, "prefer
          // not-yet-represented strata first"). When stratification is
          // enabled, skip this proposal for this caller if a co-stratum
          // reviewer is already routed to it (via offered/accepted
          // assignment OR an existing vote). The selector falls through
          // to the next frontier item, which is the only point in the
          // pull model where "another reviewer should take this slot"
          // can be expressed. Falls back to per-stratum saturation only
          // when the pool is otherwise exhausted; the v0 graceful-
          // degradation comes from convergence tightening on the
          // stratification-degraded flag rather than a second pass
          // through this loop.
          if (this.review.stratification_enabled) {
            const route = this.locateProposalForReview(target);
            if (route) {
              const strata = this.computeReviewerStrata(route.cause_id, route.sub_topic_id);
              const callerStratum = this.stratumIdOf(identity.id, strata);
              const routedReviewers = new Set<IdentityId>();
              for (const a of this.store.assignments.values()) {
                if (a.task.kind !== 'review') continue;
                if (a.task.proposal_id !== target.id) continue;
                if (a.status !== 'accepted') continue;
                routedReviewers.add(a.contributor_id);
              }
              for (const v of this.store.reviewVotes.values()) {
                if (v.proposal_id === target.id) routedReviewers.add(v.reviewer_id);
              }
              let coStratumAlreadyRouted = false;
              for (const rid of routedReviewers) {
                if (this.stratumIdOf(rid, strata) === callerStratum) {
                  coStratumAlreadyRouted = true;
                  break;
                }
              }
              if (coStratumAlreadyRouted) continue;
            }
          }
        }

        // Don't re-offer a target this caller already delivered. The
        // single-slot gate above guarantees the caller holds no
        // unresolved assignment, so the only same-target history that
        // can exist here is a terminal one: `submitted` (already
        // delivered — skip) or `lapsed` (precondition gone or lost a
        // TTL-shadow race — re-offering is fine, the frontier already
        // re-derived it). Different contributors get the target offered
        // independently.
        const taskKey = assignmentTaskKey(task);
        const alreadyDelivered = callerAssignmentsForTarget.some(
          (a) => a.status === 'submitted' && assignmentTaskKey(a.task) === taskKey,
        );
        if (alreadyDelivered) continue;

        // TTL-as-shadow (PRD §Write-path tools, "Assignment"). If the
        // frontier re-exposed this target only because another
        // contributor's covering slot went past its `ttl_at`, the
        // assignment minted here is a shadow re-offer: it points at the
        // original slot via `shadow_of`, and whichever of the two
        // resolves first releases both (`fulfillAssignment`). A target
        // with no past-TTL covering slot mints an ordinary first offer.
        const shadowed = this.staleCoveringSlot(task);
        const now = this.clock.now();
        const assignment: Assignment = {
          id: this.idGen.assignmentId(),
          contributor_id: identity.id,
          task,
          status: 'accepted',
          created_at: now,
          updated_at: now,
          ...(shadowed ? { shadow_of: shadowed.id } : {}),
          ...this.ttlStamp(now),
        };
        this.store.assignments.set(assignment.id, assignment);
        return { status: 'assigned', assignment_id: assignment.id, task };
      }

      // Frontier exhaustion is an honest result, not an error (PRD
      // §Write-path tools, "Assignment"). The graph-derivable frontier
      // — review tasks for others' staged proposals, gap-closing tasks
      // for accepted nodes — has nothing eligible for this caller
      // right now (own-proposal skip, already-voted skip, single-slot
      // gate already cleared, no stratification-unique slot, etc.).
      // The cause is still open: the propose_* tools are callable
      // off-slot (the contributor-initiated path, see "Contributor-
      // initiated work is off-slot" — this caller holds no slot in the
      // cause, having just been refused one, so the guard does not
      // fire), and that path produces the inventory the *next*
      // contributor's frontier will draw from. The response carries
      // the cause's active sub-topics so the agent has each
      // `scope_query` in hand without a follow-up tool call.
      const subTopics = [...this.store.subTopics.values()]
        .filter((st) => st.cause_id === parsed.cause_id && st.status === 'active')
        .sort((a, b) => {
          if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
          return a.id.localeCompare(b.id);
        });
      // Why the frontier is empty *for this caller* shapes the guidance,
      // and the split is whether a review backlog exists at all. If there
      // are still-staged proposals in the cause, then — because any one
      // this caller could review would have been handed back as a review
      // task above — every one of them is a proposal this caller cannot
      // act on: either they proposed it (own-proposal skip) or they
      // already voted on it. The queue is not empty; it is waiting on
      // *other* contributors' independent votes, which this caller cannot
      // supply. Without surfacing that, an agent reads idle as "nothing
      // happened / go propose more" and piles new proposals onto a queue
      // that is actually starved of second reviewers (the live cold-start
      // trap a four-contributor instance hit: every staged item sat one
      // independent vote short — and the single-session pile-up where a
      // delegate, told to "add as many as you can," staged seven anchors
      // into a queue no one else was reviewing). Only when there are *no*
      // staged proposals at all is spontaneous proposing the
      // highest-value move, because then it seeds the review work the
      // next contributor will draw from. The signal stays deliberately
      // qualitative — we do *not* expose vote counts or proximity to
      // convergence, which would hand a coalition the timing to land a
      // closing vote; the caller already knows which proposals it
      // proposed or voted on, so this leaks nothing new. Same `reason`
      // and payload shape either way; only the prose differs.
      const hasStagedBacklogHere = [...this.store.proposals.values()].some(
        (p) => p.status === 'staged' && this.reputationCauseFor(p) === parsed.cause_id,
      );
      const guidance = hasStagedBacklogHere
        ? 'No scheduled work is currently eligible for you in this cause right now — ' +
          'but the queue is not empty. Every still-staged proposal here is one you ' +
          'cannot act on yourself: either you proposed it, or you have already reviewed ' +
          'it. Those proposals converge only when *other* contributors review them ' +
          'independently — votes you cannot supply. So this idle state is the queue ' +
          'waiting on more reviewers, not a dead end and not a signal to manufacture ' +
          'more work: piling on new proposals only deepens a queue already starved of ' +
          'second reviewers. Reviewing is the scarce resource that moves the graph, not ' +
          'proposing. The highest-value next steps are to bring another contributor in ' +
          'to review, or simply to step away and return later to pick up newly-staged ' +
          'work — an idle cause with a healthy backlog is a fine place to stop, not a ' +
          'failure state. If you do have a genuinely new connection or source in mind, ' +
          'the propose_* tools remain callable off-slot (propose_synthesis over accepted ' +
          "nodes, propose_supersedes for stale anchors, or a sub-topic's `scope_query` " +
          'with propose_anchor for new in-scope literature), but treat that as optional ' +
          'seeding, not a way to clear what is already pending.'
        : 'No scheduled work is currently eligible for you in this cause — the ' +
          "graph-derivable frontier (others' proposals to review, gap-closing tasks " +
          'over accepted nodes) is genuinely empty right now, with no staged proposals ' +
          'waiting. The cause is still open: the propose_* tools remain callable ' +
          'off-slot, and here a spontaneous proposal is the highest-value move because ' +
          'it seeds the frontier the next contributor will review. Lowest-friction ' +
          'first: browse subgraph:// and connect existing accepted nodes with ' +
          'propose_synthesis, or supersede stale anchors with propose_supersedes; to ' +
          'bring new evidence into scope, each sub-topic carries a `scope_query` you ' +
          'can use to find in-scope literature not yet anchored and submit it with ' +
          'propose_anchor. Stepping away until other contributors add work is equally ' +
          'legitimate — idle is not a failure state.';
      return {
        status: 'idle',
        cause_id: parsed.cause_id,
        reason: 'no_eligible_frontier_item',
        sub_topics: subTopics,
        guidance,
      };
    },

    // PRD §Write-path tools: propose_anchor stages an anchor proposal.
    // Synchronous verification at the tool boundary: external_ref must
    // resolve. If verification fails, no proposal record is created
    // (ProposalStatus comment: `rejected` means review-rejected, not
    // verification-rejected). An optional `assignment_id` fulfills an
    // accepted anchor-kind assignment (full assigned-work reputation);
    // without it the proposal is contributor-initiated.
    proposeAnchor: async (
      caller: Caller,
      input: ProposeAnchorInput,
    ): Promise<ProposeAnchorOutput> => {
      const parsed = ProposeAnchorInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireMinAttestation(identity);
      this.accountWriteAction(identity);

      const cause = this.requireActiveCause(parsed.cause_id);
      this.requireActiveSubTopicInCause(parsed.home_sub_topic_id, cause.id, 'home');
      const memberships = parsed.memberships ?? [];
      for (const m of memberships) {
        this.requireActiveSubTopicInCause(m, cause.id, 'membership');
      }
      const payload: ProposalPayload = {
        kind: 'anchor',
        cause_id: cause.id,
        home_sub_topic_id: parsed.home_sub_topic_id,
        ...(memberships.length > 0 ? { memberships } : {}),
        content: parsed.content,
        external_ref: parsed.external_ref,
      };
      // Assignment check before the (possibly external) verifier call,
      // so a misdirected fulfillment fails fast without a wasted fetch.
      const assignment = this.resolveProposalAssignment(identity.id, parsed.assignment_id, payload);

      const verified = await this.verifier.verifyExternalRef(parsed.external_ref);

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload,
        ...(assignment ? { assignment_id: assignment.id } : {}),
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      this.store.verifiedRefs.set(proposal.id, verified);
      if (assignment) this.fulfillAssignment(assignment, proposal.id);
      return { proposal_id: proposal.id };
    },

    // PRD §Write-path tools (propose_excerpt): propose_excerpt stages an
    // excerpt proposal under an existing accepted anchor, and the
    // server matches `quoted_span` against the resolved source —
    // mismatch rejects at write time, not at review time (PRD §Verification engine, Span verification).
    // The verifier owns the source-fetching boundary; the test
    // FakeVerifier holds source fixtures, the production verifier
    // will fetch. Schema-level checks (non-empty `text`,
    // non-negative `offset`) are necessary but not sufficient. An
    // optional `assignment_id` fulfills an accepted excerpt-kind
    // assignment whose task pins this same parent anchor (full
    // assigned-work reputation); without it the excerpt is
    // contributor-initiated and weighted lower.
    proposeExcerpt: async (
      caller: Caller,
      input: ProposeExcerptInput,
    ): Promise<ProposeExcerptOutput> => {
      const parsed = ProposeExcerptInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireMinAttestation(identity);
      this.accountWriteAction(identity);

      const cause = this.requireActiveCause(parsed.cause_id);
      this.requireActiveSubTopicInCause(parsed.home_sub_topic_id, cause.id, 'home');
      const memberships = parsed.memberships ?? [];
      for (const m of memberships) {
        this.requireActiveSubTopicInCause(m, cause.id, 'membership');
      }
      const parentAnchor = this.requireActiveAnchorInCause(parsed.parent_anchor_id, cause.id);
      const payload: ProposalPayload = {
        kind: 'excerpt',
        cause_id: cause.id,
        home_sub_topic_id: parsed.home_sub_topic_id,
        ...(memberships.length > 0 ? { memberships } : {}),
        parent_anchor_id: parsed.parent_anchor_id,
        content: parsed.content,
        quoted_span: parsed.quoted_span,
      };
      // Assignment check before the span verifier, so a misdirected
      // fulfillment fails fast without a wasted source fetch.
      const assignment = this.resolveProposalAssignment(identity.id, parsed.assignment_id, payload);
      // Span must appear in the parent anchor's source. Failure here
      // throws — the proposal is never staged, never assigned, never
      // shown to a reviewer.
      await this.verifier.verifySpan(parentAnchor.external_ref, parsed.quoted_span);

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload,
        ...(assignment ? { assignment_id: assignment.id } : {}),
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      if (assignment) this.fulfillAssignment(assignment, proposal.id);
      return { proposal_id: proposal.id };
    },

    // PRD §Write-path tools: propose_synthesis covers both `synthesis`
    // and `open_question` via a `kind` field on the input. Internally
    // the contracts split them into separate payloads (cleaner
    // discriminator); this tool routes the input into the right
    // payload variant. Parents may be any active node kind in the
    // same cause — anchors, excerpts, prior syntheses, or open
    // questions — because syntheses pull together evidence across
    // node kinds (PRD §Nodes: synthesis nodes connect 2+ parents). An
    // optional `assignment_id` fulfills an accepted synthesis- or
    // open_question-kind assignment whose pinned parent set matches the
    // proposal's; without it the proposal is contributor-initiated.
    proposeSynthesis: async (
      caller: Caller,
      input: ProposeSynthesisInput,
    ): Promise<ProposeSynthesisOutput> => {
      const parsed = ProposeSynthesisInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireMinAttestation(identity);
      this.accountWriteAction(identity);

      const cause = this.requireActiveCause(parsed.cause_id);
      this.requireActiveSubTopicInCause(parsed.home_sub_topic_id, cause.id, 'home');
      const memberships = parsed.memberships ?? [];
      for (const m of memberships) {
        this.requireActiveSubTopicInCause(m, cause.id, 'membership');
      }
      // De-duplicate parents at the tool boundary — multiple derives
      // edges between the same pair of nodes would be redundant and
      // would pollute future frontier/credit calculations. The schema
      // requires min(1) but doesn't enforce uniqueness.
      const parent_ids = [...new Set(parsed.parent_ids)];
      if (parent_ids.length !== parsed.parent_ids.length) {
        throw new ServerError('invalid_input', 'parent_ids must be unique');
      }
      for (const p of parent_ids) {
        this.requireActiveNodeInCause(p, cause.id);
      }

      const common = {
        cause_id: cause.id,
        home_sub_topic_id: parsed.home_sub_topic_id,
        ...(memberships.length > 0 ? { memberships } : {}),
        parent_ids,
        content: parsed.content,
      };
      const payload: ProposalPayload =
        parsed.kind === 'synthesis'
          ? { kind: 'synthesis', ...common }
          : { kind: 'open_question', ...common };
      const assignment = this.resolveProposalAssignment(identity.id, parsed.assignment_id, payload);

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload,
        ...(assignment ? { assignment_id: assignment.id } : {}),
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      if (assignment) this.fulfillAssignment(assignment, proposal.id);
      return { proposal_id: proposal.id };
    },

    // PRD §Write-path tools: propose_supersedes stages a supersedes edge
    // from an old node to its replacement. Unlike the other propose_*
    // tools the input doesn't carry a cause_id — the cause is implicit
    // in the nodes, and re-passing it would just create a surface for
    // inconsistency. Both nodes must be active (PRD §Edges:
    // "the `to` end must be active at proposal time"; we additionally
    // require the `from` end to be active because superseding an
    // already-superseded node is meaningless). Cycle prevention runs
    // here so contributors get a synchronous error rather than a delayed
    // acceptance failure. An optional `assignment_id` fulfills an
    // accepted supersedes-kind assignment pinning the same `from` node;
    // without it the proposal is contributor-initiated.
    proposeSupersedes: async (
      caller: Caller,
      input: ProposeSupersedesInput,
    ): Promise<ProposeSupersedesOutput> => {
      const parsed = ProposeSupersedesInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireMinAttestation(identity);
      this.accountWriteAction(identity);

      if (parsed.from_node_id === parsed.to_node_id) {
        throw new ServerError('invalid_input', 'from_node_id and to_node_id must differ');
      }

      const fromNode = this.store.nodes.get(parsed.from_node_id);
      if (!fromNode) {
        throw new ServerError('not_found', `from node not found: ${parsed.from_node_id}`);
      }
      if (fromNode.status !== 'active') {
        throw new ServerError('invalid_state', `from node ${fromNode.id} is ${fromNode.status}`);
      }
      const toNode = this.store.nodes.get(parsed.to_node_id);
      if (!toNode) {
        throw new ServerError('not_found', `to node not found: ${parsed.to_node_id}`);
      }
      if (toNode.status !== 'active') {
        throw new ServerError('invalid_state', `to node ${toNode.id} is ${toNode.status}`);
      }

      const fromCause = this.causeOfNode(fromNode);
      const toCause = this.causeOfNode(toNode);
      if (fromCause !== toCause) {
        throw new ServerError(
          'invalid_input',
          `supersedes endpoints belong to different causes (${fromCause} vs ${toCause})`,
        );
      }

      if (this.supersedesWouldCycle(fromNode.id, toNode.id)) {
        throw new ServerError(
          'invalid_input',
          `supersedes from ${fromNode.id} to ${toNode.id} would create a cycle`,
        );
      }

      const payload: ProposalPayload = {
        kind: 'supersedes',
        from_node_id: fromNode.id,
        to_node_id: toNode.id,
        rationale: parsed.rationale,
      };
      const assignment = this.resolveProposalAssignment(identity.id, parsed.assignment_id, payload);

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload,
        ...(assignment ? { assignment_id: assignment.id } : {}),
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      if (assignment) this.fulfillAssignment(assignment, proposal.id);
      return { proposal_id: proposal.id };
    },

    // PRD §Scope membership: propose_membership stages a claim that an
    // existing node is in scope for an additional sub-topic in the same
    // cause. Membership is what lets a single node serve multiple sub-
    // topics without duplication, forking supersedes chains, or
    // smuggling lineage (PRD §Edges). Reviewed by the *target* sub-
    // topic's reviewer pool — that's the pool with the expertise to
    // judge the scope claim — but reviewer assignment lives downstream
    // of this tool. An optional `assignment_id` fulfills an accepted
    // membership-kind assignment pinning the same node and target
    // sub-topic; without it the proposal is contributor-initiated.
    proposeMembership: async (
      caller: Caller,
      input: ProposeMembershipInput,
    ): Promise<ProposeMembershipOutput> => {
      const parsed = ProposeMembershipInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireMinAttestation(identity);
      this.accountWriteAction(identity);

      const node = this.store.nodes.get(parsed.node_id);
      if (!node) {
        throw new ServerError('not_found', `node not found: ${parsed.node_id}`);
      }
      if (node.status !== 'active') {
        throw new ServerError('invalid_state', `node ${node.id} is ${node.status}`);
      }
      const causeId = this.causeOfNode(node);
      // Membership target must be in the same cause: cross-cause scope
      // claims would smuggle lineage past the cause boundary, which the
      // multi-scale graph deliberately enforces.
      this.requireActiveSubTopicInCause(parsed.sub_topic_id, causeId, 'target');

      // Redundancy checks. A node trivially serves its home sub-topic;
      // re-claiming an existing scope membership creates a duplicate
      // proposal that contributes nothing. Both are caught here so the
      // contributor gets a synchronous, specific error rather than a
      // late acceptance failure or a silent no-op.
      if (node.home_sub_topic_id === parsed.sub_topic_id) {
        throw new ServerError(
          'invalid_input',
          `node ${node.id} is already homed in sub-topic ${parsed.sub_topic_id}`,
        );
      }
      if (node.scope_memberships.includes(parsed.sub_topic_id)) {
        throw new ServerError(
          'invalid_input',
          `node ${node.id} already has membership in sub-topic ${parsed.sub_topic_id}`,
        );
      }

      const payload: ProposalPayload = {
        kind: 'membership',
        node_id: node.id,
        sub_topic_id: parsed.sub_topic_id,
      };
      const assignment = this.resolveProposalAssignment(identity.id, parsed.assignment_id, payload);

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload,
        ...(assignment ? { assignment_id: assignment.id } : {}),
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      if (assignment) this.fulfillAssignment(assignment, proposal.id);
      return { proposal_id: proposal.id };
    },

    // PRD §Change of home: propose_change_of_home moves a node's home
    // sub-topic to a different one within the same cause. Rare in
    // practice — most apparent "wrong sub-topic" cases turn out to be
    // membership-needed cases, which is why the membership tool is the
    // first thing contributors should reach for. PRD §Write-path tools
    // (propose_change_of_home) marks this curator-approved; the review
    // loop is wired and other proposal kinds resolve through it
    // (resolveByConvergence on accumulated votes), but change_of_home
    // and sub_topic stay on the curator path — short-circuited inside
    // resolveByConvergence by their kind, accepted only via
    // curator.acceptProposal.
    proposeChangeOfHome: async (
      caller: Caller,
      input: ProposeChangeOfHomeInput,
    ): Promise<ProposeChangeOfHomeOutput> => {
      const parsed = ProposeChangeOfHomeInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireMinAttestation(identity);
      this.accountWriteAction(identity);

      const node = this.store.nodes.get(parsed.node_id);
      if (!node) {
        throw new ServerError('not_found', `node not found: ${parsed.node_id}`);
      }
      if (node.status !== 'active') {
        throw new ServerError('invalid_state', `node ${node.id} is ${node.status}`);
      }
      const causeId = this.causeOfNode(node);
      this.requireActiveSubTopicInCause(parsed.new_home_sub_topic_id, causeId, 'new home');

      if (node.home_sub_topic_id === parsed.new_home_sub_topic_id) {
        throw new ServerError(
          'invalid_input',
          `node ${node.id} is already homed in sub-topic ${parsed.new_home_sub_topic_id}`,
        );
      }

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload: {
          kind: 'change_of_home',
          node_id: node.id,
          new_home_sub_topic_id: parsed.new_home_sub_topic_id,
          rationale: parsed.rationale,
        },
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      return { proposal_id: proposal.id };
    },

    // PRD §Sub-topic creation: in v0 sub-topics are curator-gated.
    // propose_sub_topic stages the proposal; the SubTopic itself is not
    // materialized until a curator decision (accept-as-active via
    // curator.acceptProposal, or defer-as-proposed via
    // curator.deferSubTopic, per PRD §Sub-topic creation). Phase 3
    // (ROADMAP §Phase 3) layers graph-derived auto-discovery on top;
    // the tool surface stays the same.
    proposeSubTopic: async (
      caller: Caller,
      input: ProposeSubTopicInput,
    ): Promise<ProposeSubTopicOutput> => {
      const parsed = ProposeSubTopicInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireMinAttestation(identity);
      this.accountWriteAction(identity);

      const cause = this.requireActiveCause(parsed.cause_id);

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload: {
          kind: 'sub_topic',
          cause_id: cause.id,
          name: parsed.name,
          description: parsed.description,
          scope_query: parsed.scope_query,
        },
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      return { proposal_id: proposal.id };
    },

    // PRD §Read-path tools and resources (query_frontier): query_frontier
    // returns an ordered list of frontier items (work to be done),
    // optionally filtered by cause, sub-topic, or kind. The frontier
    // is derived from current graph state — see deriveFrontier — so
    // its consistency with the graph is by-construction. Callers must
    // be authenticated; the result is the same for everyone, but the
    // auth check keeps the tool accountable to rate-limit / abuse-
    // signal infrastructure that lives at the caller layer.
    queryFrontier: async (
      caller: Caller,
      input: QueryFrontierInput,
    ): Promise<QueryFrontierOutput> => {
      const parsed = QueryFrontierInput.parse(input);
      resolveCaller(this.store, caller);
      const items = this.deriveFrontier({
        ...(parsed.cause_id !== undefined ? { cause_id: parsed.cause_id } : {}),
        ...(parsed.sub_topic_id !== undefined ? { sub_topic_id: parsed.sub_topic_id } : {}),
        ...(parsed.frontier_kind !== undefined ? { frontier_kind: parsed.frontier_kind } : {}),
      });
      return { items };
    },

    // PRD §Read-path tools and resources (query_proposals): query_proposals
    // returns proposal records, optionally filtered by status, sub-
    // topic, or assignment-to-me. The sub-topic filter routes through
    // locateProposalForReview so the result for a given sub-topic
    // includes membership proposals targeting that sub-topic — which
    // matches where review pressure actually applies (PRD §Scope
    // membership: memberships are evaluated by reviewers from
    // the target sub-topic).
    queryProposals: async (
      caller: Caller,
      input: QueryProposalsInput,
    ): Promise<QueryProposalsOutput> => {
      const parsed = QueryProposalsInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      const proposals = [...this.store.proposals.values()].filter((p) => {
        if (parsed.status && p.status !== parsed.status) return false;
        if (parsed.assigned_to_me) {
          // assigned_to_me is true when there exists an assignment
          // owned by the caller that fulfills *or targets* this
          // proposal: a propose-kind assignment whose fulfilled_by
          // matches, or a review-kind assignment whose task points
          // at this proposal_id.
          let mine = false;
          for (const a of this.store.assignments.values()) {
            if (a.contributor_id !== identity.id) continue;
            if (a.fulfilled_by === p.id) {
              mine = true;
              break;
            }
            if (a.task.kind === 'review' && a.task.proposal_id === p.id) {
              mine = true;
              break;
            }
          }
          if (!mine) return false;
        }
        if (parsed.sub_topic_id) {
          const located = this.locateProposalForReview(p);
          if (!located || located.sub_topic_id !== parsed.sub_topic_id) return false;
        }
        return true;
      });
      // Stable order: created_at ascending, then id alphabetical for
      // determinism. Same rationale as queryFrontier — randomness in
      // selection lives at the assignment layer.
      proposals.sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
        return a.id.localeCompare(b.id);
      });
      // Project the derived stratification-degraded flag at read-path
      // (PRD §Reviewer assignment: "visible to the contributor"). No-op
      // when stratification is disabled or the proposal has reached a
      // terminal status — projectStratificationFlag handles both.
      const projected = proposals.map((p) => this.projectStratificationFlag(p));
      return { proposals: projected };
    },

    // PRD §Reputation: contributors see their own raw scores
    // (otherwise they can't reason about where they sit relative to
    // tier gates); other contributors see only tiers via a separate
    // public read-path. v0 returns the caller's per-sub-topic scores
    // for the requested cause, omitting (cause, sub_topic) pairs the
    // caller has zero reputation in (no pollution from sub-topics
    // they've never been routed into).
    queryReputation: async (
      caller: Caller,
      input: QueryReputationInput,
    ): Promise<QueryReputationOutput> => {
      const parsed = QueryReputationInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireActiveCause(parsed.cause_id);
      const now = this.clock.now();
      const entries: ReputationEntry[] = [];
      for (const r of this.store.reputations.values()) {
        if (r.identity_id !== identity.id) continue;
        if (r.cause_id !== parsed.cause_id) continue;
        const decayed = this.decayedReputation(r, now);
        entries.push({
          sub_topic_id: r.sub_topic_id,
          demonstrated: decayed.demonstrated,
          recent: decayed.recent,
        });
      }
      // Stable order so testbed assertions don't depend on Map
      // iteration order.
      entries.sort((a, b) => a.sub_topic_id.localeCompare(b.sub_topic_id));
      return { entries };
    },

    // PRD §Write-path tools (cast_review_vote): reviewer records a vote with
    // required rationale. With assignment_id set, the vote fulfills a
    // review-kind assignment and accrues full assigned-review reputation;
    // without it, the review is contributor-initiated and weighted lower.
    // Under single-slot the contributor-initiated form is also refused
    // while the caller holds an unresolved assignment in the proposal's
    // cause (it is off-slot work; the held slot must be fulfilled or
    // resolved first) — this is what keeps an assigned reviewer who omits
    // assignment_id from stranding its sole slot.
    // Self-review is rejected as a conflict-of-interest invariant: the
    // whole point of redundant peer review is that a contributor's own
    // claim be evaluated by other reviewers (PRD §Reviewer assignment
    // and the broader spirit of PRD §Reputation's stance on self-acting on
    // one's own work). Double-voting on the same proposal is rejected
    // for the same reason a vote tally needs to be coherent.
    castReviewVote: async (
      caller: Caller,
      input: CastReviewVoteInput,
    ): Promise<CastReviewVoteOutput> => {
      const parsed = CastReviewVoteInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireMinAttestation(identity);
      this.accountWriteAction(identity);

      const proposal = this.store.proposals.get(parsed.proposal_id);
      if (!proposal) {
        throw new ServerError('not_found', `proposal not found: ${parsed.proposal_id}`);
      }
      // Two valid voting paths: (a) staged proposals — the regular
      // review path that drives convergence; (b) accepted proposals
      // reached via assignment — the calibration path, which scores
      // the reviewer against ground truth without re-resolving a
      // proposal that is already settled. The assignment_id requirement
      // on (b) is what tells the system the reviewer received this
      // item via the calibration injection seam in request_assignment;
      // a contributor-initiated cast_review_vote on an already-accepted
      // proposal has no defined semantics (it cannot move convergence,
      // and treating it as calibration would let a reviewer farm rep
      // by self-selecting easy already-accepted items).
      const isCalibration = proposal.status === 'accepted' && parsed.assignment_id !== undefined;
      if (!isCalibration && proposal.status !== 'staged') {
        throw new ServerError(
          'invalid_state',
          `cannot vote on proposal in status ${proposal.status}`,
        );
      }
      if (proposal.proposer_id === identity.id) {
        throw new ServerError(
          'invalid_input',
          `reviewer ${identity.id} cannot review their own proposal ${proposal.id}`,
        );
      }
      // One vote per (reviewer, proposal). The vote tally would be
      // incoherent otherwise, and the abuse-cost story for review
      // requires that revoting be a deliberate operation (currently
      // not exposed; the existing vote can be the curator's reference).
      for (const v of this.store.reviewVotes.values()) {
        if (v.proposal_id === proposal.id && v.reviewer_id === identity.id) {
          throw new ServerError(
            'invalid_state',
            `reviewer ${identity.id} already voted on proposal ${proposal.id}`,
          );
        }
      }

      // If the reviewer asserts assignment fulfillment, the assignment
      // must exist, belong to them, target this proposal, and be in a
      // state that admits fulfillment. Without a prior
      // `request_assignment`, no assignment_id will resolve — which is
      // the correct behavior: a reviewer can't claim assignment credit
      // for an assignment that doesn't exist.
      if (parsed.assignment_id) {
        const assignment = this.store.assignments.get(parsed.assignment_id);
        if (!assignment) {
          throw new ServerError('not_found', `assignment not found: ${parsed.assignment_id}`);
        }
        if (assignment.contributor_id !== identity.id) {
          throw new ServerError(
            'unauthorized',
            `assignment ${assignment.id} does not belong to ${identity.id}`,
          );
        }
        if (assignment.task.kind !== 'review') {
          throw new ServerError(
            'invalid_input',
            `assignment ${assignment.id} is not a review task (got ${assignment.task.kind})`,
          );
        }
        if (assignment.task.proposal_id !== proposal.id) {
          throw new ServerError(
            'invalid_input',
            `assignment ${assignment.id} targets a different proposal`,
          );
        }
        if (assignment.status !== 'accepted') {
          throw new ServerError(
            'invalid_state',
            `assignment ${assignment.id} is ${assignment.status}`,
          );
        }
      }

      // Single-slot off-slot guard, shared with the `propose_*` path —
      // see `assertNoHeldSlot`. A contributor-initiated review (no
      // assignment_id) is off-slot work; refuse it while the caller
      // holds a slot in this proposal's cause (curator-gated kinds carry
      // no cause → undefined → no guard).
      if (!parsed.assignment_id) {
        const proposalCause = this.locateProposalForReview(proposal)?.cause_id;
        if (proposalCause) {
          this.assertNoHeldSlot(identity.id, proposalCause, {
            action: 'review',
            votingOnProposalId: proposal.id,
          });
        }
      }

      const now = this.clock.now();
      const vote: ReviewVote = {
        id: this.idGen.reviewVoteId(),
        proposal_id: proposal.id,
        reviewer_id: identity.id,
        decision: parsed.decision,
        rationale: parsed.rationale,
        ...(parsed.assignment_id ? { assignment_id: parsed.assignment_id } : {}),
        created_at: now,
      };
      this.store.reviewVotes.set(vote.id, vote);

      // If the vote fulfilled an assignment, mark the assignment
      // submitted and pin the fulfilling proposal. The assignment
      // surface will read this on next request_assignment to know not
      // to re-offer the same task.
      if (parsed.assignment_id) {
        const assignment = this.store.assignments.get(parsed.assignment_id);
        if (assignment) {
          this.store.assignments.set(assignment.id, {
            ...assignment,
            status: 'submitted',
            fulfilled_by: proposal.id,
            updated_at: now,
          });
        }
      }

      if (isCalibration) {
        // Calibration scoring against ground truth. The proposal
        // survived to acceptance in validated history, so the
        // expected vote is `accept`. PRD §Calibration batches:
        // "Reviewers who fail calibration lose reputation"; PRD
        // §Reputation: "rejected calibration items both decrease
        // reputation." `revise` is a no-op for symmetry with the
        // convergence-driven rep path, which also doesn't move rep
        // on revise (PRD §Reputation is silent on revise; treating
        // it as no-op preserves the "reviewer asked for more"
        // signal without forcing it onto a binary scoring axis).
        // The vote does not run convergence — the proposal is
        // already resolved.
        //
        // Calibration credit is *not* alpha-scaled. PRD §Reputation
        // commits `review_credit_contention_alpha` as the
        // difficulty-normalization knob on convergence-derived
        // review credit, applied in `applyReputationUpdates` per-
        // convergence. The calibration path is ground-truth-
        // individual (each item's correct answer is known), not
        // convergence-derived, so applying contention-scaling here
        // would be a category error: there's no contention to
        // measure on a single calibration vote, and the calibration
        // signal's whole point is to be a clean honesty channel
        // independent of the convergence-tally seam. Cube #3 (the
        // alpha re-baseline) reads off this distinction: the recent
        // gate's threshold survives alpha < 1 because the recent
        // buffer's quiet-window decay is dominated by alpha-
        // invariant calibration credit, while the demo gate's
        // threshold has to scale by alpha because the bootstrap
        // demonstrated buffer is convergence-derived.
        const subTopicId = this.reputationSubTopicFor(proposal);
        const causeId = this.reputationCauseFor(proposal);
        if (subTopicId && causeId && parsed.decision !== 'revise') {
          const delta =
            parsed.decision === 'accept'
              ? this.review.calibration_pass_gain
              : -this.review.calibration_fail_loss;
          this.bumpReputation(identity.id, causeId, subTopicId, delta);
          // Track the pass/fail counts separately from the rep ledger.
          // The convergence-layer defense reads this when calibration-
          // aware vote weighting is enabled; keeping it on a separate
          // counter avoids conflating calibration signal with
          // convergence-vote-accuracy rep, which a coalition can farm.
          this.bumpCalibrationRecord(
            identity.id,
            causeId,
            subTopicId,
            parsed.decision === 'accept' ? 'pass' : 'fail',
          );
        }
        return { vote_id: vote.id };
      }

      // Convergence check: enough accept-votes auto-accepts; enough
      // reject-votes auto-rejects. Threshold is server-config so the
      // testbed can sweep it (PRD §What's deliberately not specified here names this as a tuned
      // parameter). Curator-only kinds short-circuit inside
      // resolveByConvergence and are unaffected.
      this.resolveByConvergence(proposal.id);

      return { vote_id: vote.id };
    },

    // PRD §Calibration batches: reviewer batches mix
    // real proposals with calibration items drawn from the graph's
    // validated history. Calibration items must be statistically
    // indistinguishable from real frontier work in the dimensions a
    // reviewer can act on — which is why ReviewBatchItem strips
    // status, proposer, created_at, and assignment_id, leaving just
    // proposal_id and payload.
    //
    // v0 sampling: take up to CALIBRATION_BATCH_SIZE accepted
    // proposals routed to the requested sub-topic, biased toward
    // recency (PRD §Calibration batches: "calibration sampling is biased toward
    // fresh-but-validated history"). Rotation policy and adversary-
    // resistant distribution mixing are testbed territory; this is
    // the seam they tune against.
    //
    // Per the comment in tools.ts §ReviewBatchItem, the omissions
    // are deliberate: a reviewer comparing fields between calibration
    // items and live items shouldn't be able to use those fields to
    // distinguish them.
    fetchCalibrationBatch: async (
      caller: Caller,
      input: FetchCalibrationBatchInput,
    ): Promise<FetchCalibrationBatchOutput> => {
      const parsed = FetchCalibrationBatchInput.parse(input);
      resolveCaller(this.store, caller);
      const target = this.store.subTopics.get(parsed.sub_topic_id);
      if (!target) {
        throw new ServerError('not_found', `sub-topic not found: ${parsed.sub_topic_id}`);
      }
      const reviewerCounts =
        this.review.corpus_confirmation_depth_floor > 0 ? this.corpusReviewerCounts() : null;
      const candidates: Proposal[] = [];
      for (const p of this.store.proposals.values()) {
        if (p.status !== 'accepted') continue;
        const located = this.locateProposalForReview(p);
        if (!located || located.sub_topic_id !== parsed.sub_topic_id) continue;
        if (reviewerCounts && !this.passesCorpusDepthFloor(p, reviewerCounts)) continue;
        candidates.push(p);
      }
      // Recency-biased: sort by created_at descending. Tiebreak by id
      // for replay determinism. The testbed tunes the actual sampling
      // distribution; the recency bias is the published-default the
      // adversary harness should evaluate against.
      candidates.sort((a, b) => {
        if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at);
        return a.id.localeCompare(b.id);
      });
      const items: ReviewBatchItem[] = candidates
        .slice(0, CALIBRATION_BATCH_SIZE)
        .map((p) => ({ proposal_id: p.id, payload: p.payload }));
      return { items };
    },
  };

  // PRD §Read-path tools and resources: the *resources* surface (passive
  // browsing) — `cause://`, `sub-topic://{id}`, `node://{id}`,
  // `subgraph://{sub-topic-id}`. The MCP-side registration lives in
  // mcp.ts; these handlers compute the structured payload for each URI
  // out of current graph state, with the same Caller-resolution gating
  // as the read-path tools (token must resolve, no rate-limit budget
  // consumed). Sim≡prod by construction: testbed and production runtime
  // expose the same resources through the same transport.
  readonly resources = {
    // `cause://` — list of active causes, each with their active
    // sub-topics. The home-page payload: enough to render the cause
    // list and click into a cause without a second resource read.
    // Archived causes are excluded (the home view is a recruitment
    // surface); proposed/archived sub-topics are excluded for the
    // same reason (the home view shows contribution targets, not
    // queue state). Stable order (created_at, then id) keeps replay
    // determinism intact for testbed runs that observe this surface.
    getCauseDirectory: async (caller: Caller): Promise<CauseDirectory> => {
      resolveCaller(this.store, caller);
      const causes = [...this.store.causes.values()].filter((c) => c.status === 'active');
      causes.sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
        return a.id.localeCompare(b.id);
      });
      const out: CauseDirectory = {
        causes: causes.map((cause) => {
          const subTopics = [...this.store.subTopics.values()].filter(
            (st) => st.cause_id === cause.id && st.status === 'active',
          );
          subTopics.sort((a, b) => {
            if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
            return a.id.localeCompare(b.id);
          });
          return { cause, sub_topics: subTopics };
        }),
      };
      return out;
    },

    // `sub-topic://{id}` — sub-topic metadata, status, scope query,
    // recent activity. The activity counters are derived projections
    // — kept consistent with the graph by computation, not by
    // bookkeeping, the same way deriveFrontier is consistent with
    // proposals/edges. Resolves the sub-topic regardless of status:
    // a `proposed` sub-topic page is meaningful (it shows the
    // proposal under review), and `archived` sub-topics remain
    // browsable as graph history. The caller-side decision about
    // which statuses to surface lives at the UI.
    getSubTopicDetail: async (caller: Caller, subTopicId: SubTopicId): Promise<SubTopicDetail> => {
      resolveCaller(this.store, caller);
      const subTopic = this.store.subTopics.get(subTopicId);
      if (!subTopic) {
        throw new ServerError('not_found', `sub-topic not found: ${subTopicId}`);
      }
      const cause = this.store.causes.get(subTopic.cause_id);
      if (!cause) {
        throw new ServerError(
          'invalid_state',
          `sub-topic ${subTopicId} references missing cause ${subTopic.cause_id}`,
        );
      }
      let activeNodes = 0;
      for (const n of this.store.nodes.values()) {
        if (n.status !== 'active') continue;
        if (n.home_sub_topic_id === subTopicId || n.scope_memberships.includes(subTopicId)) {
          activeNodes += 1;
        }
      }
      let stagedProposals = 0;
      for (const p of this.store.proposals.values()) {
        if (p.status !== 'staged') continue;
        const located = this.locateProposalForReview(p);
        if (located && located.sub_topic_id === subTopicId) stagedProposals += 1;
      }
      const frontierItems = this.deriveFrontier({ sub_topic_id: subTopicId }).length;
      return {
        sub_topic: subTopic,
        cause,
        activity: {
          active_nodes: activeNodes,
          staged_proposals: stagedProposals,
          frontier_items: frontierItems,
        },
      };
    },

    // `node://{id}` — node + immediate active neighbors. "Immediate"
    // means one edge hop in either direction over the active edge
    // set, with the other endpoint of each edge hydrated. The
    // requested node is resolvable regardless of status (so a node
    // page can render rejected / unresolvable nodes); edges and
    // neighbors are restricted to `active` so the neighborhood view
    // is the convex-hull projection — staged/rejected edges live in
    // the proposal queue, visible via `query_proposals`. Stable
    // iteration order keeps cassette equality.
    getNodeNeighborhood: async (caller: Caller, nodeId: NodeId): Promise<NodeNeighborhood> => {
      resolveCaller(this.store, caller);
      const node = this.store.nodes.get(nodeId);
      if (!node) {
        throw new ServerError('not_found', `node not found: ${nodeId}`);
      }
      const edges: Edge[] = [];
      const neighborIds = new Set<NodeId>();
      for (const e of this.store.edges.values()) {
        if (e.status !== 'active') continue;
        if (e.from === nodeId) {
          edges.push(e);
          neighborIds.add(e.to);
        } else if (e.to === nodeId) {
          edges.push(e);
          neighborIds.add(e.from);
        }
      }
      edges.sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
        return a.id.localeCompare(b.id);
      });
      const neighbors: Node[] = [];
      for (const nid of neighborIds) {
        const n = this.store.nodes.get(nid);
        if (n) neighbors.push(n);
      }
      neighbors.sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
        return a.id.localeCompare(b.id);
      });
      return { node, edges, neighbors };
    },

    // `subgraph://{sub-topic-id}` — active subgraph scoped to the
    // sub-topic. Node set: active nodes whose home OR scope
    // memberships include the sub-topic (the scope-membership
    // projection is what makes a node visible outside its home).
    // Edge set: active edges with both endpoints in the node set.
    // Sub-topic itself is resolvable regardless of status (matching
    // getSubTopicDetail), but if the sub-topic doesn't exist this
    // refuses with `not_found` rather than returning an empty
    // subgraph — a request for a non-existent URI is a client error,
    // not a valid empty answer.
    getSubgraph: async (caller: Caller, subTopicId: SubTopicId): Promise<Subgraph> => {
      resolveCaller(this.store, caller);
      const subTopic = this.store.subTopics.get(subTopicId);
      if (!subTopic) {
        throw new ServerError('not_found', `sub-topic not found: ${subTopicId}`);
      }
      const nodes: Node[] = [];
      const nodeIds = new Set<NodeId>();
      for (const n of this.store.nodes.values()) {
        if (n.status !== 'active') continue;
        if (n.home_sub_topic_id === subTopicId || n.scope_memberships.includes(subTopicId)) {
          nodes.push(n);
          nodeIds.add(n.id);
        }
      }
      nodes.sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
        return a.id.localeCompare(b.id);
      });
      const edges: Edge[] = [];
      for (const e of this.store.edges.values()) {
        if (e.status !== 'active') continue;
        if (nodeIds.has(e.from) && nodeIds.has(e.to)) edges.push(e);
      }
      edges.sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
        return a.id.localeCompare(b.id);
      });
      return { sub_topic: subTopic, nodes, edges };
    },

    // `contributor://{id}` — anonymous-browse-safe contributor
    // projection. Returns a deliberately narrow `PublicContributor`
    // (id, display_name, created_at, status) and a per-(cause,
    // sub-topic) tier label for each rep entry. PRD §Reputation
    // ("Eligibility tiers public; numeric reputation private"): the
    // raw demonstrated/recent values are reserved for the
    // contributor's own `query_reputation` tool, where they inform
    // the contributor's reasoning about their own pool position.
    // The public projection here is the read-other-contributor
    // surface and is tier-only by construction.
    //
    // The contributor record is resolved regardless of status — a
    // revoked identity remains browsable as graph history (PRD
    // §Identity, Revocation: "past contributions remain in the
    // graph with the revocation flagged"). The page-side decision
    // about how to surface the `revoked` status lives at the UI.
    // Unknown identity ids refuse with `not_found` to match the
    // other resources' shape.
    //
    // Reputation entries are decayed-forward to the server's
    // current clock on read, matching `query_reputation` (PRD
    // §Reputation: "decay half-lives are applied on read at the
    // server layer"). The tier mapping itself uses the same
    // `assignment_min_*` review-config thresholds the gate at
    // `request_assignment` consumes, so the public tier and the
    // server-side pool-membership decision agree by construction.
    getContributorProfile: async (
      caller: Caller,
      identityId: IdentityId,
    ): Promise<ContributorProfile> => {
      resolveCaller(this.store, caller);
      const identity = this.store.identities.get(identityId);
      if (!identity) {
        throw new ServerError('not_found', `contributor not found: ${identityId}`);
      }
      const now = this.clock.now();
      const entries: PublicReputationEntry[] = [];
      for (const r of this.store.reputations.values()) {
        if (r.identity_id !== identity.id) continue;
        const decayed = this.decayedReputation(r, now);
        entries.push({
          cause_id: r.cause_id,
          sub_topic_id: r.sub_topic_id,
          tier: this.tierFor(decayed.demonstrated, decayed.recent),
        });
      }
      // Stable order: cause_id, then sub_topic_id alphabetical. Same
      // determinism rationale as the other resource projections —
      // testbed cassettes that observe this surface depend on
      // iteration-order stability.
      entries.sort((a, b) => {
        if (a.cause_id !== b.cause_id) return a.cause_id.localeCompare(b.cause_id);
        return a.sub_topic_id.localeCompare(b.sub_topic_id);
      });
      return {
        contributor: {
          id: identity.id,
          display_name: identity.display_name,
          created_at: identity.created_at,
          status: identity.status,
        },
        reputation: { entries },
      };
    },

    // `manuscript://{sub-topic-id}` — outline + cited claims + credited
    // contributors. PRD §Manuscript projection (slice 6a in
    // [ROADMAP §Phase 2](../../ROADMAP.md#phase-2)). The projection
    // walks the active sub-graph the sub-topic owns (same node set
    // `getSubgraph` returns: home OR scope-member, status='active'),
    // groups nodes by kind into four fixed sections, and computes
    // credit attribution from node provenance + accepted-aligned
    // review votes against the PRD §Credit shape — proposer at full
    // weight, reviewers (whose vote aligned with the converged
    // accept) at a smaller weight, both scaled by per-node survivor
    // and load-bearing factors. Specific weights are in `ReviewConfig`
    // and are testbed-tunable.
    //
    // The walk is deterministic by construction: sections appear in
    // fixed order, items within each section are sorted (anchors
    // and excerpts and open_questions by created_at then id;
    // syntheses by induced-subgraph derives degree descending, then
    // created_at), and contributors are sorted by units descending,
    // then display_name, then id. Cassette-replay equality through
    // this resource is therefore well-defined.
    //
    // Unknown sub-topic ids refuse `not_found` to match every other
    // resource in the family. Like `getSubgraph`, the sub-topic
    // itself is resolved regardless of status (a proposed-but-not-
    // yet-accepted or archived sub-topic remains a valid URI; the
    // projection just produces an empty result if no active nodes
    // exist).
    getManuscript: async (caller: Caller, subTopicId: SubTopicId): Promise<Manuscript> => {
      resolveCaller(this.store, caller);
      const subTopic = this.store.subTopics.get(subTopicId);
      if (!subTopic) {
        throw new ServerError('not_found', `sub-topic not found: ${subTopicId}`);
      }
      const cause = this.store.causes.get(subTopic.cause_id);
      if (!cause) {
        throw new ServerError(
          'invalid_state',
          `sub-topic ${subTopicId} references missing cause ${subTopic.cause_id}`,
        );
      }

      // Included node set: active nodes whose home OR scope memberships
      // include the sub-topic. Same scope rule as `getSubgraph` — the
      // convex-hull substrate is what the projection draws on.
      const includedNodes: Node[] = [];
      const includedNodeIds = new Set<NodeId>();
      for (const n of this.store.nodes.values()) {
        if (n.status !== 'active') continue;
        if (n.home_sub_topic_id === subTopicId || n.scope_memberships.includes(subTopicId)) {
          includedNodes.push(n);
          includedNodeIds.add(n.id);
        }
      }

      // Induced edge set: derives + supersedes edges whose endpoints
      // are both in the included set, restricted to `active` status.
      // The induced set is what scales the load-bearing factor —
      // edges out to nodes the projection doesn't include don't
      // count toward "load-bearing within this projection."
      const inducedDerivesByNode = new Map<NodeId, number>();
      const inducedSupersedesIntoNode = new Map<NodeId, number>();
      // derivesParentsByChild: child node id → parent node ids in the
      // included set, in created_at order; surfaced on syntheses /
      // open_questions so the chain-of-claim is visible in the
      // projection.
      const derivesParentsByChild = new Map<NodeId, NodeId[]>();
      const derivesEdgesByChild = new Map<NodeId, Edge[]>();
      for (const e of this.store.edges.values()) {
        if (e.status !== 'active') continue;
        if (!includedNodeIds.has(e.from) || !includedNodeIds.has(e.to)) continue;
        if (e.kind === 'derives') {
          inducedDerivesByNode.set(e.from, (inducedDerivesByNode.get(e.from) ?? 0) + 1);
          inducedDerivesByNode.set(e.to, (inducedDerivesByNode.get(e.to) ?? 0) + 1);
          const arr = derivesEdgesByChild.get(e.to) ?? [];
          arr.push(e);
          derivesEdgesByChild.set(e.to, arr);
        } else if (e.kind === 'supersedes') {
          // Survivor is the `to` endpoint (PRD §Edges: `supersedes`
          // is old → replacement).
          inducedSupersedesIntoNode.set(e.to, (inducedSupersedesIntoNode.get(e.to) ?? 0) + 1);
        }
      }
      for (const [child, edges] of derivesEdgesByChild) {
        edges.sort((a, b) => {
          if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
          return a.id.localeCompare(b.id);
        });
        derivesParentsByChild.set(
          child,
          edges.map((e) => e.from),
        );
      }

      // Per-node credit multiplier — combines the survivor and load-
      // bearing factors so the proposer/reviewer base weights scale
      // together. A peripheral leaf with no supersedes events keeps
      // a 1.0 multiplier; the more induced edges and surviving
      // predecessors a node has, the more its contribution counts.
      const multiplierForNode = (nodeId: NodeId): number => {
        const survivors = inducedSupersedesIntoNode.get(nodeId) ?? 0;
        const induced = inducedDerivesByNode.get(nodeId) ?? 0;
        return (
          1 +
          survivors * this.review.credit_survivor_bonus_per_supersede +
          induced * this.review.credit_load_bonus_per_induced_derives
        );
      };

      // Section walk. Order is fixed (sources → quotations →
      // synthesis → open_questions); within each section the
      // iteration order is deterministic (created_at, then id) for
      // anchors, excerpts, and open_questions. Syntheses sort by
      // induced-subgraph derives degree descending (the load-bearing
      // signal made visible in the outline ordering), then by
      // created_at for ties.
      const byKind = {
        anchor: [] as AnchorNode[],
        excerpt: [] as ExcerptNode[],
        synthesis: [] as SynthesisNode[],
        open_question: [] as OpenQuestionNode[],
      };
      for (const n of includedNodes) {
        if (n.kind === 'anchor') byKind.anchor.push(n);
        else if (n.kind === 'excerpt') byKind.excerpt.push(n);
        else if (n.kind === 'synthesis') byKind.synthesis.push(n);
        else if (n.kind === 'open_question') byKind.open_question.push(n);
      }
      const byCreatedAtThenId = (a: Node, b: Node): number => {
        if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
        return a.id.localeCompare(b.id);
      };
      byKind.anchor.sort(byCreatedAtThenId);
      byKind.excerpt.sort(byCreatedAtThenId);
      byKind.open_question.sort(byCreatedAtThenId);
      byKind.synthesis.sort((a, b) => {
        const da = inducedDerivesByNode.get(a.id) ?? 0;
        const db = inducedDerivesByNode.get(b.id) ?? 0;
        if (da !== db) return db - da;
        return byCreatedAtThenId(a, b);
      });

      const toCitation = (n: Node): ManuscriptCitation => {
        const parents = derivesParentsByChild.get(n.id) ?? [];
        if (n.kind === 'anchor') {
          return {
            node_id: n.id,
            kind: 'anchor',
            content: n.content,
            external_ref: n.external_ref,
            content_hash: n.content_hash,
            parent_node_ids: parents,
            proposer_id: n.created_by,
          };
        }
        if (n.kind === 'excerpt') {
          return {
            node_id: n.id,
            kind: 'excerpt',
            content: n.content,
            quoted_span: n.quoted_span,
            parent_node_ids: parents,
            proposer_id: n.created_by,
          };
        }
        return {
          node_id: n.id,
          kind: n.kind,
          content: n.content,
          parent_node_ids: parents,
          proposer_id: n.created_by,
        };
      };

      const sections: ManuscriptSection[] = [
        { kind: 'sources', title: 'Sources', items: byKind.anchor.map(toCitation) },
        { kind: 'quotations', title: 'Quotations', items: byKind.excerpt.map(toCitation) },
        { kind: 'synthesis', title: 'Synthesis', items: byKind.synthesis.map(toCitation) },
        {
          kind: 'open_questions',
          title: 'Open questions',
          items: byKind.open_question.map(toCitation),
        },
      ];

      // Credit attribution. For each included node, the proposer
      // accrues `credit_proposer_weight * multiplier`; reviewers who
      // voted `accept` on the proposal that materialized the node
      // accrue `credit_reviewer_weight * multiplier`. Locating the
      // materializing proposal: nodes carry a `created_by` +
      // `created_at`, and the proposal whose acceptance produced the
      // node is the one whose `materialized_node_id` (if persisted)
      // matches — but we don't persist that link. Instead, we index
      // accepted proposals by their fulfillment-time node payload:
      // (proposer_id, payload kind, content) is sufficient to match
      // the node back to its proposal under the v0 schema where
      // every accepted node-creating proposal materializes exactly
      // one node, and `(proposer_id, content)` is unique per
      // proposal (the proposer can't propose two anchors with
      // identical content/external_ref payload — the verifier
      // rejects the duplicate at the tool boundary). Cleaner-but-
      // heavier alternatives (persisting `proposal_id` on `Node`)
      // are deferred to the slice-7 operational tooling pass.
      const proposalsByMaterializedNodeId = new Map<NodeId, Proposal>();
      // Inverted index: (proposer_id, kind, content) → accepted
      // proposal. Sufficient under v0's no-duplicate-content
      // invariant at the tool boundary (the verifier rejects a
      // duplicate excerpt/anchor at write time).
      const proposalByContentKey = new Map<string, Proposal>();
      for (const p of this.store.proposals.values()) {
        if (p.status !== 'accepted') continue;
        const k = p.payload.kind;
        if (k !== 'anchor' && k !== 'excerpt' && k !== 'synthesis' && k !== 'open_question') {
          continue;
        }
        const key = `${p.proposer_id}|${k}|${p.payload.content}`;
        proposalByContentKey.set(key, p);
      }
      const proposalForNode = (n: Node): Proposal | undefined => {
        return proposalByContentKey.get(`${n.created_by}|${n.kind}|${n.content}`);
      };
      // Cache the linkage so the survivor / load lookup and the
      // contributor walk share a single resolution.
      for (const n of includedNodes) {
        const p = proposalForNode(n);
        if (p) proposalsByMaterializedNodeId.set(n.id, p);
      }

      const creditByContributor = new Map<
        IdentityId,
        { units: number; proposed: Set<NodeId>; reviewed: Set<NodeId> }
      >();
      const accrue = (id: IdentityId, units: number, nodeId: NodeId, role: 'p' | 'r'): void => {
        let entry = creditByContributor.get(id);
        if (!entry) {
          entry = { units: 0, proposed: new Set(), reviewed: new Set() };
          creditByContributor.set(id, entry);
        }
        entry.units += units;
        if (role === 'p') entry.proposed.add(nodeId);
        else entry.reviewed.add(nodeId);
      };

      for (const n of includedNodes) {
        const mult = multiplierForNode(n.id);
        accrue(n.created_by, this.review.credit_proposer_weight * mult, n.id, 'p');
        const proposal = proposalsByMaterializedNodeId.get(n.id);
        if (!proposal) continue;
        // Reviewer credit: any vote with `decision === 'accept'` on
        // the materializing proposal aligns with the converged
        // outcome (the node is in the included set, which is
        // active-only — so the proposal's terminal state is
        // accepted). Self-votes by the proposer (which the review
        // pipeline already filters at assignment time) are skipped
        // here as a defense-in-depth.
        const reviewerSeen = new Set<IdentityId>();
        for (const v of this.store.reviewVotes.values()) {
          if (v.proposal_id !== proposal.id) continue;
          if (v.decision !== 'accept') continue;
          if (v.reviewer_id === proposal.proposer_id) continue;
          if (reviewerSeen.has(v.reviewer_id)) continue;
          reviewerSeen.add(v.reviewer_id);
          accrue(v.reviewer_id, this.review.credit_reviewer_weight * mult, n.id, 'r');
        }
      }

      const contributors: CreditAttribution[] = [];
      for (const [identityId, entry] of creditByContributor) {
        const identity = this.store.identities.get(identityId);
        if (!identity) continue;
        contributors.push({
          contributor_id: identityId,
          display_name: identity.display_name,
          status: identity.status,
          units: entry.units,
          proposed_node_count: entry.proposed.size,
          reviewed_node_count: entry.reviewed.size,
        });
      }
      contributors.sort((a, b) => {
        if (a.units !== b.units) return b.units - a.units;
        if (a.display_name !== b.display_name) return a.display_name.localeCompare(b.display_name);
        return a.contributor_id.localeCompare(b.contributor_id);
      });

      return { sub_topic: subTopic, cause, sections, contributors };
    },

    // ── Curator-only read projections (slice 7b) ────────────────────
    // The web tier's curator console (PRD §Curator console) reads
    // through these. Each re-resolves the caller from the store on
    // every call (so a mid-flight identity revocation lands on the
    // next page load without a restart) and asserts the resolved
    // identity's role is `'curator'`, refusing with the typed
    // `permission_denied` code otherwise — the same wire-level role
    // gate `wrapCurator` (slice 7a) uses for the curator MCP tools,
    // re-applied at the read-projection seam so the web tier and
    // the MCP tool path use the same authorization.
    //
    // The projections delegate to `server.curator.*` (the in-process
    // namespace 7a's MCP tools already wrap), so the read-data
    // semantics are byte-identical to the MCP curator-tool path —
    // the web console and a curator-as-agent using `curator_*` tools
    // observe the same numbers by construction. Operational privacy
    // (decline-rate thresholds, cluster-signal floors) stays where
    // the in-process namespace puts it.

    // Moderation queue: every `staged` proposal, the curator's
    // work surface. Filterable by cause so the curator working a
    // specific cause does not have to wade through cross-cause
    // backlog. Sub-topic-level filtering is not exposed here in v0
    // — staged proposals route to reviewers by sub-topic at
    // assignment time; the curator's queue is one level up.
    getCuratorQueue: async (
      caller: Caller,
      options?: { cause_id?: CauseId },
    ): Promise<{ proposals: Proposal[] }> => {
      this.requireCurator(caller);
      const filterCause = options?.cause_id;
      const proposals: Proposal[] = [];
      for (const proposal of this.store.proposals.values()) {
        if (proposal.status !== 'staged') continue;
        if (filterCause !== undefined) {
          const route = this.locateProposalForReview(proposal);
          if (!route || route.cause_id !== filterCause) continue;
        }
        proposals.push(proposal);
      }
      // Oldest first — the queue is a backlog, and the curator works
      // the long-stale items first by convention.
      proposals.sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
        return a.id.localeCompare(b.id);
      });
      return { proposals };
    },

    // Cross-cause identity-clustering projection. Delegates to the
    // in-process curator namespace, the single computation path.
    getCuratorIdentityClusters: async (
      caller: Caller,
      options?: { window_seconds?: number; min_signal?: number },
    ): Promise<{
      pairs: Array<{
        identity_a: IdentityId;
        identity_b: IdentityId;
        cross_cause_count: number;
        shared_proposal_count: number;
      }>;
    }> => {
      this.requireCurator(caller);
      const inner: { window_seconds?: number; min_signal?: number } = {};
      if (options?.window_seconds !== undefined) inner.window_seconds = options.window_seconds;
      if (options?.min_signal !== undefined) inner.min_signal = options.min_signal;
      const pairs = this.curator.identityClusters(inner);
      return { pairs };
    },

    // Curator-side surface for anchors flagged by the re-verification
    // scheduler (slice 7c). Lists every `unresolvable` anchor with the
    // fields a human reviewer needs to decide what to do next:
    // - the external_ref that drifted (so the curator can manually
    //   check the source),
    // - the stored content_hash (so a contributor proposing a
    //   supersedes can show "this anchor's hash diverged from what's
    //   live today"),
    // - last_verified_at, the timestamp the source was last known
    //   good (the curator reads "drifted after N days unchecked" off
    //   the gap to updated_at),
    // - updated_at, which the unresolvable flip wrote and which the
    //   curator surfaces as "drift detected at".
    // Sorted by updated_at descending (most recently flagged first) —
    // the curator's frontmost question is "what just broke," not
    // "what's been broken longest." cause_id filters to a single
    // cause; absence returns all causes. PRD §Verification engine
    // (Re-verification) commits this projection as the curator-side
    // surface for flagged anchors.
    getCuratorUnresolvableAnchors: async (
      caller: Caller,
      options?: { cause_id?: CauseId },
    ): Promise<{
      anchors: Array<{
        anchor_id: NodeId;
        home_sub_topic_id: SubTopicId;
        cause_id: CauseId;
        external_ref: AnchorNode['external_ref'];
        content_hash: string;
        last_verified_at: Timestamp;
        updated_at: Timestamp;
      }>;
    }> => {
      this.requireCurator(caller);
      const out: Array<{
        anchor_id: NodeId;
        home_sub_topic_id: SubTopicId;
        cause_id: CauseId;
        external_ref: AnchorNode['external_ref'];
        content_hash: string;
        last_verified_at: Timestamp;
        updated_at: Timestamp;
      }> = [];
      for (const n of this.store.nodes.values()) {
        if (n.kind !== 'anchor') continue;
        if (n.status !== 'unresolvable') continue;
        const subTopic = this.store.subTopics.get(n.home_sub_topic_id);
        if (!subTopic) continue;
        if (options?.cause_id !== undefined && subTopic.cause_id !== options.cause_id) continue;
        out.push({
          anchor_id: n.id,
          home_sub_topic_id: n.home_sub_topic_id,
          cause_id: subTopic.cause_id,
          external_ref: n.external_ref,
          content_hash: n.content_hash,
          last_verified_at: n.last_verified_at,
          updated_at: n.updated_at,
        });
      }
      out.sort((a, b) => {
        if (a.updated_at !== b.updated_at) return b.updated_at.localeCompare(a.updated_at);
        return a.anchor_id.localeCompare(b.anchor_id);
      });
      return { anchors: out };
    },
  };

  // Helper for the curator-only read projections (slice 7b). Re-
  // resolves the caller through the store (revocation honored mid-
  // flight) and asserts curator role; refuses with the typed
  // `permission_denied` code otherwise, matching the wire-level
  // gate `wrapCurator` enforces at the MCP layer for slice 7a's
  // curator tools.
  private requireCurator(caller: Caller): void {
    const { identity } = resolveCaller(this.store, caller);
    if (identity.role !== 'curator') {
      throw new ServerError(
        'permission_denied',
        `curator role required (caller role is ${identity.role})`,
      );
    }
  }

  // Tier mapping for the public contributor projection (PRD
  // §Reputation). The three v0 tiers are derived from the per-(cause,
  // sub-topic) decayed (demonstrated, recent) against the same
  // `assignment_min_*` review-config thresholds the gate at
  // `request_assignment` consumes — by construction, the public tier
  // and the server-side pool-membership decision agree. The mapping
  // uses *only* the entry's own components (not the per-cause
  // maximum the assignment gate computes across all sub-topics), so
  // tiers reflect "this contributor's position *in this specific
  // sub-topic*" rather than "this contributor's position in this
  // cause as a whole." That matches PRD §Reputation's
  // anchored-at-cause-refined-by-sub-topic framing — and matters
  // because the sub-topic-level tier is what a reader of the
  // contributor's profile actually cares about: "what does this
  // person's track record in *ctDNA-MRD* look like?"
  private tierFor(demonstrated: number, recent: number): PublicReputationTier {
    if (demonstrated < this.review.assignment_min_demonstrated) return 'none';
    if (recent < this.review.assignment_min_recent) return 'quiet';
    return 'contributing';
  }

  readonly curator = {
    // Curator-mediated acceptance. The review loop is wired
    // (assignment-driven sampling at request_assignment, vote tallying
    // through cast_review_vote, convergence resolution in
    // resolveByConvergence), so contested proposals advance through
    // the review path. This curator entry point persists for two
    // reasons: (1) it is the curator-escalation path described in PRD
    // §Reviewer assignment (step 4: curator escalation) for proposals
    // the review loop cannot resolve (small pools, stale divergences
    // routed here); (2) curator-only proposal kinds (sub_topic,
    // change_of_home) and the testbed's scenario setup go through
    // this seam directly rather than through the review loop. The
    // result includes whichever id the proposal materialized: a
    // node_id for graph-creating kinds, a sub_topic_id for sub_topic
    // kind, or neither for in-place mutations (membership, supersedes,
    // change_of_home).
    acceptProposal: (proposalId: ProposalId): { node_id?: NodeId; sub_topic_id?: SubTopicId } => {
      const proposal = this.store.proposals.get(proposalId);
      if (!proposal) {
        throw new ServerError('not_found', `proposal not found: ${proposalId}`);
      }
      if (proposal.status !== 'staged') {
        throw new ServerError(
          'invalid_state',
          `cannot accept proposal in status ${proposal.status}`,
        );
      }
      return this.acceptStaged(proposal);
    },

    // The reject side of the curator-escalation path `acceptProposal`
    // documents (PRD §Reviewer assignment step 4): when the review
    // loop can't resolve a divergent proposal — a 1-1 split with no
    // tiebreaker in a small pool, a stalled contested item — the
    // curator can resolve it either way, not only upward. Since no
    // node was ever materialized for a staged proposal, rejecting it
    // is just the status transition (parallel to the reject branch of
    // `resolveByConvergence`); there is nothing to unwind. Like
    // `acceptProposal`, this is a curator override and stays rep-
    // neutral — a curator tiebreak is not the peer agreement the
    // convergence path's reputation deltas are calibrated against, and
    // folding curator overrides into the rep ledger would let a curator
    // move reputation by fiat. Only staged proposals are resolvable;
    // `change_of_home`-style in-place kinds resolve through their own
    // curator seams, not here.
    rejectProposal: (proposalId: ProposalId): void => {
      const proposal = this.store.proposals.get(proposalId);
      if (!proposal) {
        throw new ServerError('not_found', `proposal not found: ${proposalId}`);
      }
      if (proposal.status !== 'staged') {
        throw new ServerError(
          'invalid_state',
          `cannot reject proposal in status ${proposal.status}`,
        );
      }
      this.store.proposals.set(proposal.id, {
        ...proposal,
        status: 'rejected',
        updated_at: this.clock.now(),
      });
    },

    // Cross-cause identity-clustering projection (PRD §Identity
    // bullet 4) — the fourth of the four sybil-resistance layers.
    // Surfaces identity pairs whose behavioral fingerprint *across
    // causes* suggests coordination: per-(reviewer pair) count of
    // distinct causes where both reviewers cast votes on the same
    // proposal. Honest reviewers typically work in one cause
    // (per-cause reputation; PRD §Reputation), so a pair appearing
    // on shared proposals across multiple causes is a behavioral
    // fingerprint a sybil farm working multiple causes lights up
    // and a single-cause coalition does not. The signal is *global
    // per identity* (the asymmetry to per-cause reputation that
    // PRD §Identity names by intent) — clustering computation walks
    // every cause's votes uniformly.
    //
    // Two metrics surface per pair so the curator has visibility
    // into what's driving the score:
    //   - cross_cause_count: distinct causes both reviewers voted
    //     in on shared proposals. The headline signal.
    //   - shared_proposal_count: total proposals both voted on. A
    //     pair with high cross_cause_count and low shared_proposal_
    //     count (one shared proposal per cause) reads differently
    //     from one with high shared_proposal_count concentrated in
    //     a few causes — both shapes are interesting, the curator
    //     decides what's a coalition vs coincidence.
    //
    // `min_signal` defaults to 2 (cross-cause coordination requires
    // at least 2 causes to be a cross-cause signal); `window_seconds`
    // is the rolling window over vote `created_at`, undefined or
    // Infinity means all-time. Specific signals and thresholds
    // remain operationally private at the production instance per
    // PRD §Identity bullet 4 ("operationally private"): methodology
    // is public, tuning is not.
    identityClusters: (options?: {
      window_seconds?: number;
      min_signal?: number;
    }): Array<{
      identity_a: IdentityId;
      identity_b: IdentityId;
      cross_cause_count: number;
      shared_proposal_count: number;
    }> => {
      const minSignal = options?.min_signal ?? 2;
      const windowSeconds = options?.window_seconds;
      const cutoffMs =
        windowSeconds !== undefined && Number.isFinite(windowSeconds)
          ? new Date(this.clock.now()).getTime() - windowSeconds * 1000
          : Number.NEGATIVE_INFINITY;
      // Per-proposal: which reviewers voted, and the proposal's cause.
      const perProposal = new Map<ProposalId, { reviewers: IdentityId[]; cause_id: CauseId }>();
      for (const v of this.store.reviewVotes.values()) {
        if (new Date(v.created_at).getTime() < cutoffMs) continue;
        const p = this.store.proposals.get(v.proposal_id);
        if (!p) continue;
        const located = this.locateProposalForReview(p);
        if (!located) continue;
        let entry = perProposal.get(p.id);
        if (!entry) {
          entry = { reviewers: [], cause_id: located.cause_id };
          perProposal.set(p.id, entry);
        }
        if (!entry.reviewers.includes(v.reviewer_id)) {
          entry.reviewers.push(v.reviewer_id);
        }
      }
      // Per-pair accumulator. Pair key is sorted-id tuple so (a,b)
      // and (b,a) collapse.
      const perPair = new Map<
        string,
        {
          a: IdentityId;
          b: IdentityId;
          causes: Set<CauseId>;
          proposals: Set<ProposalId>;
        }
      >();
      for (const [proposalId, { reviewers, cause_id }] of perProposal) {
        if (reviewers.length < 2) continue;
        const sorted = [...reviewers].sort();
        for (let i = 0; i < sorted.length; i++) {
          const a = sorted[i];
          if (a === undefined) continue;
          for (let j = i + 1; j < sorted.length; j++) {
            const b = sorted[j];
            if (b === undefined) continue;
            const key = `${a}|${b}`;
            const existing = perPair.get(key);
            const entry = existing ?? { a, b, causes: new Set(), proposals: new Set() };
            if (!existing) perPair.set(key, entry);
            entry.causes.add(cause_id);
            entry.proposals.add(proposalId);
          }
        }
      }
      const result: Array<{
        identity_a: IdentityId;
        identity_b: IdentityId;
        cross_cause_count: number;
        shared_proposal_count: number;
      }> = [];
      for (const { a, b, causes, proposals } of perPair.values()) {
        if (causes.size < minSignal) continue;
        result.push({
          identity_a: a,
          identity_b: b,
          cross_cause_count: causes.size,
          shared_proposal_count: proposals.size,
        });
      }
      // Stable sort: cross_cause_count desc, then shared_proposal_count
      // desc, then identity_a asc, then identity_b asc as tiebreakers.
      result.sort((x, y) => {
        if (y.cross_cause_count !== x.cross_cause_count) {
          return y.cross_cause_count - x.cross_cause_count;
        }
        if (y.shared_proposal_count !== x.shared_proposal_count) {
          return y.shared_proposal_count - x.shared_proposal_count;
        }
        if (x.identity_a !== y.identity_a) {
          return x.identity_a < y.identity_a ? -1 : 1;
        }
        return x.identity_b < y.identity_b ? -1 : x.identity_b > y.identity_b ? 1 : 0;
      });
      return result;
    },

    // Divergence-closure sweep (PRD §Reviewer assignment: "divergences
    // without further evidence within a tunable window are archived
    // (status `unresolved-archived`) rather than perpetually re-
    // routed"). The contracts already commit `unresolved-archived` as
    // a terminal proposal status; this is the path that produces it.
    //
    // A staged proposal is *archivable* when:
    //   1. It has at least one cast vote (a never-reviewed proposal
    //      isn't divergent — it's just unstarted, and stays staged
    //      pending assignment).
    //   2. Its most recent vote is older than `window_seconds`. The
    //      proposal's own created_at is not the right anchor —
    //      activity (votes) is what indicates whether the proposal
    //      is actively being worked.
    //
    // Curator-triggered, not automatic: production likely runs this
    // on a scheduler, but the trigger is operationally private and
    // testbed-tunable. Returns the archived proposal_ids so callers
    // can audit. cause_id is an optional filter — the typical sweep
    // is per-cause, but sweeping the whole instance is allowed.
    archiveStaleProposals: (options: {
      window_seconds: number;
      cause_id?: CauseId;
    }): ProposalId[] => {
      if (options.window_seconds <= 0) return [];
      const now = this.clock.now();
      const cutoffMs = Date.parse(now) - options.window_seconds * 1000;
      // Latest vote timestamp per proposal. We iterate votes once and
      // track the max created_at; cheap for v0 testbed sizes.
      const latestVoteAt = new Map<ProposalId, number>();
      for (const v of this.store.reviewVotes.values()) {
        const ts = Date.parse(v.created_at);
        const prior = latestVoteAt.get(v.proposal_id);
        if (prior === undefined || ts > prior) latestVoteAt.set(v.proposal_id, ts);
      }
      const archived: ProposalId[] = [];
      for (const proposal of this.store.proposals.values()) {
        if (proposal.status !== 'staged') continue;
        const latest = latestVoteAt.get(proposal.id);
        if (latest === undefined) continue; // unstarted: not divergent
        if (latest > cutoffMs) continue; // recent activity: not stale
        if (options.cause_id !== undefined) {
          const route = this.locateProposalForReview(proposal);
          if (!route || route.cause_id !== options.cause_id) continue;
        }
        this.store.proposals.set(proposal.id, {
          ...proposal,
          status: 'unresolved-archived',
          updated_at: now,
        });
        archived.push(proposal.id);
      }
      return archived;
    },

    // PRD §Sub-topic creation: "Curator accepts as `active`, defers as
    // `proposed`, or rejects." This is the deferral path — the curator
    // has decided to record the sub-topic but hold off on activation
    // pending more evidence (corpus density, articulable scope
    // envelope, real audience). The SubTopic is materialized with
    // status `proposed`; a future curator action flips it to `active`
    // without going through the proposal system again. The proposal
    // itself is marked accepted because the curator has resolved it —
    // `proposed` is a SubTopic state, not a Proposal state. Only
    // sub_topic-kind proposals are deferrable.
    deferSubTopic: (proposalId: ProposalId): { sub_topic_id: SubTopicId } => {
      const proposal = this.store.proposals.get(proposalId);
      if (!proposal) {
        throw new ServerError('not_found', `proposal not found: ${proposalId}`);
      }
      if (proposal.status !== 'staged') {
        throw new ServerError(
          'invalid_state',
          `cannot defer proposal in status ${proposal.status}`,
        );
      }
      if (proposal.payload.kind !== 'sub_topic') {
        throw new ServerError(
          'invalid_input',
          `deferSubTopic only applies to sub_topic proposals (got ${proposal.payload.kind})`,
        );
      }
      const result = this.materialize(proposal, 'proposed');
      const now = this.clock.now();
      this.store.proposals.set(proposal.id, { ...proposal, status: 'accepted', updated_at: now });
      this.applyMaterialization(result);
      const created = result.subTopicCreates[0];
      if (!created) {
        // Defensive: the sub_topic materialization branch must have
        // produced exactly one SubTopic.
        throw new ServerError('invalid_state', 'sub_topic deferral did not materialize a SubTopic');
      }
      return { sub_topic_id: created.id };
    },

    // Flip an identity to `revoked`. PRD §Identity (Roles, revocation
    // cascade): the revoked identity stays browsable as graph history
    // (the curator-side projections still surface its prior activity)
    // but loses write access — `resolveCaller` rejects further tool
    // invocations at the Authenticator seam (`unauthorized`,
    // status !== 'active'), and the per-(cause, sub-topic) reputation
    // ledger continues to read the existing entries without accruing
    // new ones. Idempotent: re-revoking is a no-op rather than an
    // error (the operator running a runbook twice should not be
    // surprised; matches the `revoke-identity` admin-CLI subcommand,
    // which delegates here as of slice 7a).
    revokeIdentity: (
      identityId: IdentityId,
    ): { identity_id: IdentityId; status: PrincipalStatus; changed: boolean } => {
      const identity = this.store.identities.get(identityId);
      if (!identity) {
        throw new ServerError('not_found', `identity not found: ${identityId}`);
      }
      if (identity.status === 'revoked') {
        return { identity_id: identity.id, status: 'revoked', changed: false };
      }
      this.store.identities.set(identity.id, { ...identity, status: 'revoked' });
      return { identity_id: identity.id, status: 'revoked', changed: true };
    },

    // Re-verify a single active anchor against its live source (PRD
    // §Verification engine, Re-verification). Re-fetches `external_ref`
    // through the configured verifier, compares the fresh content hash
    // against the stored one, and either bumps `last_verified_at`
    // (still resolves; "known good as of now") or transitions the anchor
    // to `unresolvable` (drift detected, or the verifier itself refused
    // — retraction, host gone, network unreachable; the verifier
    // conflates the three by design, see `LiveFetchVerifier.fetchPmid`).
    // `unresolvable` is terminal for this anchor: the lineage continues
    // via a `propose_supersedes` from a contributor proposing a fresh
    // external_ref pointing at the same claim. Re-verify only operates
    // on `active`; `staged` anchors are not yet load-bearing (their
    // initial verification is still pending in the proposal flow) and
    // `superseded`/`rejected`/`unresolvable` are out of the
    // re-verification loop by definition.
    reverifyAnchor: async (
      anchorId: NodeId,
    ): Promise<{
      anchor_id: NodeId;
      outcome: 'unchanged' | 'unresolvable';
      content_hash: string;
      last_verified_at: Timestamp;
    }> => {
      const node = this.store.nodes.get(anchorId);
      if (!node) {
        throw new ServerError('not_found', `anchor not found: ${anchorId}`);
      }
      if (node.kind !== 'anchor') {
        throw new ServerError(
          'invalid_input',
          `re-verification applies to anchors only (got ${node.kind})`,
        );
      }
      if (node.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `re-verification requires status 'active' (got ${node.status})`,
        );
      }
      const now = this.clock.now();
      try {
        const fresh = await this.verifier.verifyExternalRef(node.external_ref);
        if (fresh.content_hash === node.content_hash) {
          // Hash match: source still resolves to the same content.
          // Bump last_verified_at; updated_at stays put (the persisted
          // record is unchanged in every observable way except the
          // freshness timestamp, but `updated_at` semantically tracks
          // user-meaningful changes — drift, supersedes — not
          // background verification heartbeats, and bumping it would
          // muddy the assignment-expiry and proposal-stale logic that
          // keys off it).
          const updated: AnchorNode = { ...node, last_verified_at: now };
          this.store.nodes.set(node.id, updated);
          return {
            anchor_id: node.id,
            outcome: 'unchanged',
            content_hash: node.content_hash,
            last_verified_at: now,
          };
        }
        // Hash mismatch: confirmed drift.
      } catch (err) {
        // Verifier threw: retraction, host gone, transient network
        // failure — indistinguishable at the verifier seam (see comment
        // above and `LiveFetchVerifier.fetchPmid`). v0 collapses all
        // three to "unresolvable" rather than persisting a transient
        // hiccup as a different state; the operator's recovery path
        // is the same in every case (curator surfaces flagged anchors;
        // contributors propose supersedes with a fresh external_ref).
        // Non-ServerError throws are rethrown — schema/zod failures
        // and Server programming errors should not silently flip
        // anchors. Same posture as `accountWriteAction`'s rate-limit
        // surface: only typed verifier rejections are re-verification
        // failures.
        if (!(err instanceof ServerError)) throw err;
      }
      // Flip to unresolvable. last_verified_at is *not* bumped — it
      // continues to record when the source was last known good, which
      // is the meaningful timestamp for the curator surface ("drifted
      // after N days unchecked"). updated_at *is* bumped: the flip is
      // a meaningful state change, surfaced through the frontier
      // (`unresolvable_anchor`) and the curator projection.
      const updated: AnchorNode = { ...node, status: 'unresolvable', updated_at: now };
      this.store.nodes.set(node.id, updated);
      return {
        anchor_id: node.id,
        outcome: 'unresolvable',
        content_hash: node.content_hash,
        last_verified_at: node.last_verified_at,
      };
    },

    // Batch re-verification: pick `active` anchors whose
    // `last_verified_at` is older than the threshold, oldest first, up
    // to `batch_size`, and re-verify each in turn. This is the
    // primitive the production scheduler ticks against (slice 7c part
    // 2) and the operator can also drive on-demand through
    // `curator_reverify_anchors`. Oldest-first ordering ensures every
    // anchor gets a turn even when the backlog exceeds a single
    // batch's capacity. `cause_id` is an optional per-cause filter for
    // operators running per-cause sweeps; absence means all causes.
    //
    // Empty batches are a normal result (everything's fresh), not an
    // error. A drift inside the batch does not abort the batch — each
    // anchor is independent and the curator wants the full sweep.
    reverifyDueAnchors: async (options: {
      batch_size: number;
      max_age_ms: number;
      cause_id?: CauseId;
    }): Promise<{
      checked: number;
      unchanged: number;
      unresolvable: number;
      anchors: Array<{
        anchor_id: NodeId;
        outcome: 'unchanged' | 'unresolvable';
      }>;
    }> => {
      if (options.batch_size <= 0) {
        return { checked: 0, unchanged: 0, unresolvable: 0, anchors: [] };
      }
      const now = this.clock.now();
      const cutoffMs = Date.parse(now) - options.max_age_ms;
      // Collect eligible anchors. Per-cause filtering walks the home
      // sub-topic → cause map; v0 corpus sizes make full-scan cheap.
      const eligible: AnchorNode[] = [];
      for (const n of this.store.nodes.values()) {
        if (n.kind !== 'anchor') continue;
        if (n.status !== 'active') continue;
        if (Date.parse(n.last_verified_at) > cutoffMs) continue;
        if (options.cause_id !== undefined) {
          const subTopic = this.store.subTopics.get(n.home_sub_topic_id);
          if (!subTopic || subTopic.cause_id !== options.cause_id) continue;
        }
        eligible.push(n);
      }
      // Oldest first, deterministic tiebreak by id.
      eligible.sort((a, b) => {
        if (a.last_verified_at !== b.last_verified_at) {
          return a.last_verified_at.localeCompare(b.last_verified_at);
        }
        return a.id.localeCompare(b.id);
      });
      const batch = eligible.slice(0, options.batch_size);
      const anchors: Array<{ anchor_id: NodeId; outcome: 'unchanged' | 'unresolvable' }> = [];
      let unchanged = 0;
      let unresolvable = 0;
      for (const anchor of batch) {
        const result = await this.curator.reverifyAnchor(anchor.id);
        anchors.push({ anchor_id: result.anchor_id, outcome: result.outcome });
        if (result.outcome === 'unchanged') unchanged += 1;
        else unresolvable += 1;
      }
      return { checked: anchors.length, unchanged, unresolvable, anchors };
    },
  };

  // Promote a staged proposal to accepted: materialize, persist the
  // status flip, and apply the materialization. Shared between the
  // curator's manual path (curator.acceptProposal) and the auto-
  // convergence path that fires after enough accept-votes accumulate
  // (PRD §The contribution flow (Resolve step): convergent vote merges).
  private acceptStaged(proposal: Proposal): { node_id?: NodeId; sub_topic_id?: SubTopicId } {
    const result = this.materialize(proposal, 'active');
    const now = this.clock.now();
    this.store.proposals.set(proposal.id, { ...proposal, status: 'accepted', updated_at: now });
    this.applyMaterialization(result);
    if (result.node) return { node_id: result.node.id };
    const created = result.subTopicCreates[0];
    if (created) return { sub_topic_id: created.id };
    return {};
  }

  // After a review vote lands, check whether the proposal has reached
  // either convergence threshold and resolve it if so. PRD §The contribution flow (Resolve step):
  // convergent vote merges; divergent vote routes to a richer path.
  // The richer-path branch — more reviewers / curator escalation /
  // open_question carry-forward — isn't implemented in v0; this is
  // the "convergent merges" half, with the divergence-closure sweep
  // (`server.curator.archiveStaleProposals`) handling the unresolved
  // divergence side at the configured window (PRD §Reviewer
  // assignment "Divergence has a closure mechanism", ROADMAP
  // §Status). `revise` votes are counted toward neither threshold
  // (revise is "needs work, not yet"); they remain available as a
  // signal for future divergence resolution.
  //
  // Some proposal kinds are curator-only (sub_topic, change_of_home
  // per PRD §Write-path tools (propose_change_of_home) and §Sub-topic creation) and are excluded from auto-resolution
  // even if votes accumulate against them — the votes can still be
  // recorded as a signal for the curator, but they don't move the
  // proposal's status.
  private resolveByConvergence(proposalId: ProposalId): void {
    const proposal = this.store.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'staged') return;
    if (proposal.payload.kind === 'sub_topic' || proposal.payload.kind === 'change_of_home') {
      return;
    }
    // Distinct-reviewer count (the redundant-peer-review invariant)
    // and weighted sum (the calibration-aware bias-resistance signal)
    // run in parallel. With calibration_aware_convergence off, weights
    // are uniformly 1, so the weighted sum equals the count and the
    // two conditions collapse to today's "two distinct accepts ⇒
    // accepted" behavior. With it on, a reviewer whose calibration
    // record went sour contributes 0 to the weighted sum but still 1
    // to the distinct count — meaning one cred-zero reject can hold a
    // convergence open without itself being able to drive it.
    const weighted = this.review.calibration_aware_convergence;
    let acceptCount = 0;
    let rejectCount = 0;
    let reviseCount = 0;
    let acceptWeight = 0;
    let rejectWeight = 0;
    const causeId = weighted ? this.reputationCauseFor(proposal) : null;
    const subTopicId = weighted ? this.reputationSubTopicFor(proposal) : null;
    for (const v of this.store.reviewVotes.values()) {
      if (v.proposal_id !== proposalId) continue;
      if (v.decision === 'accept') {
        acceptCount += 1;
        acceptWeight +=
          weighted && causeId && subTopicId
            ? this.calibrationVoteWeight(v.reviewer_id, causeId, subTopicId)
            : 1;
      } else if (v.decision === 'reject') {
        rejectCount += 1;
        rejectWeight +=
          weighted && causeId && subTopicId
            ? this.calibrationVoteWeight(v.reviewer_id, causeId, subTopicId)
            : 1;
      } else if (v.decision === 'revise') {
        reviseCount += 1;
      }
    }
    // Stratification-degraded tightening (PRD §Reviewer assignment).
    // When the eligible pool can't furnish stratum_target_count
    // distinct strata, both convergence thresholds bump by the
    // configured extra. This is the seam that makes the small-sub-
    // topic case slower-but-not-capturable: a coalition that fits the
    // pool can't drive convergence at the standard threshold because
    // the threshold itself moved.
    const degraded = this.isProposalStratificationDegraded(proposal);
    // v3 closure-stack knob: when contested_votes_to_accept > 0 and the
    // proposal has accumulated any reject or revise vote, the auto-close
    // accept threshold is raised from votes_to_accept to
    // contested_votes_to_accept. Suppresses the auto-close-accept-path
    // failure the cube's `borderline-contested-v2` cell recorded — a
    // 2-accept-1-revise tally hitting votes_to_accept=2 on the normal
    // vote path before the curator escalation pass could see it.
    // Default 0 leaves the knob inert and the auto-close uses
    // votes_to_accept (back-compat preserved across every existing
    // scenario, golden cassette, and scripted-cube cell). Knob field on
    // ReviewConfig carries the rationale.
    const contestedFloor = this.review.contested_votes_to_accept;
    const hasDissent = rejectCount > 0 || reviseCount > 0;
    const acceptBase =
      contestedFloor > 0 && hasDissent ? contestedFloor : this.review.votes_to_accept;
    const acceptThreshold = acceptBase + (degraded ? this.review.stratification_degraded_extra : 0);
    const rejectThreshold =
      this.review.votes_to_reject + (degraded ? this.review.stratification_degraded_extra : 0);
    if (acceptCount >= acceptThreshold && acceptWeight >= acceptThreshold) {
      this.acceptStaged(proposal);
      this.applyReputationUpdates(proposal, 'accepted');
      return;
    }
    if (rejectCount >= rejectThreshold && rejectWeight >= rejectThreshold) {
      const now = this.clock.now();
      this.store.proposals.set(proposal.id, { ...proposal, status: 'rejected', updated_at: now });
      this.applyReputationUpdates(proposal, 'rejected');
    }
  }

  // Update per-(identity, cause, sub_topic) reputation in response to
  // a proposal converging. PRD §Reputation:
  //
  //   - Proposer's home-sub-topic rep moves with the outcome:
  //     +proposer_accepted_gain on accept, -proposer_rejected_loss on
  //     reject. Contributor-initiated proposals (no assignment_id)
  //     are scaled by `contributor_initiated_factor` per PRD §Reputation:
  //     "Contributor-initiated work earns sub-topic rep at a
  //     substantially reduced weight."
  //   - Reviewers who voted *with* the converged outcome get
  //     +reviewer_accurate_gain in the home sub-topic; reviewers who
  //     voted against it get -reviewer_inaccurate_loss. Reviewers
  //     accrue rep in the *home* sub-topic of the proposal they
  //     reviewed (membership proposals route to the target sub-topic
  //     for review, but the reviewer's competence-signal accrues
  //     wherever the review effort was spent — which is the location
  //     they were drawn from).
  //   - Curator-only kinds (sub_topic, change_of_home) never reach
  //     this path; resolveByConvergence short-circuits earlier.
  //   - revise votes count for neither tier and earn no rep movement
  //     (they remain available as a divergence signal — divergent
  //     proposals route to the divergence-closure sweep
  //     curator.archiveStaleProposals after the tunable window, per
  //     PRD §Reviewer assignment).
  //   - Self-supersedes carve-outs (PRD §Reputation) don't apply yet —
  //     supersedes acceptance updates the from-node's status but
  //     doesn't flow back into this path; supersedes-driven
  //     reputation lands when survivorship weighting does.
  private applyReputationUpdates(proposal: Proposal, outcome: 'accepted' | 'rejected'): void {
    const subTopicId = this.reputationSubTopicFor(proposal);
    if (!subTopicId) return;
    const causeId = this.reputationCauseFor(proposal);
    if (!causeId) return;

    // Proposer delta. Contributor-initiated (no assignment_id) earns
    // reduced weight per PRD §Reputation.
    const proposerFactor = proposal.assignment_id ? 1 : this.review.contributor_initiated_factor;
    const proposerDelta =
      outcome === 'accepted'
        ? this.review.proposer_accepted_gain * proposerFactor
        : -this.review.proposer_rejected_loss * proposerFactor;
    this.bumpReputation(proposal.proposer_id, causeId, subTopicId, proposerDelta);

    // Difficulty-normalization weight for reviewer deltas. PRD
    // §Reputation commits per-proposal contention (the same
    // 2*min(accepts, rejects)/total proxy the cluster signal uses)
    // as the v0 difficulty signal: unanimous-easy items earn
    // reviewers `alpha * base_delta`, contentious items earn the
    // full delta, and `alpha = 1` (default) preserves uniform-
    // credit. Computed once per convergence, applied to every
    // reviewer's gain or loss equally so accuracy and difficulty
    // compose multiplicatively rather than per-vote-conditional.
    // Revise votes excluded from the contention denominator (they
    // carry no agreement signal in either direction; same filter
    // the cluster signal applies).
    const alpha = this.review.review_credit_contention_alpha;
    let creditWeight = 1;
    if (alpha < 1) {
      let accepts = 0;
      let rejects = 0;
      for (const v of this.store.reviewVotes.values()) {
        if (v.proposal_id !== proposal.id) continue;
        if (v.decision === 'accept') accepts += 1;
        else if (v.decision === 'reject') rejects += 1;
      }
      const total = accepts + rejects;
      const contention = total > 0 ? (2 * Math.min(accepts, rejects)) / total : 0;
      creditWeight = alpha + (1 - alpha) * contention;
    }

    // Reviewer deltas. Each unique reviewer gets exactly one delta
    // per convergence — even if they cast multiple votes (which
    // double-vote prevention forbids today, but the dedup is cheap
    // insurance against future revote semantics).
    const seenReviewers = new Set<IdentityId>();
    for (const v of this.store.reviewVotes.values()) {
      if (v.proposal_id !== proposal.id) continue;
      if (seenReviewers.has(v.reviewer_id)) continue;
      seenReviewers.add(v.reviewer_id);
      if (v.decision === 'revise') continue;
      const wasAccurate =
        (v.decision === 'accept' && outcome === 'accepted') ||
        (v.decision === 'reject' && outcome === 'rejected');
      const baseDelta = wasAccurate
        ? this.review.reviewer_accurate_gain
        : -this.review.reviewer_inaccurate_loss;
      this.bumpReputation(v.reviewer_id, causeId, subTopicId, baseDelta * creditWeight);
    }
  }

  // The sub-topic where reputation accrues for this proposal. For most
  // kinds it's the payload's home_sub_topic_id; for membership
  // proposals it's the target sub-topic (the review pool that judged
  // the scope claim is the one whose reputation pool absorbs the
  // outcome — same pool that voted, same pool that's tier-gated by
  // the score). Returns null for curator-only kinds, which never
  // reach this path anyway.
  private reputationSubTopicFor(proposal: Proposal): SubTopicId | null {
    switch (proposal.payload.kind) {
      case 'anchor':
      case 'excerpt':
      case 'synthesis':
      case 'open_question':
        return proposal.payload.home_sub_topic_id;
      case 'membership':
        return proposal.payload.sub_topic_id;
      case 'supersedes': {
        const fromNode = this.store.nodes.get(proposal.payload.from_node_id);
        return fromNode?.home_sub_topic_id ?? null;
      }
      case 'sub_topic':
      case 'change_of_home':
        return null;
    }
  }

  // Same shape as locateProposalForReview but returning just the
  // cause_id; locateProposalForReview is keyed by sub-topic-route
  // semantics for the frontier, while this tracks the cause for
  // reputation-keying and they happen to coincide today. Kept
  // separate so future divergence in routing rules doesn't muddle
  // the two concerns.
  private reputationCauseFor(proposal: Proposal): CauseId | null {
    return this.locateProposalForReview(proposal)?.cause_id ?? null;
  }

  private bumpReputation(
    identityId: IdentityId,
    causeId: CauseId,
    subTopicId: SubTopicId,
    delta: number,
  ): void {
    if (delta === 0) return;
    const key = `${identityId}|${causeId}|${subTopicId}` as const;
    const existing = this.store.reputations.get(key);
    const now = this.clock.now();
    // Decay-then-add: bring the existing snapshot forward to `now`
    // before applying the bump, so subsequent reads at any time decay
    // from a fresh anchor and successive bumps don't compound stale
    // values. PRD §Reputation: both components move together on every
    // event; differential behavior is the half-life, not the bump.
    const base = existing ? this.decayedReputation(existing, now) : { demonstrated: 0, recent: 0 };
    this.store.reputations.set(key, {
      identity_id: identityId,
      cause_id: causeId,
      sub_topic_id: subTopicId,
      demonstrated: base.demonstrated + delta,
      recent: base.recent + delta,
      updated_at: now,
    });
  }

  // Project a stored reputation snapshot to its decayed values at
  // `now`. Exponential decay parameterized by the per-component half-
  // life from review config — `Infinity` half-life collapses to no
  // decay (the v0 default and the back-compat path for existing
  // scenarios). Negative values decay toward zero from below the same
  // way positive ones decay toward zero from above; the multiplier is
  // applied to magnitude regardless of sign.
  private decayedReputation(
    rep: Reputation,
    now: Timestamp,
  ): { demonstrated: number; recent: number } {
    const elapsedMs = Date.parse(now) - Date.parse(rep.updated_at);
    if (elapsedMs <= 0) {
      return { demonstrated: rep.demonstrated, recent: rep.recent };
    }
    const elapsedSeconds = elapsedMs / 1000;
    return {
      demonstrated: decayValue(
        rep.demonstrated,
        elapsedSeconds,
        this.review.demonstrated_half_life_seconds,
      ),
      recent: decayValue(rep.recent, elapsedSeconds, this.review.recent_half_life_seconds),
    };
  }

  private bumpCalibrationRecord(
    identityId: IdentityId,
    causeId: CauseId,
    subTopicId: SubTopicId,
    outcome: 'pass' | 'fail',
  ): void {
    const key = `${identityId}|${causeId}|${subTopicId}` as const;
    const existing = this.store.calibrationRecords.get(key) ?? { passes: 0, fails: 0 };
    this.store.calibrationRecords.set(key, {
      passes: existing.passes + (outcome === 'pass' ? 1 : 0),
      fails: existing.fails + (outcome === 'fail' ? 1 : 0),
    });
  }

  // Vote weight for a reviewer at convergence time when calibration-
  // aware convergence is enabled. weight = max(0, 1 + passes - fails)
  // — base of 1 collapses to count-mode when every reviewer has zero
  // calibration history, so the flag is a strict superset of the
  // count behavior. Negative net record clips to 0: a reviewer whose
  // calibration record went sour cannot move convergence at all.
  private calibrationVoteWeight(
    identityId: IdentityId,
    causeId: CauseId,
    subTopicId: SubTopicId,
  ): number {
    const key = `${identityId}|${causeId}|${subTopicId}` as const;
    const rec = this.store.calibrationRecords.get(key);
    if (!rec) return 1;
    return Math.max(0, 1 + rec.passes - rec.fails);
  }

  // Vote-pattern co-occurrence clustering (PRD §Reviewer assignment,
  // v0 stratum primitive). Two reviewers fall in the same cluster
  // when they have voted on >= stratum_min_shared_proposals shared
  // past proposals AND their pairwise vote agreement on those shared
  // proposals is >= stratum_agreement_threshold. Connected components
  // over those pairwise edges are the strata. Reviewers below the
  // shared-history floor sit in singleton strata, which is the
  // honest-by-default behavior: a brand-new reviewer with no shared
  // history is independent until they prove otherwise.
  //
  // The function is keyed on (cause_id, sub_topic_id) because PRD
  // commits stratification at the per-(cause, sub-topic) level; vote
  // history elsewhere doesn't speak to bias zones in *this* sub-topic.
  // Members are returned as a Map identity -> stratum id; absence
  // means the identity has no votes in this scope and would be its
  // own singleton stratum if drawn into one.
  //
  // Computed on-the-fly per call. Cheap for v0 testbed pool sizes;
  // a per-(cause, sub-topic) cache with vote-cast invalidation is the
  // production move once pool sizes warrant it.
  private computeReviewerStrata(causeId: CauseId, subTopicId: SubTopicId): Map<IdentityId, string> {
    // Per-reviewer encounter history scoped to (cause, sub-topic):
    // proposal_id -> 'accept' | 'reject'. Built from review votes. Use
    // the same locateProposalForReview routing the rest of the server
    // uses so membership-cause-routing stays consistent.
    type EncounterDecision = 'accept' | 'reject';
    const reviewerEncounters = new Map<IdentityId, Map<ProposalId, EncounterDecision>>();
    for (const v of this.store.reviewVotes.values()) {
      const proposal = this.store.proposals.get(v.proposal_id);
      if (!proposal) continue;
      const route = this.locateProposalForReview(proposal);
      if (!route) continue;
      if (route.cause_id !== causeId) continue;
      if (route.sub_topic_id !== subTopicId) continue;
      // revise votes carry no agreement signal in either direction —
      // they mean "needs work, not yet" rather than a position. Drop
      // them from cluster computation.
      if (v.decision === 'revise') continue;
      let perReviewer = reviewerEncounters.get(v.reviewer_id);
      if (!perReviewer) {
        perReviewer = new Map();
        reviewerEncounters.set(v.reviewer_id, perReviewer);
      }
      // Defensive: if a reviewer has multiple non-revise votes on the
      // same proposal (current double-vote guard prevents this, but
      // future revote semantics may relax it), the latest cast wins —
      // it's the reviewer's standing position.
      perReviewer.set(v.proposal_id, v.decision);
    }

    // Per-proposal vote tallies, used to compute contention weights
    // when stratum_contention_weighted is on. Same iteration domain as
    // the pair loop; computed once outside the O(N²) pair loop.
    const proposalTally = new Map<ProposalId, { accepts: number; rejects: number }>();
    if (this.review.stratum_contention_weighted) {
      for (const perReviewer of reviewerEncounters.values()) {
        for (const [pid, decision] of perReviewer) {
          let t = proposalTally.get(pid);
          if (!t) {
            t = { accepts: 0, rejects: 0 };
            proposalTally.set(pid, t);
          }
          if (decision === 'accept') t.accepts += 1;
          else if (decision === 'reject') t.rejects += 1;
        }
      }
    }

    // Pairwise edge build. We iterate reviewers in a stable order to
    // make cluster id assignment deterministic — same encounter state =
    // same cluster ids.
    const reviewers = [...reviewerEncounters.keys()].sort();
    const adjacency = new Map<IdentityId, Set<IdentityId>>();
    for (const r of reviewers) adjacency.set(r, new Set());
    for (let i = 0; i < reviewers.length; i++) {
      const a = reviewers[i];
      if (!a) continue;
      const va = reviewerEncounters.get(a);
      if (!va) continue;
      for (let j = i + 1; j < reviewers.length; j++) {
        const b = reviewers[j];
        if (!b) continue;
        const vb = reviewerEncounters.get(b);
        if (!vb) continue;
        let shared = 0;
        let agreed = 0;
        let weightedShared = 0;
        let weightedAgreed = 0;
        for (const [pid, decisionA] of va) {
          const decisionB = vb.get(pid);
          if (!decisionB) continue;
          shared += 1;
          const agree = decisionA === decisionB;
          if (agree) agreed += 1;
          if (this.review.stratum_contention_weighted) {
            const tally = proposalTally.get(pid);
            if (tally) {
              const total = tally.accepts + tally.rejects;
              if (total > 0) {
                const minor = Math.min(tally.accepts, tally.rejects);
                // Contention in [0,1]: 0 when unanimous, 1 at perfect
                // split. Captures how informative this shared vote is
                // about coalition signal — agreement on uncontentious
                // proposals carries no weight, agreement on split-pool
                // proposals carries the most.
                const contention = (2 * minor) / total;
                weightedShared += contention;
                if (agree) weightedAgreed += contention;
              }
            }
          }
        }
        if (shared < this.review.stratum_min_shared_proposals) continue;
        // Compute both the agreement and disagreement ratios up-front
        // (in raw or contention-weighted form) so the agreement-edge
        // and anti-correlation-edge checks share their ratio source
        // and can never disagree on what "shared" means.
        let agreementRatio = 0;
        let disagreementRatio = 0;
        let signalAvailable = false;
        if (this.review.stratum_contention_weighted) {
          if (weightedShared > 0) {
            agreementRatio = weightedAgreed / weightedShared;
            disagreementRatio = (weightedShared - weightedAgreed) / weightedShared;
            signalAvailable = true;
          }
        } else {
          agreementRatio = agreed / shared;
          disagreementRatio = (shared - agreed) / shared;
          signalAvailable = true;
        }
        // No signal: the pair's entire shared history sits on
        // unanimous proposals (under contention weighting). Brand-new-
        // reviewer floor is preserved by the raw shared-count check
        // above; this is the additional gate that prevents a
        // contention-zero history from forming either kind of edge.
        if (!signalAvailable) continue;
        const positiveEdge = agreementRatio >= this.review.stratum_agreement_threshold;
        const antiThreshold = this.review.stratum_anti_correlation_threshold;
        const negativeEdge = antiThreshold > 0 && disagreementRatio >= antiThreshold;
        if (!positiveEdge && !negativeEdge) continue;
        adjacency.get(a)?.add(b);
        adjacency.get(b)?.add(a);
      }
    }

    // Connected-components over the agreement graph. Component id is
    // the lexicographically smallest identity in the component, which
    // gives stable ids across calls.
    const cluster = new Map<IdentityId, string>();
    for (const r of reviewers) {
      if (cluster.has(r)) continue;
      const queue: IdentityId[] = [r];
      const componentId = r;
      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur) continue;
        if (cluster.has(cur)) continue;
        cluster.set(cur, componentId);
        const neighbors = adjacency.get(cur);
        if (!neighbors) continue;
        for (const next of neighbors) {
          if (!cluster.has(next)) queue.push(next);
        }
      }
    }
    return cluster;
  }

  // Stratum a given identity occupies in (cause, sub-topic). Returns
  // the cluster id from computeReviewerStrata, or — if the identity
  // has no votes in scope yet — a singleton-stratum id keyed on the
  // identity itself. Singleton ids are formatted distinctly so they
  // can never collide with a multi-member cluster id.
  private stratumIdOf(identityId: IdentityId, strata: Map<IdentityId, string>): string {
    return strata.get(identityId) ?? `singleton:${identityId}`;
  }

  // Eligible-pool snapshot for a proposal: every identity holding a
  // reputation entry in the proposal's cause, minus the proposer (PRD
  // §Reviewer assignment conflict-of-interest invariant mirrored from
  // cast_review_vote). With no capacity declarations (PRD §Write-path
  // tools, "Assignment") and no expertise routing, cause-level
  // participation is exactly "has accrued any reputation here" — the
  // population from which the system draws review work. Used by the
  // stratification-degraded check to count reachable strata.
  //
  // Doesn't filter on rep tier — the rep gates
  // (`assignment_min_recent`, `assignment_min_demonstrated`) consume
  // rep at `request_assignment`, not here. Stratification-degraded
  // measures pool *diversity*: whether the pool could have been
  // diverse, not who currently clears the rep gate. A contributor who
  // would fail the rep gate today but later bootstraps past it still
  // counts toward diversity. Doesn't filter out identities who already
  // voted, either — their vote already counted, and the diversity
  // question is about whether the *pool* could have been diverse, not
  // about who is still pullable right now.
  private eligibleReviewerPool(proposal: Proposal): IdentityId[] {
    const route = this.locateProposalForReview(proposal);
    if (!route) return [];
    const seen = new Set<IdentityId>();
    const pool: IdentityId[] = [];
    for (const r of this.store.reputations.values()) {
      if (r.cause_id !== route.cause_id) continue;
      if (r.identity_id === proposal.proposer_id) continue;
      if (seen.has(r.identity_id)) continue;
      seen.add(r.identity_id);
      pool.push(r.identity_id);
    }
    return pool;
  }

  // Stratification-degraded check (PRD §Reviewer assignment). True
  // when the eligible reviewer pool covers fewer than
  // stratum_target_count distinct strata. False when stratification
  // is disabled (the flag's behavior is opt-in, mirroring the
  // calibration-aware-convergence pattern). A reviewer with no votes
  // in scope counts as their own singleton stratum, so a thin-history
  // pool is *not* automatically degraded — each reviewer is a stratum
  // until they prove correlated. The degradation case is a pool with
  // history that has already collapsed into too few clusters.
  private isProposalStratificationDegraded(proposal: Proposal): boolean {
    if (!this.review.stratification_enabled) return false;
    const route = this.locateProposalForReview(proposal);
    if (!route) return false;
    const pool = this.eligibleReviewerPool(proposal);
    if (pool.length === 0) return true;
    const strata = this.computeReviewerStrata(route.cause_id, route.sub_topic_id);
    const reachable = new Set<string>();
    for (const identityId of pool) {
      reachable.add(this.stratumIdOf(identityId, strata));
    }
    return reachable.size < this.review.stratum_target_count;
  }

  // Project the stratification-degraded flag onto a Proposal record at
  // read-path time. Returns the input record unchanged when the flag
  // is disabled or the proposal is past staging — terminal proposals
  // don't need a derived diversity signal, and stamping one would
  // muddle their record.
  private projectStratificationFlag(proposal: Proposal): Proposal {
    if (!this.review.stratification_enabled) return proposal;
    if (proposal.status !== 'staged') return proposal;
    return {
      ...proposal,
      stratification_degraded: this.isProposalStratificationDegraded(proposal),
    };
  }

  // Apply the result of materialize() to the store. Centralized so the
  // accept and defer paths can't drift in how they persist results.
  private applyMaterialization(result: MaterializationResult): void {
    if (result.node) {
      this.store.nodes.set(result.node.id, result.node);
    }
    for (const updated of result.nodeUpdates) {
      this.store.nodes.set(updated.id, updated);
    }
    for (const edge of result.edges) {
      this.store.edges.set(edge.id, edge);
    }
    for (const st of result.subTopicCreates) {
      this.store.subTopics.set(st.id, st);
    }
  }

  // Convert an accepted proposal into the state changes it asserts.
  // Four slots:
  //   `node`            — a newly created node (anchor / excerpt /
  //                       synthesis / open_question), or null for kinds
  //                       that don't create one.
  //   `edges`           — newly created edges (derives or supersedes).
  //   `nodeUpdates`     — existing nodes whose state must be rewritten
  //                       in place (supersedes flipping `from` to
  //                       superseded; change_of_home rewriting
  //                       `home_sub_topic_id`; membership appending to
  //                       `scope_memberships`).
  //   `subTopicCreates` — newly created sub-topics (sub_topic kind).
  // The `subTopicStatus` argument lets the same materialization path
  // produce a SubTopic with different statuses for the curator's two
  // accept variants (PRD §Sub-topic creation: accept-as-active or defer-as-
  // proposed). Other kinds ignore it.
  // Kinds without a materialization path throw `invalid_state` until
  // their path lands.
  private materialize(
    proposal: Proposal,
    subTopicStatus: 'active' | 'proposed',
  ): MaterializationResult {
    const now = this.clock.now();
    if (proposal.payload.kind === 'anchor') {
      const verified = this.store.verifiedRefs.get(proposal.id);
      if (!verified) {
        throw new ServerError(
          'invalid_state',
          `verification metadata missing for proposal ${proposal.id}`,
        );
      }
      const node: AnchorNode = {
        id: this.idGen.nodeId(),
        kind: 'anchor',
        home_sub_topic_id: proposal.payload.home_sub_topic_id,
        scope_memberships: proposal.payload.memberships ?? [],
        content: proposal.payload.content,
        status: 'active',
        created_by: proposal.proposer_id,
        created_at: now,
        updated_at: now,
        external_ref: proposal.payload.external_ref,
        content_hash: verified.content_hash,
        // Initial verify; the re-verification scheduler bumps this on
        // every subsequent successful fetch whose hash still matches.
        last_verified_at: now,
      };
      return { node, edges: [], nodeUpdates: [], subTopicCreates: [] };
    }
    if (proposal.payload.kind === 'excerpt') {
      // PRD §Edges: derives edges are created atomically with their
      // child node. The parent must still be active at acceptance
      // time — re-check, because nothing prevents the parent from
      // being superseded between propose and accept.
      const parent = this.store.nodes.get(proposal.payload.parent_anchor_id);
      if (!parent || parent.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `parent anchor ${proposal.payload.parent_anchor_id} is not active at acceptance`,
        );
      }
      const node: ExcerptNode = {
        id: this.idGen.nodeId(),
        kind: 'excerpt',
        home_sub_topic_id: proposal.payload.home_sub_topic_id,
        scope_memberships: proposal.payload.memberships ?? [],
        content: proposal.payload.content,
        status: 'active',
        created_by: proposal.proposer_id,
        created_at: now,
        updated_at: now,
        quoted_span: proposal.payload.quoted_span,
      };
      const edge: DerivesEdge = {
        id: this.idGen.edgeId(),
        kind: 'derives',
        from: parent.id,
        to: node.id,
        status: 'active',
        created_by: proposal.proposer_id,
        created_at: now,
      };
      return { node, edges: [edge], nodeUpdates: [], subTopicCreates: [] };
    }
    if (proposal.payload.kind === 'synthesis' || proposal.payload.kind === 'open_question') {
      // All parents must be active at acceptance time. Re-checked
      // here for the same reason as excerpt: a parent could have been
      // superseded between propose and accept.
      const parents: Node[] = [];
      for (const pid of proposal.payload.parent_ids) {
        const p = this.store.nodes.get(pid);
        if (!p || p.status !== 'active') {
          throw new ServerError('invalid_state', `parent ${pid} is not active at acceptance`);
        }
        parents.push(p);
      }
      const base = {
        id: this.idGen.nodeId(),
        home_sub_topic_id: proposal.payload.home_sub_topic_id,
        scope_memberships: proposal.payload.memberships ?? [],
        content: proposal.payload.content,
        status: 'active' as const,
        created_by: proposal.proposer_id,
        created_at: now,
        updated_at: now,
      };
      const node: SynthesisNode | OpenQuestionNode =
        proposal.payload.kind === 'synthesis'
          ? { ...base, kind: 'synthesis' }
          : { ...base, kind: 'open_question' };
      const edges: DerivesEdge[] = parents.map((p) => ({
        id: this.idGen.edgeId(),
        kind: 'derives',
        from: p.id,
        to: node.id,
        status: 'active',
        created_by: proposal.proposer_id,
        created_at: now,
      }));
      return { node, edges, nodeUpdates: [], subTopicCreates: [] };
    }
    if (proposal.payload.kind === 'supersedes') {
      // Re-check both endpoints at acceptance: either could have moved
      // out of `active` between propose and accept. Same defense as the
      // excerpt-parent re-check. Re-run the cycle detector too — a
      // concurrent supersedes acceptance could have introduced a path
      // that wasn't there at propose time.
      const fromNode = this.store.nodes.get(proposal.payload.from_node_id);
      if (!fromNode || fromNode.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `from node ${proposal.payload.from_node_id} is not active at acceptance`,
        );
      }
      const toNode = this.store.nodes.get(proposal.payload.to_node_id);
      if (!toNode || toNode.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `to node ${proposal.payload.to_node_id} is not active at acceptance`,
        );
      }
      if (this.supersedesWouldCycle(fromNode.id, toNode.id)) {
        throw new ServerError(
          'invalid_state',
          `supersedes from ${fromNode.id} to ${toNode.id} would create a cycle at acceptance`,
        );
      }
      const edge: SupersedesEdge = {
        id: this.idGen.edgeId(),
        kind: 'supersedes',
        from: fromNode.id,
        to: toNode.id,
        status: 'active',
        created_by: proposal.proposer_id,
        created_at: now,
        rationale: proposal.payload.rationale,
      };
      // The active-node rule (PRD §Nodes) defines a node as
      // inactive iff it is the `from` of a supersedes edge. We make
      // that explicit on the node's status field too — keeping status
      // and edge state in sync means callers don't have to walk edges
      // to know whether a node is active.
      const updated: Node = { ...fromNode, status: 'superseded', updated_at: now };
      return { node: null, edges: [edge], nodeUpdates: [updated], subTopicCreates: [] };
    }
    if (proposal.payload.kind === 'membership') {
      // Re-check the node and target sub-topic at acceptance: either
      // could have moved out of `active` between propose and accept,
      // and the node could have gained the membership through a
      // concurrent acceptance — in which case re-applying it would
      // be a no-op but the duplicate-membership invariant still has
      // to hold.
      const node = this.store.nodes.get(proposal.payload.node_id);
      if (!node || node.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `node ${proposal.payload.node_id} is not active at acceptance`,
        );
      }
      const target = this.store.subTopics.get(proposal.payload.sub_topic_id);
      if (!target || target.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `target sub-topic ${proposal.payload.sub_topic_id} is not active at acceptance`,
        );
      }
      if (node.home_sub_topic_id === proposal.payload.sub_topic_id) {
        throw new ServerError(
          'invalid_state',
          `node ${node.id} is now homed in sub-topic ${proposal.payload.sub_topic_id}`,
        );
      }
      if (node.scope_memberships.includes(proposal.payload.sub_topic_id)) {
        throw new ServerError(
          'invalid_state',
          `node ${node.id} already has membership in sub-topic ${proposal.payload.sub_topic_id}`,
        );
      }
      const updated: Node = {
        ...node,
        scope_memberships: [...node.scope_memberships, proposal.payload.sub_topic_id],
        updated_at: now,
      };
      return { node: null, edges: [], nodeUpdates: [updated], subTopicCreates: [] };
    }
    if (proposal.payload.kind === 'change_of_home') {
      const node = this.store.nodes.get(proposal.payload.node_id);
      if (!node || node.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `node ${proposal.payload.node_id} is not active at acceptance`,
        );
      }
      const target = this.store.subTopics.get(proposal.payload.new_home_sub_topic_id);
      if (!target || target.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `new home sub-topic ${proposal.payload.new_home_sub_topic_id} is not active at acceptance`,
        );
      }
      if (node.home_sub_topic_id === proposal.payload.new_home_sub_topic_id) {
        throw new ServerError(
          'invalid_state',
          `node ${node.id} is now homed in sub-topic ${proposal.payload.new_home_sub_topic_id}`,
        );
      }
      // PRD §Change of home: "Other memberships are unaffected; the one
      // exception is that if the new home was previously a scope
      // membership, it is removed from the membership list" — leaving
      // the home in scope_memberships would be a redundant duplicate
      // since the home is implicitly in scope.
      const newHome = proposal.payload.new_home_sub_topic_id;
      const filteredMemberships = node.scope_memberships.filter((s) => s !== newHome);
      const updated: Node = {
        ...node,
        home_sub_topic_id: newHome,
        scope_memberships: filteredMemberships,
        updated_at: now,
      };
      return { node: null, edges: [], nodeUpdates: [updated], subTopicCreates: [] };
    }
    if (proposal.payload.kind === 'sub_topic') {
      // Re-check the parent cause is still active. The cause is the
      // only hard prerequisite — name/description/scope_query are free
      // text and don't need re-validation.
      const cause = this.store.causes.get(proposal.payload.cause_id);
      if (!cause || cause.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `cause ${proposal.payload.cause_id} is not active at acceptance`,
        );
      }
      const subTopic: SubTopic = {
        id: this.idGen.subTopicId(),
        cause_id: cause.id,
        name: proposal.payload.name,
        description: proposal.payload.description,
        scope_query: proposal.payload.scope_query,
        status: subTopicStatus,
        created_at: now,
      };
      return { node: null, edges: [], nodeUpdates: [], subTopicCreates: [subTopic] };
    }
    // All ProposalPayload variants are handled above; this is an
    // exhaustiveness guard. If a new payload kind lands without a
    // matching materialize branch, TypeScript will widen `payload`'s
    // type past `never` and the assignment below will fail at
    // compile time, forcing the new branch to be added.
    const _exhaustive: never = proposal.payload;
    throw new ServerError(
      'invalid_state',
      `materialization not implemented for proposal kind: ${(_exhaustive as { kind: string }).kind}`,
    );
  }
}
