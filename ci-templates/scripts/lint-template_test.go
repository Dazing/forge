package scripts

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// TestLintTemplate_Valid runs the lint-template script against the checked-in
// application-v1.yml template and requires it to pass.
func TestLintTemplate_Valid(t *testing.T) {
	lintScript, err := filepath.Abs("lint-template")
	if err != nil {
		t.Fatalf("resolve lint script: %v", err)
	}
	template, err := filepath.Abs(filepath.Join("..", "templates", "application-v1.yml"))
	if err != nil {
		t.Fatalf("resolve template: %v", err)
	}
	cmd := exec.Command("sh", lintScript, template)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("lint-template failed:\n%s", out)
	}
}
