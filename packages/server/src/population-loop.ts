// The population round-loop core, extracted from `run-population.ts`
// so it can be driven by something other than env vars and a real
// Anthropic key: `run-population.ts` wires it to `runLlmAgent` loops
// and `console.log`; `population-loop.test.ts` wires it to scripted
// archetypes and a capture buffer to pin the honest baseline in CI.
//
// What the core owns: round structure (N contributors run concurrently
// per round, re-entering fresh each round), the between-rounds
// curator-escalation pass (PRD §Reviewer assignment step 4 — the
// 1-1-with-no-tiebreaker resolution path), the frontier-drained /
// rounds-exhausted / budget termination logic, and the per-round
// status logging. What it does *not* own: seeding the server, wiring
// MCP clients, choosing/pricing a model, or how a single contributor
// behaves in a round — those stay with the caller (`runContributor`
// is the seam: it gets a contributor and the round index, runs that
// contributor's loop against its already-wired client, and reports
// the model-token usage it incurred — zero for scripted archetypes).
//
// Reading `server.store` directly here is the same liberty the
// surrounding harness scripts take: the contributors only ever see the
// MCP surface; the harness sees the store to decide when the frontier
// is drained and which proposals stalled.

import type { Server } from './server.js';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface EscalationOutcome {
  round: number;
  proposal_id: string;
  decision: 'accept' | 'reject';
  accepts: number;
  rejects: number;
  // Count of `revise` votes on the proposal at escalation time. Whether
  // they tipped the decision is governed by the v1 knob
  // `ReviewConfig.escalation_revise_counts_as_reject` — see that field
  // and the decision rule in `escalateStuckProposals`. Reported
  // unconditionally for diagnostics: every escalation report can show
  // the full 3-way tally, so a v0/v1 sweep reads as a one-knob delta.
  revises: number;
}

// Approximate Anthropic-style USD cost from token usage and a per-
// million-token rate. Coarse: a spend guard, not billing.
export interface ModelRate {
  input: number;
  output: number;
}
export function usdCost(usage: TokenUsage, rate: ModelRate): number {
  return (usage.input_tokens * rate.input + usage.output_tokens * rate.output) / 1_000_000;
}

// Per-million-token USD rates for the models the model-backed runners
// (`run-live`, `run-population`, `run-deep-loop`, `run-deep-loop-cube`)
// can be pointed at — only used to feed the coarse spend guard, so an
// unknown model falls back to Haiku rates with a warning rather than
// failing the run.
export const HAIKU_RATE: ModelRate = { input: 1, output: 5 };
const PRICING_PER_MTOK: Record<string, ModelRate> = {
  'claude-haiku-4-5-20251001': HAIKU_RATE,
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-7': { input: 15, output: 75 },
};
export function priceFor(model: string): ModelRate {
  const p = PRICING_PER_MTOK[model];
  if (p) return p;
  console.warn(`# no price table entry for ${model}; estimating at Haiku 4.5 rates`);
  return HAIKU_RATE;
}

export function graphStatusLine(server: Server): string {
  const byStatus = new Map<string, number>();
  for (const p of server.store.proposals.values())
    byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
  const nodesByKind = new Map<string, number>();
  for (const n of server.store.nodes.values())
    nodesByKind.set(n.kind, (nodesByKind.get(n.kind) ?? 0) + 1);
  const proposalStr =
    [...byStatus.entries()].map(([s, c]) => `${s}=${c}`).join(' ') || '(no proposals)';
  const nodeStr = [...nodesByKind.entries()].map(([k, c]) => `${k}=${c}`).join(' ') || '(no nodes)';
  return `proposals: ${proposalStr} | nodes: ${nodeStr} | review_votes=${server.store.reviewVotes.size}`;
}

