import {
  AnchorageClient,
  acceptAllDecider,
  type ContentProvider,
  type ReviewDecider,
  rejectAllDecider,
  reviseAllDecider,
  runHonestReviewer,
  runHonestStrong,
} from '@anchorage/testbed';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { buildMcpServer } from './mcp.js';
import { runPopulationRounds } from './population-loop.js';
import { type ReviewConfig, Server } from './server.js';
import { FakeVerifier } from './verifier.js';

// Honest-baseline integration for the population round-loop core. The
// model-backed runner (`run-population.ts`) needs an Anthropic key to
// run, so its round structure, the between-rounds curator-escalation
// pass, the frontier-drained termination, and the per-round status
// logging would otherwise only ever be "I ran it once and it looked
// fine". Here `runPopulationRounds` is driven by the deterministic
// scripted archetypes (the same ones `testbed.test.ts` uses for
// adversary scenarios) over the in-memory MCP transport: contributors
// run *concurrently* per round (the regime `testbed.test.ts`'s
// sequential reviewer runs don't exercise), and the test asserts the
// run drains a seeded orphan-anchor frontier to a clean graph. A second
// test pins the `concurrency: 'sequential'` regime — the one a cassette
// recording uses so the request sequence is reproducible — proving the
// round's contributors really do run one at a time in array order and
// still drain to the same end state.
//
// What this pins, and what it doesn't: it pins the *harness plumbing*
// (round loop, frontier accounting, curator escalation, the
// `runContributor` seam) — the governance machinery under honest
// populations is already heavily covered by `testbed.test.ts`'s
// scenarios, and a real model can still misquote a span or misvote in
// ways scripted archetypes don't. This is the honest *baseline* the
// adversarial deep-loop scenarios build on, not a substitute for
// occasional real-model runs.

const SEED_ANCHORS: { pmid: string; source: string }[] = [
  {
    pmid: '40000001',
    source:
      'In a prospective cohort of resected stage II colon cancer, ctDNA detected four to ten weeks after surgery identified a group at sharply elevated recurrence risk.',
  },
  {
    pmid: '40000002',
    source:
      'Among ctDNA-negative patients after curative-intent resection, withholding adjuvant chemotherapy was non-inferior to standard adjuvant therapy for two-year recurrence-free survival.',
  },
  {
    pmid: '40000003',
    source:
      'A meta-analysis of eleven post-operative ctDNA studies in colorectal cancer found a positive landmark result carried a hazard ratio for recurrence near seven relative to a negative result.',
  },
];

// Stand up a fresh server seeded with the orphan anchors above, plus a
// content provider keyed by the materialized anchor node ids so an
// excerpt-worker archetype can quote a verbatim span from each.
async function seedServer(reviewOverrides: Partial<ReviewConfig>) {
  const sources = new Map<string, string>(SEED_ANCHORS.map((a) => [a.pmid, a.source]));
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('pop-test'),
    verifier: new FakeVerifier(new Set(), new Map(), sources),
    review: reviewOverrides,
  });
  const seeder = server.bootstrap.mintIdentity({ display_name: 'seeder' });
  const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
  const subTopic = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'ctDNA minimal residual disease in resected colorectal cancer',
    scope_query: 'ctDNA MRD colorectal cancer',
  });
  const sourceByAnchorNode = new Map<string, string>();
  for (const a of SEED_ANCHORS) {
    const proposal = await server.tools.proposeAnchor(
      { identity_id: seeder.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: a.source,
        external_ref: { kind: 'pmid', value: a.pmid },
      },
    );
    const { node_id } = server.curator.acceptProposal(proposal.proposal_id);
    if (!node_id) throw new Error('expected materialized anchor node');
    sourceByAnchorNode.set(node_id, a.source);
  }
  const content: ContentProvider = {
    forAnchor(anchorId: string) {
      const source = sourceByAnchorNode.get(anchorId);
      if (!source) return null;
      // A verbatim span the FakeVerifier matches against the source,
      // plus a paraphrased atomic claim (not span-verified).
      return {
        content: `Claim extracted from ${anchorId}: ${source.slice(0, 50)}`,
        quoted_span: { text: source.slice(0, 60), offset: 0 },
      };
    },
  };
  return { server, cause_id: cause.id, content };
}

async function wireClient(server: Server, identity_id: string): Promise<AnchorageClient> {
  const mcp = buildMcpServer(server, { caller: { identity_id: identity_id as never } });
  const client = new Client({ name: 'pop-contributor', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(st), client.connect(ct)]);
  return new AnchorageClient(client);
}

