import { PROTOCOL_VERSION } from '@anchorage/contracts';

export const SERVER_PROTOCOL_VERSION = PROTOCOL_VERSION;

export type { Caller, ResolvedCaller } from './auth.js';
export { type Clock, FakeClock, SystemClock } from './clock.js';
export { ServerError, type ServerErrorCode } from './errors.js';
export { type IdGen, RandomIdGen, SeededIdGen } from './id-gen.js';
export { buildMcpServer, type McpBuildOptions } from './mcp.js';
export { Server, type ServerDeps } from './server.js';
export { MemoryStore } from './store.js';
export { FakeVerifier, StructuralVerifier, type VerifiedRef, type Verifier } from './verifier.js';
