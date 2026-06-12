import { z } from 'zod';
import { IdentityId, NodeId, ProposalId, SubTopicId } from './ids.js';
import { Timestamp } from './timestamps.js';

export const ExternalRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pmid'), value: z.string().regex(/^\d+$/) }).strict(),
  z.object({ kind: z.literal('doi'), value: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('url'), value: z.string().url() }).strict(),
]);
export type ExternalRef = z.infer<typeof ExternalRef>;

export const QuotedSpan = z
  .object({
    text: z.string().min(1),
    offset: z.number().int().nonnegative(),
  })
  .strict();
export type QuotedSpan = z.infer<typeof QuotedSpan>;

// Canonical bibliographic metadata observed from the resolved source at
// verification time (PubMed efetch / Crossref). This is server-observed,
// not contributor-asserted — the contributor's `content` is their free-
// text description and citation; this is what the source itself says it
// is. Surfacing the two side by side is what lets a reviewer's stake buy
// judgment (scope fit, faithful representation) instead of being spent
// re-deriving the citation by hand to catch a transposed author or a
// wrong cohort line. PRD §Verification engine (Canonical metadata).
//
// Every field is best-effort: resolvers return uneven records (a DOI
// with no author list, a PMID whose layout doesn't parse cleanly), so an
// unreadable field is simply omitted rather than blocking the write.
// `authors` is always an array (possibly empty); the rest are optional.
// Extraction never gates acceptance — a source with no parseable
// metadata still resolves and stages.
export const SourceMetadata = z
  .object({
    title: z.string().min(1).optional(),
    authors: z.array(z.string().min(1)),
    year: z.number().int().optional(),
    // Journal / venue ("container" in Crossref's vocabulary).
    container_title: z.string().min(1).optional(),
  })
  .strict();
export type SourceMetadata = z.infer<typeof SourceMetadata>;

export const NodeKind = z.enum(['anchor', 'excerpt', 'synthesis', 'open_question']);
export type NodeKind = z.infer<typeof NodeKind>;

// Persisted node lifecycle. `unresolvable` is reachable only by anchors whose
// content fails re-verification; the verification engine enforces that
// constraint, not the schema.
export const NodeStatus = z.enum(['staged', 'active', 'superseded', 'rejected', 'unresolvable']);
export type NodeStatus = z.infer<typeof NodeStatus>;

const nodeBase = {
  id: NodeId,
  home_sub_topic_id: SubTopicId,
  scope_memberships: z.array(SubTopicId),
  content: z.string().min(1),
  status: NodeStatus,
  created_by: IdentityId,
  created_at: Timestamp,
  updated_at: Timestamp,
  // The proposal whose acceptance materialized this node. The
  // node→proposal linkage is load-bearing for manuscript credit
  // (reviewer credit walks the votes on the materializing proposal,
  // PRD §Manuscript projection) and must not rest on inference —
  // the previous content-key join assumed a no-duplicate-content
  // invariant the tool boundary never enforced. Optional because
  // nodes materialized before the field existed carry none; the
  // credit walk falls back to the content-key join for those.
  proposal_id: ProposalId.optional(),
};

export const AnchorNode = z
  .object({
    ...nodeBase,
    kind: z.literal('anchor'),
    external_ref: ExternalRef,
    // sha-256 of the fetched source content; set by the server post-fetch and
    // compared on re-verification. Empty string is reserved for the
    // pre-fetch staged window and is not a valid persisted state.
    content_hash: z.string().min(1),
    // Wall-clock timestamp of the last successful verification of
    // `content_hash` against the live source. Set to the materialization
    // time on initial verify and bumped by the re-verification scheduler
    // on every fetch whose hash still matches. Drift transitions the
    // anchor to `unresolvable` and stops updating this field — the value
    // then records when the source was last *known good*. The scheduler
    // picks the oldest `last_verified_at` first; see PRD §Verification
    // engine (Re-verification).
    last_verified_at: Timestamp,
    // Canonical bibliographic metadata captured from the resolved source
    // at verification time (see SourceMetadata). Server-observed, not
    // contributor-asserted. Optional because extraction is best-effort
    // and because anchors materialized before this field existed carry
    // none; absence means "nothing parseable was captured", not "not yet
    // verified". PRD §Verification engine (Canonical metadata).
    source_metadata: SourceMetadata.optional(),
  })
  .strict();
export type AnchorNode = z.infer<typeof AnchorNode>;

export const ExcerptNode = z
  .object({
    ...nodeBase,
    kind: z.literal('excerpt'),
    quoted_span: QuotedSpan,
  })
  .strict();
export type ExcerptNode = z.infer<typeof ExcerptNode>;

export const SynthesisNode = z
  .object({
    ...nodeBase,
    kind: z.literal('synthesis'),
  })
  .strict();
export type SynthesisNode = z.infer<typeof SynthesisNode>;

export const OpenQuestionNode = z
  .object({
    ...nodeBase,
    kind: z.literal('open_question'),
  })
  .strict();
export type OpenQuestionNode = z.infer<typeof OpenQuestionNode>;

export const Node = z.discriminatedUnion('kind', [
  AnchorNode,
  ExcerptNode,
  SynthesisNode,
  OpenQuestionNode,
]);
export type Node = z.infer<typeof Node>;