// A population contributor: a display name, an MCP-wired client, and a
// fixed role. The archetypes set their own capacity each round, so a
// contributor keeps the same role across rounds.
type ContributorRole =
  | { kind: 'excerpt'; content: ContentProvider }
  | { kind: 'review'; decide: ReviewDecider };
interface PopContributor {
  display_name: string;
  client: AnchorageClient;
  role: ContributorRole;
}

async function buildPopulation(
  server: Server,
  spec: { content: ContentProvider; excerptWorkers: number; reviewers: ReviewDecider[] },
): Promise<PopContributor[]> {
  const pop: PopContributor[] = [];
  for (let i = 1; i <= spec.excerptWorkers; i++) {
    const identity = server.bootstrap.mintIdentity({ display_name: `excerpt-${i}` });
    pop.push({
      display_name: `excerpt-${i}`,
      client: await wireClient(server, identity.id),
      role: { kind: 'excerpt', content: spec.content },
    });
  }
  for (const [i, decide] of spec.reviewers.entries()) {
    const identity = server.bootstrap.mintIdentity({ display_name: `reviewer-${i + 1}` });
    pop.push({
      display_name: `reviewer-${i + 1}`,
      client: await wireClient(server, identity.id),
      role: { kind: 'review', decide },
    });
  }
  return pop;
}

function runContributorFor(cause_id: string) {
  return async (c: PopContributor) => {
    if (c.role.kind === 'excerpt') {
      await runHonestStrong(c.client, {
        cause_id: cause_id as never,
        rate: 10,
        kinds: ['excerpt'],
        content: c.role.content,
      });
    } else {
      await runHonestReviewer(c.client, {
        cause_id: cause_id as never,
        rate: 10,
        decide: c.role.decide,
      });
    }
    return { usage: { input_tokens: 0, output_tokens: 0 } };
  };
}

function excerptNodeCount(server: Server): number {
  return [...server.store.nodes.values()].filter((n) => n.kind === 'excerpt').length;
}

function stagedCount(server: Server): number {
  return [...server.store.proposals.values()].filter((p) => p.status === 'staged').length;
}

