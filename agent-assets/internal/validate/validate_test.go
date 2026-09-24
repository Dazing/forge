package validate

import (
	"path/filepath"
	"testing"
)

// hasRule reports whether diags contains a diagnostic with rule r.
func hasRule(diags []Diagnostic, r string) bool {
	for _, d := range diags {
		if d.Rule == r {
			return true
		}
	}
	return false
}

// wantRules reports whether diags contains every rule in want.
func wantRules(t *testing.T, diags []Diagnostic, want ...string) {
	t.Helper()
	missing := []string{}
	for _, r := range want {
		if !hasRule(diags, r) {
			missing = append(missing, r)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("expected diagnostics with rules %v; got %d diagnostics: %v", want, len(diags), diags)
	}
}

// TestBundle_ValidBundle passes on the checked-in valid fixture.
func TestBundle_ValidBundle(t *testing.T) {
	root := filepath.Join("..", "..", "testdata", "valid")
	if diags := Bundle(root); len(diags) != 0 {
		t.Fatalf("expected no diagnostics for the valid bundle, got %v", diags)
	}
}

// TestBundle_RejectionClasses runs each checked-in invalid fixture and asserts
// the specific rule the mutation should trip. Each fixture mutates exactly one
// class of the valid bundle, so the test pins that the validator catches each
// forbidden condition.
func TestBundle_RejectionClasses(t *testing.T) {
	cases := []struct {
		fixture string
		rules   []string
	}{
		{"invalid-frontmatter", []string{"frontmatter"}},
		{"invalid-schema", []string{"schema"}},
		{"invalid-path", []string{"path"}},
		{"invalid-reference", []string{"reference"}},
		{"invalid-size", []string{"size"}},
		{"invalid-symlink", []string{"symlink"}},
		{"invalid-secret", []string{"secret"}},
		{"invalid-allowlist", []string{"allowlist"}},
		{"invalid-manifest", []string{"manifest"}},
	}
	for _, c := range cases {
		t.Run(c.fixture, func(t *testing.T) {
			root := filepath.Join("..", "..", "testdata", c.fixture)
			diags := Bundle(root)
			if len(diags) == 0 {
				t.Fatalf("fixture %s produced no diagnostics; expected at least %v", c.fixture, c.rules)
			}
			wantRules(t, diags, c.rules...)
		})
	}
}

// TestBundle_MissingRoot reports a root finding when the bundle root does not
// exist, rather than panicking.
func TestBundle_MissingRoot(t *testing.T) {
	diags := Bundle(filepath.Join("..", "..", "testdata", "does-not-exist"))
	wantRules(t, diags, "root")
}
