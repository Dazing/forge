// Import-graph enforcement for the flat feature layout (plan §7).
// Features enter other features only through index.ts; stage features stay isolated from
// ticket-processing and each other; infrastructure and shared stay host- and feature-free.

const STAGE = "plan-tickets|implement-ticket|review-ticket|integrate-tickets|publish-pull-request";

module.exports = {
  forbidden: [
    {
      name: "feature-boundaries",
      severity: "error",
      comment: "features may enter other features only through index.ts (type-only imports included)",
      from: { path: "^factory/features/([^/]+)/" },
      to: { path: "^factory/features/(?!$1/)[^/]+/(?!index\\.[jt]s$)" },
    },
    {
      name: "stage-features-isolated",
      severity: "error",
      comment: "stage features cannot import other stage features or ticket-processing, not even via index.ts",
      from: { path: `^factory/features/(${STAGE})/` },
      to: { path: "^factory/features/(?!tickets/index\\.[jt]s$)", pathNot: "^factory/features/$1/" },
    },
    {
      name: "tickets-leaf",
      severity: "error",
      comment: "tickets cannot import processing, stages, or any other feature",
      from: { path: "^factory/features/tickets/" },
      to: { path: "^factory/features", pathNot: "^factory/features/tickets" },
    },
    {
      name: "infrastructure-host-free",
      severity: "error",
      comment: "infrastructure cannot import features, main.ts, or CLI",
      from: { path: "^factory/infrastructure/" },
      to: { path: "^factory/(features|main\\.ts|cli)" },
    },
    {
      name: "shared-pure",
      severity: "error",
      comment: "shared cannot import features, infrastructure, or host/CLI code",
      from: { path: "^factory/shared/" },
      to: { path: "^factory/(features|infrastructure|main\\.ts|cli)" },
    },
    {
      name: "features-host-free",
      severity: "error",
      comment: "features cannot import main.ts, tickets-main.ts, or CLI",
      from: { path: "^factory/features/" },
      to: { path: "^factory/(main\\.ts|tickets-main\\.ts|cli)" },
    },
    {
      name: "tickets-entry",
      severity: "error",
      comment: "the submission host enters features only through index.ts and never the server host, ticket-processing, or a stage feature",
      from: { path: "^factory/tickets-main\\.ts$" },
      to: {
        path: "^factory/",
        pathNot: "^(factory/cli/|factory/features/(submit-tickets|tickets)/index\\.[jt]s$|factory/infrastructure/)",
      },
    },
    {
      name: "submit-tickets-boundaries",
      severity: "error",
      comment: "submit-tickets enters tickets only through index.ts and never the host, CLI, ticket-processing, or a stage feature",
      from: { path: "^factory/features/submit-tickets/" },
      to: {
        path: "^factory/",
        pathNot: "^(factory/features/submit-tickets/|factory/features/tickets/index\\.[jt]s$|factory/shared/|factory/infrastructure/)",
      },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "local imports must resolve to files on disk",
      from: { path: "^factory/" },
      to: { dependencyTypes: ["local"], path: "^(?!node:)", couldNotResolve: true },
    },
    {
      name: "no-cyclic",
      severity: "error",
      comment: "module dependencies must be acyclic",
      from: { path: "^factory/" },
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    exclude: { path: "factory/infrastructure/agent-runtime/skills" },
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};
