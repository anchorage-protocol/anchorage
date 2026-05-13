import { PROTOCOL_VERSION } from '@anchorage/contracts';

export const TESTBED_PROTOCOL_VERSION = PROTOCOL_VERSION;

export {
  constantFabricator,
  type HallucinatedExcerpt,
  type HallucinationFabricator,
  type HallucinatorAction,
  type HallucinatorConfig,
  type HallucinatorResult,
  runHallucinator,
} from './archetypes/hallucinator.js';
export {
  acceptAllDecider,
  type HonestReviewerAction,
  type HonestReviewerConfig,
  type HonestReviewerResult,
  type PayloadBiasedDeciderConfig,
  type PayloadDecliningDeciderConfig,
  payloadBiasedDecider,
  payloadDecliningDecider,
  type ReviewDecider,
  type ReviewDecisionWithRationale,
  rejectAllDecider,
  reviseAllDecider,
  runHonestReviewer,
} from './archetypes/honest-reviewer.js';
export {
  type ContentForExcerpt,
  type ContentProvider,
  type HonestStrongAction,
  type HonestStrongConfig,
  type HonestStrongResult,
  runHonestStrong,
} from './archetypes/honest-strong.js';
export {
  type HonestWeakAction,
  type HonestWeakConfig,
  type HonestWeakResult,
  runHonestWeak,
} from './archetypes/honest-weak.js';
export {
  type FetchLike,
  type LlmAgentConfig,
  type LlmAgentResult,
  type LlmAgentTurn,
  runLlmAgent,
} from './archetypes/llm-agent.js';
export {
  type AdversaryRoleOptions,
  honestStrongRole,
  type LlmRole,
  type LlmRoleId,
  llmRole,
  patientAdversaryRole,
  strategicAdversaryRole,
} from './archetypes/llm-roles.js';
export {
  type CassetteEntry,
  type CassetteMode,
  type RecordingFetchOptions,
  recordingFetch,
} from './archetypes/recording-fetch.js';
export { AnchorageClient, AnchorageClientError } from './client.js';
