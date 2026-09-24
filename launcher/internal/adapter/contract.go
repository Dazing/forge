// Package adapter defines the harness process-adapter contract that
// factory-launcher uses to run agent roles. The contract is fixed by
// technical design §8.3: run(role, workspace, task.json, policy.json)
// produces events.jsonl, result.json, exit.json, and workspace.diff.
//
// The launcher does not select a harness; it delegates to an adapter that
// implements Contract.
package adapter

import "context"

// Role is the agent role to run.
type Role string

// The set of roles defined by the factory.
const (
	RolePlan            Role = "plan"
	RoleImplement       Role = "implement"
	RoleRepair          Role = "repair"
	RoleReview          Role = "review"
	RoleReleaseReview   Role = "release_review"
	RoleExploratoryBrowser Role = "exploratory_browser"
)

// AdapterResult captures the outputs of a completed adapter run.
type AdapterResult struct {
	// EventsJSONL is the bounded JSONL tool-event stream.
	EventsJSONL []byte
	// ResultJSON is the structured role result (e.g. validated plan, review verdict).
	ResultJSON []byte
	// ExitJSON is the exit classification (normal, timeout, error, ...).
	ExitJSON []byte
	// WorkspaceDiff is the unified diff of the workspace since the base SHA.
	WorkspaceDiff []byte
}

// Contract is the process-adapter interface implemented by each supported
// harness (OpenHands headless, OpenCode, ...). The launcher dispatches a
// single run through this contract and collects the four output artifacts.
//
// taskJSON and policyJSON are the canonical task and policy documents,
// both signed by the orchestrator and included in the run spec.
type Contract interface {
	// Run executes one agent role and returns the four output artifacts.
	// The workspace is the mount point for the agent's source checkout.
	// The adapter must not modify files outside workspace.
	Run(ctx context.Context, role Role, workspace string, taskJSON []byte, policyJSON []byte) (AdapterResult, error)
}
