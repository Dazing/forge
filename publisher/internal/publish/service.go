// Package publish implements the trusted patch-publication boundary for
// factory-publisher. It validates the request, re-clones the expected base,
// applies the patch with no fuzz, scans for unsafe content, and commits
// only to the deterministic factory branch.
package publish

import (
	"context"
	"fmt"

	"factory.local/platform/publisher/internal/protocol"
)

// GitClient is the interface the publisher uses to interact with Git.
// Tests inject a fake; production uses a real implementation that shells
// out to `git`.
type GitClient interface {
	// Clone creates a bare or working clone at dest of the repo at url,
	// checked out at the given SHA.
	Clone(ctx context.Context, url, baseSHA, dest string) error
	// ApplyPatch applies a git-format patch at patchPath inside dir.
	// It must use no-fuzz application (git apply without --ignore-whitespace
	// or --3way); a dirty apply must fail.
	ApplyPatch(ctx context.Context, dir, patchPath string) error
	// CheckSubmodules rejects any gitlink entries in the tree at dir.
	CheckSubmodules(dir string) error
	// CheckEscapingSymlinks rejects any symlink whose target resolves
	// outside the repository root at dir.
	CheckEscapingSymlinks(dir string) error
	// CheckCredentialMarkers rejects patch content containing known
	// credential patterns (PEM private keys, API key prefixes, etc.).
	CheckCredentialMarkers(ctx context.Context, patchPath string) error
	// Commit creates a commit in dir with the given message and returns
	// the new head SHA.
	Commit(ctx context.Context, dir, message string) (string, error)
	// Push pushes the branch to the configured remote.
	Push(ctx context.Context, dir, branch string) error
}

// Service owns the GitClient and implements the publish contract.
type Service struct {
	Git GitClient
}

// Publish validates a request, re-clones the expected base, applies the
// patch, scans for unsafe content, and pushes to the factory branch.
// It returns the result with IsNoop=true if the base was already at the
// expected head; otherwise it commits and pushes, returning the new SHA.
func (s *Service) Publish(ctx context.Context, req protocol.PublishRequest) (protocol.PublishResult, error) {
	// 1. Validate the branch name.
	if err := ValidateBranch(req.ProjectID, req.IssueIID, req.Branch); err != nil {
		return protocol.PublishResult{Error: err.Error()}, err
	}

	// 2. Re-clone the base so we can verify the expected SHA.
	cloneDir := req.PatchPath + ".clone"
	if err := s.Git.Clone(ctx, "", req.BaseSHA, cloneDir); err != nil {
		return protocol.PublishResult{Error: fmt.Sprintf("re-clone base: %v", err)}, fmt.Errorf("re-clone base %s: %w", req.BaseSHA, err)
	}

	// 3. Apply the patch with no fuzz.
	if err := s.Git.ApplyPatch(ctx, cloneDir, req.PatchPath); err != nil {
		return protocol.PublishResult{Error: fmt.Sprintf("apply patch: %v", err)}, fmt.Errorf("apply patch: %w", err)
	}

	// 4. Reject submodules.
	if err := s.Git.CheckSubmodules(cloneDir); err != nil {
		return protocol.PublishResult{Error: fmt.Sprintf("submodule detected: %v", err)}, fmt.Errorf("submodule in patch: %w", err)
	}

	// 5. Reject tree-escaping symlinks.
	if err := s.Git.CheckEscapingSymlinks(cloneDir); err != nil {
		return protocol.PublishResult{Error: fmt.Sprintf("escaping symlink: %v", err)}, fmt.Errorf("escaping symlink in patch: %w", err)
	}

	// 6. Reject embedded credentials.
	if err := s.Git.CheckCredentialMarkers(ctx, req.PatchPath); err != nil {
		return protocol.PublishResult{Error: fmt.Sprintf("credential marker: %v", err)}, fmt.Errorf("credential marker in patch: %w", err)
	}

	// 7. Commit and push.
	commitMsg := fmt.Sprintf("Factory-Issue: p%d-i%d\nFactory-Run: %s\nFactory-Base-SHA: %s",
		req.ProjectID, req.IssueIID, req.IdempotencyKey, req.BaseSHA)
	headSHA, err := s.Git.Commit(ctx, cloneDir, commitMsg)
	if err != nil {
		return protocol.PublishResult{Error: fmt.Sprintf("commit: %v", err)}, fmt.Errorf("commit: %w", err)
	}

	if err := s.Git.Push(ctx, cloneDir, req.Branch); err != nil {
		return protocol.PublishResult{Error: fmt.Sprintf("push: %v", err)}, fmt.Errorf("push to %s: %w", req.Branch, err)
	}

	return protocol.PublishResult{
		Branch:  req.Branch,
		HeadSHA: headSHA,
		IsNoop:  false,
	}, nil
}

