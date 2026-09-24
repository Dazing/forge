// Package protocol defines the wire contract between the orchestrator and
// factory-publisher over the Unix socket. A PublishRequest carries the
// project, issue, expected base SHA, patch archive path, and the
// deterministic branch name. The publisher validates all fields before
package protocol

import "fmt"

// PublishRequest is sent by the orchestrator to the publisher socket.
type PublishRequest struct {
	// ProjectID is the GitLab project ID.
	ProjectID int64 `json:"project_id"`
	// IssueIID is the project-local issue IID.
	IssueIID int64 `json:"issue_iid"`
	// BaseSHA is the immutable commit SHA the patch must apply against.
	BaseSHA string `json:"base_sha"`
	// PatchPath is the filesystem path to the patch archive (git format-patch
	// or unified diff bundle). The publisher reads this; the orchestrator
	// writes it to a root-owned temporary location before the request.
	PatchPath string `json:"patch_path"`
	// Branch is the target branch. Must be exactly `factory/p-{project_id}-i-{issue_iid}`.
	Branch string `json:"branch"`
	// PatchSHA256 is the SHA-256 of the patch archive; used for idempotency.
	PatchSHA256 string `json:"patch_sha256"`
	// IdempotencyKey is a unique key for this publish attempt. An identical
	// key with a different patch is rejected; an identical key with the same
	// patch is a no-op.
	IdempotencyKey string `json:"idempotency_key"`
}

// PublishResult is the response the publisher sends back over the socket.
type PublishResult struct {
	// Branch is the branch the patch was committed to (or would be).
	Branch string `json:"branch"`
	// HeadSHA is the commit SHA after the patch was applied.
	HeadSHA string `json:"head_sha,omitempty"`
	// IsNoop is true when the branch head was already at the expected state
	// and no new commit was made.
	IsNoop bool `json:"is_noop"`
	// Error is non-empty only when the request was rejected.
	Error string `json:"error,omitempty"`
}

// NewBranchName returns the deterministic branch name for a project/issue pair.
func NewBranchName(projectID, issueIID int64) string {
	return fmt.Sprintf("factory/p-%d-i-%d", projectID, issueIID)
}
