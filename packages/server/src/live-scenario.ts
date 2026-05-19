// The seeded fixture the single-agent live runner (`run-live.ts`) and
// the golden-cassette replay test (`golden-cassette.test.ts`) both
// stand up. Keeping it in one place is what makes the golden cassette
// viable: a recorded run replays deterministically only if the server
// it replays against mints the same ids in the same order — same
// `SeededIdGen` seed, same `FakeClock`, same bootstrap sequence — so
// the recording run's request bodies and the replay run's are
// byte-identical and every Messages-API round-trip hits the cassette
// (see `recording-fetch.ts` and `cassette-replay.test.ts`). Change
// this fixture and the checked-in golden cassette must be re-recorded.
//
// The anchors carry real-looking ctDNA-MRD source passages rather than
// `seed anchor N` placeholders on purpose: a careful honest agent
// correctly *declines* an excerpt task on an anchor whose source it
// can't fetch (it has no verbatim span to quote), so a placeholder
// frontier produces a do-nothing transcript. With the source text
// inline — and a `FakeVerifier` configured with the matching sources
// map, so span verification actually runs — the agent can pull an
// excerpt task, read the parent anchor off `query_proposals`, and
// quote a faithful span from it.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { buildMcpServer } from './mcp.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

// Pinned for the golden cassette — the recorder must not override it
// (`ANCHORAGE_TESTBED_MODEL` unset) so the recording and the replay
// test agree on the model field that goes into the request hash.
export const LIVE_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const LIVE_AGENT_MAX_TURNS = 24;

export const LIVE_ANCHORS: { pmid: string; content: string }[] = [
  {
    pmid: '40010001',
    content:
      'In a prospective cohort of resected stage II colon cancer, ctDNA detected four to ten weeks after surgery identified a group at sharply elevated recurrence risk: three-year recurrence-free survival was 64 percent in ctDNA-positive patients versus 90 percent in ctDNA-negative patients.',
  },
  {
    pmid: '40010002',
    content:
      'Among ctDNA-negative patients after curative-intent resection of stage II colon cancer, withholding adjuvant chemotherapy was non-inferior to standard adjuvant therapy for two-year recurrence-free survival, with roughly half the rate of grade three or higher treatment-related adverse events.',
  },
  {
    pmid: '40010003',
    content:
      'A meta-analysis pooling eleven post-operative ctDNA studies in colorectal cancer found a positive landmark ctDNA result carried a hazard ratio for recurrence of approximately seven relative to a negative result, with the prognostic signal present across both colon and rectal primaries.',
  },
];

// The kickoff task message for the live runner — shared with the
// golden-cassette test so the recorded run and the replay run send the
// byte-identical first user turn. It is deliberately explicit that the
// anchor's `content` is the source text span verification matches
// against (there is no source-retrieval *tool* exposed to contributors
// in v0; this scenario uses `FakeVerifier` with inline source fixtures
// rather than the production `LiveFetchVerifier`, because the cassette-
// replay tests need byte-deterministic source content not subject to
// PubMed availability), because a careful honest agent handed a bare
// "extract an excerpt from PMID X" task correctly *declines* — it has
// no way to fetch X and won't fabricate a span.
// The role's *system* prompt (the experimental treatment) is still
// what `run-live.ts` carries; only the kickoff task is standardized
// here, the same split `run-deep-loop.ts` uses (`deepLoopTask`).
export function buildLiveTask(cause_id: string): string {
  return [
    `Cause id: ${cause_id}.`,
    'Work the frontier one slot at a time: request an excerpt task (request_assignment,',
    'kind "excerpt") — it is yours to work the moment it is returned, there is no accept',
    'step — then read the parent anchor',
    '(it is among the accepted proposals — query_proposals), and quote a verbatim span from',
    "the anchor's content as the excerpt — for this instance the anchor content is the",
    'source text and span verification matches against it directly, so no external fetch is',
    'needed. Submit the excerpt, then pull the next task. Stop when request_assignment',
    'returns not_found — the frontier is drained.',
  ].join(' ');
}

export interface LiveScenario {
  server: Server;
  client: Client;
  cause_id: string;
  agent_id: string;
}

export async function buildLiveScenario(): Promise<LiveScenario> {
  const sources = new Map<string, string>(LIVE_ANCHORS.map((a) => [a.pmid, a.content]));
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('live'),
    verifier: new FakeVerifier(new Set(), new Map(), sources),
  });
  const seeder = server.bootstrap.mintIdentity({ display_name: 'seeder' });
  const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
  const subTopic = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'ctDNA minimal residual disease in resected CRC',
    scope_query: 'ctDNA MRD CRC',
  });
  for (const a of LIVE_ANCHORS) {
    const proposal = await server.tools.proposeAnchor(
      { identity_id: seeder.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: a.content,
        external_ref: { kind: 'pmid', value: a.pmid },
      },
    );
    server.curator.acceptProposal(proposal.proposal_id);
  }
  const agentIdentity = server.bootstrap.mintIdentity({ display_name: 'live-agent' });
  const { secret } = server.bootstrap.bindAgentCredential({
    identity_id: agentIdentity.id,
    label: 'live-agent',
  });
  const mcp = buildMcpServer(server, { token: secret });
  const client = new Client({ name: 'live-agent', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(st), client.connect(ct)]);
  return { server, client, cause_id: cause.id, agent_id: agentIdentity.id };
}