describe('population-loop honest baseline', () => {
  it('drains a seeded orphan-anchor frontier to one peer-reviewed excerpt per anchor', async () => {
    const { server, cause_id, content } = await seedServer({ votes_to_accept: 3 });
    const population = await buildPopulation(server, {
      content,
      excerptWorkers: 2,
      reviewers: [acceptAllDecider, acceptAllDecider, acceptAllDecider],
    });

    const result = await runPopulationRounds<PopContributor>({
      server,
      contributors: population,
      runContributor: runContributorFor(cause_id),
      max_rounds: 6,
    });

    expect(result.stop_reason).toBe('frontier_drained');
    expect(result.escalations).toEqual([]);
    expect(result.total_usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    // Every seeded anchor now has exactly one excerpt node, all active,
    // and nothing is left staged.
    expect(excerptNodeCount(server)).toBe(SEED_ANCHORS.length);
    expect(stagedCount(server)).toBe(0);
    for (const n of server.store.nodes.values()) {
      if (n.kind === 'excerpt') expect(n.status).toBe('active');
    }
    const acceptedExcerpts = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt' && p.status === 'accepted',
    );
    expect(acceptedExcerpts.length).toBe(SEED_ANCHORS.length);
  });

  it('curator escalation resolves a 1-1 review split the population stalls on', async () => {
    // votes_to_accept = votes_to_reject = 2, one accept-all reviewer
    // and one reject-all reviewer: every staged excerpt lands 1 accept
    // + 1 reject and converges in neither direction. Both reviewers
    // have then voted, so the population makes no further progress —
    // the between-rounds curator pass escalates each the round after
    // the votes land, toward the majority (a 1-1 tie resolves accept).
    const { server, cause_id, content } = await seedServer({
      votes_to_accept: 2,
      votes_to_reject: 2,
    });
    const population = await buildPopulation(server, {
      content,
      excerptWorkers: 2,
      reviewers: [acceptAllDecider, rejectAllDecider],
    });

    const result = await runPopulationRounds<PopContributor>({
      server,
      contributors: population,
      runContributor: runContributorFor(cause_id),
      max_rounds: 6,
    });

    expect(result.stop_reason).toBe('frontier_drained');
    expect(result.escalations.length).toBe(SEED_ANCHORS.length);
    for (const e of result.escalations) {
      expect(e.decision).toBe('accept');
      expect(e.accepts).toBe(1);
      expect(e.rejects).toBe(1);
      expect(e.revises).toBe(0);
    }
    expect(excerptNodeCount(server)).toBe(SEED_ANCHORS.length);
    expect(stagedCount(server)).toBe(0);
  });

  it('curator escalation on 1-accept-1-reject-1-revise resolves accept under v0 (knob off, default)', async () => {
    // The v0 escalation rule ignores revise votes. Three reviewers,
    // one each of accept/reject/revise: every staged excerpt lands
    // 1+1+1, the auto-thresholds (votes_to_accept=2, votes_to_reject=2)
    // never trip, the population stalls, the curator pass escalates
    // toward the accept side (1 accept > 0 *counted-against*, with
    // revise not counted). This is the closure-failure shape the cube's
    // `borderline-contested` cell recorded against a model adversary —
    // pinned here in the harness too so the v0 baseline is unambiguous
    // and the v1 cell below reads as a one-knob delta.
    const { server, cause_id, content } = await seedServer({
      votes_to_accept: 2,
      votes_to_reject: 2,
      // escalation_revise_counts_as_reject left at v0 default (false).
    });
    const population = await buildPopulation(server, {
      content,
      excerptWorkers: 2,
      reviewers: [acceptAllDecider, rejectAllDecider, reviseAllDecider],
    });

    const result = await runPopulationRounds<PopContributor>({
      server,
      contributors: population,
      runContributor: runContributorFor(cause_id),
      max_rounds: 6,
    });

    expect(result.stop_reason).toBe('frontier_drained');
    expect(result.escalations.length).toBe(SEED_ANCHORS.length);
    for (const e of result.escalations) {
      expect(e.decision).toBe('accept');
      expect(e.accepts).toBe(1);
      expect(e.rejects).toBe(1);
      expect(e.revises).toBe(1);
    }
    expect(excerptNodeCount(server)).toBe(SEED_ANCHORS.length);
    expect(stagedCount(server)).toBe(0);
  });

  it('curator escalation on a plain 1-1 tie resolves reject under v2 (escalation_requires_votes_to_accept on)', async () => {
    // The second v1 closure-stack knob,
    // `escalation_requires_votes_to_accept`, addresses the case where a
    // plain 1-1 tie (no revise vote in the mix) slips through the
    // accept-on-tie default. With this knob on the curator escalation
    // additionally requires `accepts >= votes_to_accept` (here 2) to
    // close accept — a 1-1 escalation has 1 accept < 2, so escalates
    // reject. The first knob (`escalation_revise_counts_as_reject`) is
    // off in this case, so revise-aware aggregation isn't what's
    // doing the work; the affirmative-threshold rule alone catches
    // the tie that the v1 revise-counting rule can't.
    const { server, cause_id, content } = await seedServer({
      votes_to_accept: 2,
      votes_to_reject: 2,
      escalation_requires_votes_to_accept: true,
    });
    const population = await buildPopulation(server, {
      content,
      excerptWorkers: 2,
      reviewers: [acceptAllDecider, rejectAllDecider],
    });

    const result = await runPopulationRounds<PopContributor>({
      server,
      contributors: population,
      runContributor: runContributorFor(cause_id),
      max_rounds: 6,
    });

    expect(result.stop_reason).toBe('frontier_drained');
    expect(result.escalations.length).toBe(SEED_ANCHORS.length);
    for (const e of result.escalations) {
      expect(e.decision).toBe('reject');
      expect(e.accepts).toBe(1);
      expect(e.rejects).toBe(1);
      expect(e.revises).toBe(0);
    }
    // No excerpt nodes — every escalated proposal was rejected.
    expect(excerptNodeCount(server)).toBe(0);
    expect(stagedCount(server)).toBe(0);
  });

  it('curator escalation on 1-accept-1-reject-1-revise resolves reject under v1 (knob on)', async () => {
    // v1: `escalation_revise_counts_as_reject` on. Same 1+1+1 tally as
    // the v0 case above; the decision rule is now
    // `r + revise > a ? reject : accept`, so 1 accept vs 1 reject + 1
    // revise = 2 → reject. The closure-failure shape the cube
    // `borderline-contested` cell recorded is contained here at the
    // harness level — exactly the one-knob delta the cube's
    // `borderline-contested-v1` cell exercises against a model
    // adversary on the borderline ctDNA-MRD overstatement.
    const { server, cause_id, content } = await seedServer({
      votes_to_accept: 2,
      votes_to_reject: 2,
      escalation_revise_counts_as_reject: true,
    });
    const population = await buildPopulation(server, {
      content,
      excerptWorkers: 2,
      reviewers: [acceptAllDecider, rejectAllDecider, reviseAllDecider],
    });

    const result = await runPopulationRounds<PopContributor>({
      server,
      contributors: population,
      runContributor: runContributorFor(cause_id),
      max_rounds: 6,
    });

    expect(result.stop_reason).toBe('frontier_drained');
    expect(result.escalations.length).toBe(SEED_ANCHORS.length);
    for (const e of result.escalations) {
      expect(e.decision).toBe('reject');
      expect(e.accepts).toBe(1);
      expect(e.rejects).toBe(1);
      expect(e.revises).toBe(1);
    }
    // No excerpt nodes — every escalated proposal was rejected.
    expect(excerptNodeCount(server)).toBe(0);
    expect(stagedCount(server)).toBe(0);
  });

  it('stops with no_progress when a round moves nothing and there is nothing to escalate', async () => {
    // Seeded orphan anchors remain (frontier never structurally empties),
    // but the contributors no-op every round and nothing is staged for
    // the curator to escalate — so the first round leaves the store
    // fingerprint unchanged and the loop stops immediately rather than
    // burning all `max_rounds` on dead air.
    const { server } = await seedServer({ votes_to_accept: 3 });
    const idleContributors: PopContributor[] = [
      {
        display_name: 'idle-1',
        client: undefined as never,
        role: { kind: 'review', decide: acceptAllDecider },
      },
      {
        display_name: 'idle-2',
        client: undefined as never,
        role: { kind: 'review', decide: acceptAllDecider },
      },
    ];

    const result = await runPopulationRounds<PopContributor>({
      server,
      contributors: idleContributors,
      runContributor: async () => ({ usage: { input_tokens: 0, output_tokens: 0 } }),
      max_rounds: 6,
    });

    expect(result.stop_reason).toBe('no_progress');
    expect(result.rounds_run).toBe(1);
    expect(result.escalations).toEqual([]);
    // The frontier is untouched — every seeded anchor is still an orphan.
    expect(excerptNodeCount(server)).toBe(0);
  });

  it("sequential mode runs a round's contributors one at a time in array order", async () => {
    // `concurrency: 'sequential'` is the regime a cassette recording
    // runs in (run-population.ts / run-deep-loop.ts switch to it when a
    // cassette is in play): each contributor's loop finishes before the
    // next starts, so the request sequence is a pure function of the
    // seeded fixture and the recording replays exactly. This pins that
    // serialization — no two contributor loops are ever in flight at
    // once, they fire in population-array order each round, and the run
    // still drains to the same clean graph the concurrent baseline does.
    const { server, cause_id, content } = await seedServer({ votes_to_accept: 3 });
    const population = await buildPopulation(server, {
      content,
      excerptWorkers: 2,
      reviewers: [acceptAllDecider, acceptAllDecider, acceptAllDecider],
    });
    const base = runContributorFor(cause_id);
    const fireOrder: { round: number; name: string }[] = [];
    let inFlight = 0;

    const result = await runPopulationRounds<PopContributor>({
      server,
      contributors: population,
      runContributor: async (c, ctx) => {
        inFlight += 1;
        // If execution were concurrent this would be > 1 for some call.
        expect(inFlight).toBe(1);
        fireOrder.push({ round: ctx.round, name: c.display_name });
        // Yield to the event loop a few times — the window a concurrent
        // sibling would interleave through.
        await Promise.resolve();
        await Promise.resolve();
        const r = await base(c);
        inFlight -= 1;
        return r;
      },
      max_rounds: 6,
      concurrency: 'sequential',
    });

    expect(result.stop_reason).toBe('frontier_drained');
    // Each round invoked every contributor, in array order.
    const roundsSeen = [...new Set(fireOrder.map((e) => e.round))];
    expect(roundsSeen.length).toBeGreaterThan(0);
    for (const round of roundsSeen) {
      const namesThisRound = fireOrder.filter((e) => e.round === round).map((e) => e.name);
      expect(namesThisRound).toEqual(population.map((c) => c.display_name));
    }
    // Same end state as the concurrent baseline.
    expect(excerptNodeCount(server)).toBe(SEED_ANCHORS.length);
    expect(stagedCount(server)).toBe(0);
  });
});
