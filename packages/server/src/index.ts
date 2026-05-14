import { PROTOCOL_VERSION } from '@anchorage/contracts';

export const SERVER_PROTOCOL_VERSION = PROTOCOL_VERSION;

export {
  type AdminCliDeps,
  type AdminCliResult,
  makeProductionServer,
  runAdminCli,
} from './admin-cli.js';
export {
  type Authenticator,
  type Caller,
  HarnessAuthenticator,
  type ResolvedCaller,
} from './auth.js';
export {
  computeGithubAttestationLevel,
  FakeGithubApi,
  type FakeGithubScenario,
  type GithubApi,
  GithubApiHttp,
  type GithubApiHttpOpts,
  type GithubDeviceCode,
  type GithubEmailInfo,
  GithubOAuthAuthenticator,
  type GithubOAuthAuthenticatorOpts,
  type GithubPollStatus,
  type GithubSigninResult,
  type GithubUser,
} from './auth-github.js';
export { type Clock, FakeClock, SystemClock } from './clock.js';
export { ServerError, type ServerErrorCode } from './errors.js';
export {
  type AnchorageHttpHandler,
  type AnchorageHttpOpts,
  type AnchorageHttpServer,
  buildHttpHandler,
  type StartHttpServerOpts,
  startHttpServer,
} from './http.js';
export { type IdGen, RandomIdGen, SeededIdGen } from './id-gen.js';
export {
  LiveFetchVerifier,
  type LiveFetchVerifierOpts,
  type VerifierFetch,
  type VerifierResponse,
} from './live-fetch-verifier.js';
export { buildMcpServer, type McpBuildOptions } from './mcp.js';
export { Server, type ServerDeps } from './server.js';
export { SqliteStore, type SqliteStoreOptions } from './sqlite-store.js';
export { type MapLike, MemoryStore, type Store } from './store.js';
export {
  FakeVerifier,
  normalizeForSpanMatch,
  StructuralVerifier,
  type VerifiedRef,
  type Verifier,
} from './verifier.js';
