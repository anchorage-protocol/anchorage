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
}

// Approximate Anthropic-style USD cost from token usage and a per-
// million-token rate. Coarse: a spend guard, not billing.
export function usdCost(usage: TokenUsage, rate: { input: number; output: number }): number {
  return (usage.input_tokens * rate.input + usage.output_tokens * rate.output) / 1_000_000;
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
export function escalateStuckProposals(
  server: Server,
  preRoundCounts: Map<string, number>,
  round: number,
): EscalationOutcome[] {
  const accepts = new Map<string, number>();
  const rejects = new Map<string, number>();
  const total = new Map<string, number>();
  for (const v of server.store.reviewVotes.values()) {
    total.set(v.proposal_id, (total.get(v.proposal_id) ?? 0) + 1);
    if (v.decision === 'accept') accepts.set(v.proposal_id, (accepts.get(v.proposal_id) ?? 0) + 1);
    else if (v.decision === 'reject')
      rejects.set(v.proposal_id, (rejects.get(v.proposal_id) ?? 0) + 1);
  }
  const escalated: EscalationOutcome[] = [];
  for (const p of server.store.proposals.values()) {
    if (p.status !== 'staged') continue;
    if (!preRoundCounts.has(p.id)) continue; // staged this round — give it another
    if ((total.get(p.id) ?? 0) !== preRoundCounts.get(p.id)) continue; // still progressing
    const a = accepts.get(p.id) ?? 0;
    const r = rejects.get(p.id) ?? 0;
    const decision: 'accept' | 'reject' = r > a ? 'reject' : 'accept';
    if (decision === 'accept') server.curator.acceptProposal(p.id);
    else server.curator.rejectProposal(p.id);
    escalated.push({ round, proposal_id: p.id, decision, accepts: a, rejects: r });
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
}

export type PopulationStopReason = 'frontier_drained' | 'budget' | 'rounds_exhausted';

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
    const results = await Promise.all(
      config.contributors.map((c) =>
        config.runContributor(c, { round }).then((r) => ({ contributor: c, result: r })),
      ),
    );
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
        `# curator escalated ${e.proposal_id}: ${e.decision} (accepts=${e.accepts} rejects=${e.rejects})`,
      );
    }
    const spentSuffix = config.budget
      ? ` | spent ~$${usdCost(totalUsage, config.budget.rate).toFixed(2)}`
      : '';
    log(`# after round ${round}: ${graphStatusLine(config.server)}${spentSuffix}\n`);
  }

  return { stop_reason: stopReason, rounds_run: roundsRun, total_usage: totalUsage, escalations };
}
