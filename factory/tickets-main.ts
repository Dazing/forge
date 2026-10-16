import { runTicketsSubmission } from "./cli/tickets-cli.js";

// Composition root for `npm run tickets -- submit` (plan §3 D3): the local submission client. It reads
// explicit ticket paths and the client backlog settings, publishes them into the private GitHub backlog,
// and exits 0 (everything applied), 1 (a ticket failed), or 2 (usage, configuration, lock, or privacy
// gate refusal with zero writes). It is deliberately separate from main.ts: no daemon, no sandbox
// preflight, no agent runtime, no target-repository writes, and help works with no credentials at all.

process.exitCode = await runTicketsSubmission({ argv: process.argv.slice(2), env: process.env });
