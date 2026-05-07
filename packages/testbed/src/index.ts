import { PROTOCOL_VERSION } from '@anchorage/contracts';

export const TESTBED_PROTOCOL_VERSION = PROTOCOL_VERSION;

export { AnchorageClient, AnchorageClientError } from './client.js';
export {
  type ContentForExcerpt,
  type ContentProvider,
  type HonestStrongAction,
  type HonestStrongConfig,
  type HonestStrongResult,
  runHonestStrong,
} from './archetypes/honest-strong.js';
export {
  acceptAllDecider,
  type HonestReviewerAction,
  type HonestReviewerConfig,
  type HonestReviewerResult,
  payloadBiasedDecider,
  type PayloadBiasedDeciderConfig,
  rejectAllDecider,
  type ReviewDecider,
  type ReviewDecisionWithRationale,
  runHonestReviewer,
} from './archetypes/honest-reviewer.js';
export {
  constantFabricator,
  type HallucinatedExcerpt,
  type HallucinationFabricator,
  type HallucinatorAction,
  type HallucinatorConfig,
  type HallucinatorResult,
  runHallucinator,
} from './archetypes/hallucinator.js';