// True when the population has nothing left it can act on through the
// MCP surface: no staged proposal awaiting review, and every anchor
// node already has an excerpt child or a staged excerpt proposal in
// flight for it. (A staged proposal the population stalls on counts
// as "not drained" until the curator-escalation pass resolves it.)
export function frontierEmpty(server: Server): boolean {
  for (const p of server.store.proposals.values()) {
    if (p.status === 'staged') return false;
  }
  const anchorNodeIds = new Set(
    [...server.store.nodes.values()].filter((n) => n.kind === 'anchor').map((n) => n.id),
  );
  const handledAnchors = new Set<string>();
  for (const n of server.store.nodes.values()) {
    if (n.kind === 'excerpt') {
      const parent = (n as { parent_anchor_id?: string }).parent_anchor_id;
      if (parent) handledAnchors.add(parent);
    }
  }
  for (const p of server.store.proposals.values()) {
    if (p.payload.kind === 'excerpt') handledAnchors.add(p.payload.parent_anchor_id);
  }
  for (const id of anchorNodeIds) if (!handledAnchors.has(id)) return false;
  return true;
}

// A coarse fingerprint of all population-reachable store state: node /
// edge / review-vote / assignment counts, the per-proposal status
// multiset, and the calibration tallies. A round that leaves this
// unchanged moved nothing — every contributor found no task or no-op'd,
// and the curator had nothing stuck to escalate — and the next round
// would be the same, so the loop can stop with `no_progress` rather
// than burning the rest of `max_rounds` on dead air. (Model agents
// aren't perfectly deterministic, so in principle a round-N no-op could
// be followed by a round-N+1 action; in practice once the frontier is
// exhausted and every proposal has converged or been escalated the
// agents have nothing to act on and stay quiet — the steady state every
// real deep-loop run settles into. The honest scripted baseline drains
// via `frontier_drained` at a round boundary before this can trip, and
// a between-rounds escalation changes a proposal's status so the round
// it fires in is never seen as a no-op.)
export function storeFingerprint(server: Server): string {
  const proposalStatuses = [...server.store.proposals.values()]
    .map((p) => `${p.id}=${p.status}`)
    .sort()
    .join(',');
  const calTally = [...server.store.calibrationRecords.values()].reduce(
    (sum, r) => sum + r.passes + r.fails,
    0,
  );
  return [
    server.store.nodes.size,
    server.store.edges.size,
    server.store.reviewVotes.size,
    server.store.assignments.size,
    calTally,
    proposalStatuses,
  ].join('|');
}

// Vote counts per currently-staged proposal — the pre-round snapshot
// `escalateStuckProposals` diffs against to tell "progressing" from
// "stuck".
export function stagedVoteCounts(server: Server): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of server.store.proposals.values()) {
    if (p.status === 'staged') counts.set(p.id, 0);
  }
  for (const v of server.store.reviewVotes.values()) {
    if (counts.has(v.proposal_id)) counts.set(v.proposal_id, (counts.get(v.proposal_id) ?? 0) + 1);
  }
  return counts;
}

