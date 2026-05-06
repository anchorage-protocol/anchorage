import {
  type AgentCredential,
  type Cause,
  type CauseId,
  type Identity,
  type IdentityId,
  type Proposal,
  ProposeAnchorInput,
  type ProposeAnchorOutput,
  type SubTopic,
  type SubTopicId,
} from '@anchorage/contracts';
import { z } from 'zod';
import { type Caller, resolveCaller } from './auth.js';
import { type Clock, SystemClock } from './clock.js';
import { ServerError } from './errors.js';
import { type IdGen, RandomIdGen } from './id-gen.js';
import { MemoryStore } from './store.js';
import { StructuralVerifier, type Verifier } from './verifier.js';

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
  verifier?: Verifier;
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
  readonly store: MemoryStore;
  readonly verifier: Verifier;

  constructor(deps: ServerDeps = {}) {
    this.clock = deps.clock ?? new SystemClock();
    this.idGen = deps.idGen ?? new RandomIdGen();
    this.store = deps.store ?? new MemoryStore();
    this.verifier = deps.verifier ?? new StructuralVerifier();
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
      throw new ServerError('not_found', `cause not found: ${causeId}`);
    }
    if (cause.status !== 'active') {
      throw new ServerError('invalid_state', `cause is ${cause.status}`);
    }
    return cause;
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

  readonly tools = {
    // PRD §Write-path tools: propose_anchor stages an anchor proposal.
    // Synchronous verification at the tool boundary: external_ref must
    // resolve. If verification fails, no proposal record is created
    // (ProposalStatus comment: `rejected` means review-rejected, not
    // verification-rejected).
    proposeAnchor: async (
      caller: Caller,
      input: ProposeAnchorInput,
    ): Promise<ProposeAnchorOutput> => {
      const parsed = ProposeAnchorInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);

      const cause = this.requireActiveCause(parsed.cause_id);
      this.requireActiveSubTopicInCause(parsed.home_sub_topic_id, cause.id, 'home');
      const memberships = parsed.memberships ?? [];
      for (const m of memberships) {
        this.requireActiveSubTopicInCause(m, cause.id, 'membership');
      }

      await this.verifier.verifyExternalRef(parsed.external_ref);

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload: {
          kind: 'anchor',
          cause_id: cause.id,
          home_sub_topic_id: parsed.home_sub_topic_id,
          ...(memberships.length > 0 ? { memberships } : {}),
          content: parsed.content,
          external_ref: parsed.external_ref,
        },
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      return { proposal_id: proposal.id };
    },
  };
}
