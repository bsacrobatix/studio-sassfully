// Opt-in demo mode for hosts that embed sassfully directly: exposes the
// narrated-demo surface (window.__sassfullyDemo + optional origin-allowlisted
// postMessage channel) from @sassfully/demo-player. NEVER on by default —
// mountReporter only reaches this module when the host passes
// {demoMode: true}, and the postMessage channel additionally requires a
// non-empty demoOrigins allowlist.
//
// The sibling package is imported by RELATIVE path, not package name: the
// example host page loads this SDK as native browser ES modules straight from
// the repo tree (no bundler, no import map), and the same relative specifier
// resolves identically under node and under examples/host-page/serve.mjs.
export async function enableDemoMode({ window, document, allowedOrigins = [], executeAction, speak, narrationUrl, mountStageLayer, embeddedBridge, onStepEvent } = {}) {
  const { installDemoEmbed } = await import("../../demo-player/src/embed.mjs");
  return installDemoEmbed({ window, document, allowedOrigins, executeAction, speak, narrationUrl, mountStageLayer, embeddedBridge, onStepEvent });
}