// Curator-escalation pass between rounds (PRD §Reviewer assignment
// step 4): a staged proposal the population couldn't move during a
// full round — a 1-1 review split with no tiebreaker, a contested
// item the eligible pool is exhausted for, or one no reviewer ever
// picked up — has no resolution path the contributor loops can reach.
// The harness curator resolves it toward the majority of the votes
// cast, accepting on a tie or with no votes (every excerpt here
// already passed span verification at write time, so "accept" is the
// productive default; the divergence is recorded in the vote history
// either way). This is a deliberate v0 harness simplification of the
// same shape as the FakeVerifier source fixture and the absent
// calibration corpus: a real curator is a person (or a model curator)
// reading the proposal, not a majority-vote heuristic — what the
// harness exercises is the *path* (`curator.acceptProposal` /
// `curator.rejectProposal` closing a stuck divergence), not the
// judgment. A proposal staged mid-round is not yet in `preRoundCounts`
// and so gets a full subsequent round of review opportunity before it
// can be escalated; a proposal that gained any vote this round counts
// as still progressing and is left alone.
//
// Three orthogonal closure-stack knobs govern the tiebreak — see their
// docstrings on `ReviewConfig`. (1) `escalation_revise_counts_as_reject`
// (v1): v0 off → revise ignored, rule is `r > a ? reject : accept`; on →
// revise counts toward reject, rule is `r + revise > a ? reject :
// accept`. Catches the 1-accept-1-reject-1-revise case the cube's
// `borderline-contested` cell recorded. (2)
// `escalation_requires_votes_to_accept` (v2): v0 off → escalation-to-
// accept happens whenever the reject side doesn't win; on → additionally
// requires `accepts >= votes_to_accept`, the same affirmative-
// supermajority floor the auto-closure path enforces during normal
// voting. Catches the 1-1-0 case (plain tie, no revise) the first knob
// alone doesn't. (3) `contested_votes_to_accept` (v3): 0 off → no
// contested floor; > 0 on → when the tally has any reject or revise
// vote, escalation-to-accept additionally requires
// `accepts >= contested_votes_to_accept`. The escalation-side mirror of
// the same knob's auto-close-path role (see
// `ReviewConfig.contested_votes_to_accept` and `resolveByConvergence`),
// closing the path the cube's `borderline-contested-v2` cell recorded:
// 2-accept-1-revise hits `votes_to_accept=2` on the auto-close path
// before escalation runs at all. v3 holds the proposal on the
// auto-close side, then this branch rejects it on the escalation side
// when the contested floor isn't met. The three compose: the rule is
// `accept iff (reject_side <= a) AND (NOT v2 OR a >= votes_to_accept)
// AND (v3 inert OR no dissent OR a >= contested_votes_to_accept)`, with
// `reject_side = v1 ? r + revise : r`. The full 3-way tally is reported
// on `EscalationOutcome` unconditionally so v0/v1/v2/v3 reads cleanly as
// a knob delta.
export function escalateStuckProposals(
  server: Server,
  preRoundCounts: Map<string, number>,
  round: number,
): EscalationOutcome[] {
  // Total vote count per proposal, used only to decide *which*
  // proposals are stuck this round (staged last round, no new votes
  // since). The escalation *decision* — the v1/v2/v3 tiebreak rule —
  // lives on the server (`server.curator.escalateProposal`), so the
  // policy the testbed exercises here is byte-for-byte the policy a
  // production curator drives through the `curator_escalate_proposal`
  // MCP tool. This loop owns stuck-detection; the server owns the
  // rule.
  const total = new Map<string, number>();
  for (const v of server.store.reviewVotes.values()) {
    total.set(v.proposal_id, (total.get(v.proposal_id) ?? 0) + 1);
  }
  const escalated: EscalationOutcome[] = [];
  for (const p of server.store.proposals.values()) {
    if (p.status !== 'staged') continue;
    if (!preRoundCounts.has(p.id)) continue; // staged this round — give it another
    if ((total.get(p.id) ?? 0) !== preRoundCounts.get(p.id)) continue; // still progressing
    const outcome = server.curator.escalateProposal(p.id);
    escalated.push({
      round,
      proposal_id: p.id,
      decision: outcome.decision,
      accepts: outcome.accepts,
      rejects: outcome.rejects,
      revises: outcome.revises,
    });
  }
  return escalated;
}

export interface PopulationContributor {
  display_name: string;
}

export interface ContributorRoundResult {
  usage: TokenUsage;
  // Optional one-line summary the core logs after the round's
  // contributors have all returned (so it doesn't interleave with
  // concurrent per-turn output) — e.g. "stop=end_turn turns=7".
  log_summary?: string;
}

