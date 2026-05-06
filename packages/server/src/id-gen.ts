import {
  AgentCredentialId,
  AssignmentId,
  CauseId,
  EdgeId,
  IdentityId,
  MembershipId,
  NodeId,
  ProposalId,
  ReviewVoteId,
  SubTopicId,
} from '@anchorage/contracts';

// Per-kind prefixes make IDs self-describing in logs and stack traces;
// they also make accidental cross-kind misuse fail at the schema layer
// rather than at runtime far from the bug.
const PREFIXES = {
  identity: 'idn',
  agentCredential: 'agt',
  cause: 'cau',
  subTopic: 'stp',
  node: 'nod',
  edge: 'edg',
  proposal: 'prp',
  membership: 'mbr',
  assignment: 'asn',
  reviewVote: 'rvv',
} as const;

export interface IdGen {
  identityId(): IdentityId;
  agentCredentialId(): AgentCredentialId;
  causeId(): CauseId;
  subTopicId(): SubTopicId;
  nodeId(): NodeId;
  edgeId(): EdgeId;
  proposalId(): ProposalId;
  membershipId(): MembershipId;
  assignmentId(): AssignmentId;
  reviewVoteId(): ReviewVoteId;
}

export class RandomIdGen implements IdGen {
  identityId(): IdentityId {
    return IdentityId.parse(`${PREFIXES.identity}_${crypto.randomUUID()}`);
  }
  agentCredentialId(): AgentCredentialId {
    return AgentCredentialId.parse(`${PREFIXES.agentCredential}_${crypto.randomUUID()}`);
  }
  causeId(): CauseId {
    return CauseId.parse(`${PREFIXES.cause}_${crypto.randomUUID()}`);
  }
  subTopicId(): SubTopicId {
    return SubTopicId.parse(`${PREFIXES.subTopic}_${crypto.randomUUID()}`);
  }
  nodeId(): NodeId {
    return NodeId.parse(`${PREFIXES.node}_${crypto.randomUUID()}`);
  }
  edgeId(): EdgeId {
    return EdgeId.parse(`${PREFIXES.edge}_${crypto.randomUUID()}`);
  }
  proposalId(): ProposalId {
    return ProposalId.parse(`${PREFIXES.proposal}_${crypto.randomUUID()}`);
  }
  membershipId(): MembershipId {
    return MembershipId.parse(`${PREFIXES.membership}_${crypto.randomUUID()}`);
  }
  assignmentId(): AssignmentId {
    return AssignmentId.parse(`${PREFIXES.assignment}_${crypto.randomUUID()}`);
  }
  reviewVoteId(): ReviewVoteId {
    return ReviewVoteId.parse(`${PREFIXES.reviewVote}_${crypto.randomUUID()}`);
  }
}

// Deterministic counter-based IDs. Tests and the testbed get reproducible
// IDs without any branching in server code.
export class SeededIdGen implements IdGen {
  private counters = new Map<string, number>();
  constructor(private readonly seed: string = 'test') {}

  private next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${this.seed}_${String(n).padStart(4, '0')}`;
  }

  identityId(): IdentityId {
    return IdentityId.parse(this.next(PREFIXES.identity));
  }
  agentCredentialId(): AgentCredentialId {
    return AgentCredentialId.parse(this.next(PREFIXES.agentCredential));
  }
  causeId(): CauseId {
    return CauseId.parse(this.next(PREFIXES.cause));
  }
  subTopicId(): SubTopicId {
    return SubTopicId.parse(this.next(PREFIXES.subTopic));
  }
  nodeId(): NodeId {
    return NodeId.parse(this.next(PREFIXES.node));
  }
  edgeId(): EdgeId {
    return EdgeId.parse(this.next(PREFIXES.edge));
  }
  proposalId(): ProposalId {
    return ProposalId.parse(this.next(PREFIXES.proposal));
  }
  membershipId(): MembershipId {
    return MembershipId.parse(this.next(PREFIXES.membership));
  }
  assignmentId(): AssignmentId {
    return AssignmentId.parse(this.next(PREFIXES.assignment));
  }
  reviewVoteId(): ReviewVoteId {
    return ReviewVoteId.parse(this.next(PREFIXES.reviewVote));
  }
}
