# Sandcastle replacement plan

## Outcome

Replace the custom factory engine with a small adaptation of [Matt Pocock's Sandcastle runner](https://github.com/mattpocock/sandcastle/blob/main/.sandcastle/run.ts). Keep the local sample projects, Markdown tickets, skills, and independent result evaluators. Run Pi against the configured local OpenAI-compatible endpoint; do not recreate factory stages, protected-test infrastructure, recovery policy, publication contracts, or report schemas.

Upstream runner inspected on 2026-10-09; GitHub reports run.ts blob `58def9aeddc8680067711fe3a5399509926d1bb0`. The local adaptation now uses Sandcastle's Pi provider.

## Runner contract

- Use `.sandcastle/run.ts` and adjacent planner, implementer, reviewer, and merger prompts.
- Retain upstream Docker Sandcastle execution, ten planning iterations, four concurrent workers, per-branch implementation/review sandbox reuse, and the final merge phase. Use Pi with model ID `vllm-qwen38-27b` through the local OpenAI-compatible endpoint.
- Read Markdown tickets from disk rather than calling GitHub. Accept explicit ticket paths and a target repository; provide a documented scenario command using the existing fixture/ticket mapping.
- A scenario targets its own materialized sample repository. These are independent baselines, not successive tickets against one inventory project. Never merge branches from different scenario repositories together.
- Feed actual ticket contents and stable local ticket identifiers to the planner and implementation/review prompts. Only accept planned work drawn from the supplied ticket set. Use deterministic branch names and track completed tickets within the invocation so the next iteration does not repeat merged work. Remove GitHub issue-list, issue-view, and issue-close instructions.
- Preserve upstream merge behavior in the disposable target repository, not in the factory source checkout. Report failure if implementation, review, or merge fails; commits alone must not conceal failed execution. No new stage-report protocol.
- Supply existing skills to every agent stage at Pi's native `~/.pi/agent/skills/` location and require relevant skill loading in each prompt. Keep `standards/skills/` as the source of truth, including referenced companion files; no new skill framework. Align sample repository instructions with the supplied skill location.
- Provide the .NET 10 environment required by the samples in the Docker runtime. Use host networking so the container can resolve the tailnet endpoint and use the host's Tailscale routes. Configure Pi through a read-only `models.json`; no Claude Code or obsolete engine adapter remains.
- Keep proof expected solutions and evaluators outside the target agent workspace. Evaluation is an external check, not a new orchestration engine.

## Retained and removed surfaces

| Surface | Decision |
|---|---|
| `samples/` | Keep all projects and tickets. Only adjust obsolete agent-instruction paths where needed. |
| `standards/skills/` | Keep skills and supporting files. Adapt access/instructions to the runner. |
| `proof/expected/` | Keep expected solutions as evaluator positive controls. |
| `proof/evaluators/` | Keep standalone feature, bug, refactor, VSA, and allocation checks plus StructureEvaluator. Remove the engine-report-specific recovery-exhaustion evaluator. |
| `proof/harness/fulfillment_routing_stub.py` | Keep; the standalone API evaluator imports it. |
| Fixture materialization and scenario metadata | Keep minimal useful preparation and ticket/fixture/evaluator mappings. Remove engine-stage fault metadata and prevent materialization from silently deleting an existing destination. |
| Other proof harness files | Retain only dependencies needed by standalone evaluation/preparation; remove engine-run, fault-injection, trusted-stage, and engine-specific test machinery. |
| Recovery sample projects/ticket | Keep as requested; no longer claim bounded-recovery proof because that engine policy is removed. |
| `packages/`, `apps/` | Delete completely. |
| Old engine tests, dependency-boundary checker, config, container | Remove or replace as directly required by the small runner. No compatibility aliases. |
| Root npm/TypeScript configuration | Remove workspace/package wiring and unused dependencies. Keep scripts for running, preparing, evaluating, and typechecking the retained implementation. |
| Old factory documentation | Replace obsolete instructions and guarantees. Keep this plan and concise current usage/evaluation documentation; Git history preserves the old design. |

## Implementation slices

1. **Runner and runtime:** `.sandcastle/`, root npm/TypeScript configuration, and replacement Docker runtime. Implement upstream-style local-ticket execution and skill access. Own the runner interface and communicate exact invocation/paths to the evaluation slice.
2. **Evaluation and cutover:** `proof/`, removal of `packages/`, `apps/`, old engine tooling/config/tests/docs, sample instruction path updates, and README. Preserve fixture behavior and standalone evaluators; adapt scenario preparation and document commands against the runner interface.

Use independent implementation subagents with disjoint ownership. The parent integrates interfaces, refreshes the lockfile, and runs verification after both slices finish. No builds/tests/formatters during delegated edits.

## Verification and acceptance

1. Install dependencies and run the retained TypeScript check once integration is complete.
2. Exercise the actual local-ticket command's help/input path and prepare a real disposable Git fixture. Prove the expected ticket, sample mapping, and skills are available using the real preparation path. Confirm an existing destination is not destroyed.
3. Run each of the five independent evaluator modes against its expected solution (must pass) and corresponding baseline (must fail for unmet ticket behavior, not missing tooling). Preserve evaluator output as evidence; do not weaken checks to accommodate the replacement.
4. Run the Docker/Sandcastle command on a sample when Docker is available. Observe actual ticket loading, skill access, implementation/review, and merge. If Docker is unavailable, exercise Pi directly against the configured model and report the exact container-runtime blocker; a host Pi smoke test does not establish container startup.
5. Check that retained executable tooling, configuration, and documentation no longer depend on removed engine packages or advertise Claude Code, protected acceptance, PR artifact, or publication guarantees.
6. Final delivery lists the new invocation, kept/deleted surfaces, exercised verification, and any real-runtime blocker. No fabricated successful model proof.
