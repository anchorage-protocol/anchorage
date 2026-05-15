// `ServerError` and its typed `ServerErrorCode` enum moved to
// `@anchorage/contracts` in slice 5b so packages that catch on the
// wire (web tier, future federated peers) can `instanceof`-check
// without taking a runtime dependency on the server. The re-export
// here keeps the historical import path stable for the server,
// testbed, and any external consumer of `@anchorage/server` that
// already binds to the symbol; they continue to import from this
// module unchanged.
export { ServerError, type ServerErrorCode } from '@anchorage/contracts';
