package publish

import (
	"fmt"

	"factory.local/platform/publisher/internal/protocol"
)

// ValidateBranch ensures the requested branch is exactly the deterministic
// factory branch name for the given project and issue. Any other branch,
// including `main`, protected branches, or arbitrary names, is rejected.
func ValidateBranch(projectID, issueIID int64, branch string) error {
	expected := protocol.NewBranchName(projectID, issueIID)
	if branch != expected {
		return fmt.Errorf("branch %q is not the factory branch %q", branch, expected)
	}
	// Also enforce the factory/ prefix explicitly so a future NewBranchName
	// change cannot silently widen the allowed set.
	if len(branch) < 8 || branch[:8] != "factory/" {
		return fmt.Errorf("branch %q is outside the factory/* namespace", branch)
	}
	return nil
}
