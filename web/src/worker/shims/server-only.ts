/**
 * esbuild alias target for the `server-only` package in the worker bundle.
 *
 * The real package throws on import unless the bundler sets the react-server
 * condition (Next does; esbuild for the worker does not). The worker runs in
 * plain Node with the service-role key by design, so the guard is moot here —
 * `--alias:server-only=./src/worker/shims/server-only.ts` swaps in this no-op.
 */
export {};
