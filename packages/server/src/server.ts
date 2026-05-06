import type {
  AgentCredential,
  Cause,
  CauseId,
  Identity,
  IdentityId,
  SubTopic,
} from '@anchorage/contracts';
import { z } from 'zod';
import { type Clock, SystemClock } from './clock.js';
import { ServerError } from './errors.js';
import { type IdGen, RandomIdGen } from './id-gen.js';
import { MemoryStore } from './store.js';

// Bootstrap input schemas. These are admin-surface inputs and are
// deliberately separate from the contributor-facing MCP tool I/O in
// `@anchorage/contracts/tools.ts` — see PRD §Service surfaces (admin
// surface vs MCP tool surface).
const MintIdentityInput = z.object({ display_name: z.string().min(1).max(100) }).strict();
type MintIdentityInput = z.infer<typeof MintIdentityInput>;

const BindAgentCredentialInput = z
  .object({
    identity_id: z.string().min(1),
    label: z.string().min(1).max(100),
  })
  .strict();
type BindAgentCredentialInput = z.infer<typeof BindAgentCredentialInput>;

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

export interface ServerDeps {
  clock?: Clock;
  idGen?: IdGen;
  store?: MemoryStore;
}

// Server is the trust boundary. All mutation goes through it. The
// `bootstrap` namespace holds curator/admin operations not exposed as
// MCP tools (cause creation, sub-topic seeding, identity issuance);
// contributor-facing tools are added incrementally and live under
// `tools` (TBD).
export class Server {
  readonly clock: Clock;
  readonly idGen: IdGen;
  readonly store: MemoryStore;

  constructor(deps: ServerDeps = {}) {
    this.clock = deps.clock ?? new SystemClock();
    this.idGen = deps.idGen ?? new RandomIdGen();
    this.store = deps.store ?? new MemoryStore();
  }

  readonly bootstrap = {
    mintIdentity: (input: MintIdentityInput): Identity => {
      const parsed = MintIdentityInput.parse(input);
      const identity: Identity = {
        id: this.idGen.identityId(),
        display_name: parsed.display_name,
        status: 'active',
        created_at: this.clock.now(),
      };
      this.store.identities.set(identity.id, identity);
      return identity;
    },

    bindAgentCredential: (input: BindAgentCredentialInput): AgentCredential => {
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
      const credential: AgentCredential = {
        id: this.idGen.agentCredentialId(),
        identity_id: identity.id,
        label: parsed.label,
        status: 'active',
        created_at: this.clock.now(),
      };
      this.store.agentCredentials.set(credential.id, credential);
      return credential;
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
    // sub-topics (via the future `propose_sub_topic` tool) start
    // `proposed` and need curator approval to activate. PRD §Sub-topic
    // creation governance.
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
}