export interface PopulationRoundsConfig<C extends PopulationContributor> {
  server: Server;
  contributors: C[];
  // Run one contributor's loop for one round against its wired client.
  runContributor: (contributor: C, ctx: { round: number }) => Promise<ContributorRoundResult>;
  max_rounds: number;
  // Spend guard: stop before a round once cumulative spend would reach
  // 85% of `usd`. Omit to disable (scripted archetypes incur no cost).
  budget?: { usd: number; rate: { input: number; output: number } };
  // Per-line logger. Omit for a quiet run (tests).
  log?: (line: string) => void;
  // How the round's contributors run relative to each other:
  //   - 'concurrent' (default): all contributors' loops run at once
  //     (`Promise.all`) — the realistic regime (contributors race for
  //     frontier tasks) and the fast one when each loop is blocked on a
  //     real API call.
  //   - 'sequential': contributors run one at a time, in array order,
  //     each finishing its whole round before the next starts. Pick this
  //     when the run must be deterministic — notably when recording a
  //     cassette: with concurrent execution an agent's turn-N request
  //     depends on which other agents' writes had landed by then, which
  //     during recording is latency-dependent, so the recording can't be
  //     replayed exactly; sequential makes the request sequence a pure
  //     function of the seeded fixture, so a cassette recorded against a
  //     sequential run replays exactly (the same discipline `run-live.ts`
  //     gets for free by having only one agent).
  concurrency?: 'concurrent' | 'sequential';
}

export type PopulationStopReason =
  | 'frontier_drained'
  | 'no_progress'
  | 'budget'
  | 'rounds_exhausted';

export interface PopulationRoundsResult {
  stop_reason: PopulationStopReason;
  rounds_run: number;
  total_usage: TokenUsage;
  escalations: EscalationOutcome[];
}

export async function runPopulationRounds<C extends PopulationContributor>(
  config: PopulationRoundsConfig<C>,
): Promise<PopulationRoundsResult> {
  const log = config.log ?? (() => {});
  const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  const escalations: EscalationOutcome[] = [];
  let stopReason: PopulationStopReason = 'rounds_exhausted';
  let roundsRun = 0;

  for (let round = 1; round <= config.max_rounds; round++) {
    if (config.budget) {
      const spent = usdCost(totalUsage, config.budget.rate);
      if (spent >= config.budget.usd * 0.85) {
        stopReason = 'budget';
        log(
          `# stopping before round ${round}: spent ~$${spent.toFixed(2)} of $${config.budget.usd}`,
        );
        break;
      }
    }
    if (frontierEmpty(config.server)) {
      stopReason = 'frontier_drained';
      log(`# frontier drained before round ${round}`);
      break;
    }

    log(`# ── round ${round} ──`);
    const preRoundCounts = stagedVoteCounts(config.server);
    const preRoundFingerprint = storeFingerprint(config.server);
    const runOne = (c: C) =>
      config.runContributor(c, { round }).then((r) => ({ contributor: c, result: r }));
    let results: { contributor: C; result: ContributorRoundResult }[];
    if (config.concurrency === 'sequential') {
      results = [];
      for (const c of config.contributors) results.push(await runOne(c));
    } else {
      results = await Promise.all(config.contributors.map(runOne));
    }
    roundsRun = round;

    for (const { contributor, result } of results) {
      totalUsage.input_tokens += result.usage.input_tokens;
      totalUsage.output_tokens += result.usage.output_tokens;
      if (result.log_summary !== undefined) {
        log(`# ${contributor.display_name}: ${result.log_summary}`);
      }
    }
    // Curator escalation after the contributor loops have all returned,
    // so no agent ever sees a half-resolved store.
    const roundEscalations = escalateStuckProposals(config.server, preRoundCounts, round);
    for (const e of roundEscalations) {
      escalations.push(e);
      log(
        `# curator escalated ${e.proposal_id}: ${e.decision} (accepts=${e.accepts} rejects=${e.rejects} revises=${e.revises})`,
      );
    }
    const spentSuffix = config.budget
      ? ` | spent ~$${usdCost(totalUsage, config.budget.rate).toFixed(2)}`
      : '';
    log(`# after round ${round}: ${graphStatusLine(config.server)}${spentSuffix}\n`);

    if (storeFingerprint(config.server) === preRoundFingerprint) {
      stopReason = 'no_progress';
      log(`# no progress in round ${round} — population has nothing left to act on; stopping`);
      break;
    }
  }

  return { stop_reason: stopReason, rounds_run: roundsRun, total_usage: totalUsage, escalations };
}
