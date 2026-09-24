// Package manifest defines the strict .factory.yaml contract for enrolled
// application repositories and the validation rules that enforce it.
//
// The manifest is a reviewed, immutable contract: unknown fields, mutable
// image references, path escapes, unsupported service names, and unsafe
// egress values all fail closed. The validator is stateless platform
// infrastructure; it never expands command strings or rewrites manifest
// values.
package manifest

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Manifest is the strict .factory.yaml contract. It contains exactly the
// fixed fields below; any additional key is a violation.
type Manifest struct {
	Version   int      `yaml:"version"`
	Agent     Agent    `yaml:"agent"`
	Commands  Commands `yaml:"commands"`
	Artifacts struct {
		Image string `yaml:"image"`
	} `yaml:"artifacts"`
	Services []string `yaml:"services"`
	Network  struct {
		EgressHosts []string `yaml:"egress_hosts"`
	} `yaml:"network"`
}

// Agent pins the agent runtime image.
type Agent struct {
	Image string `yaml:"image"`
}

// Commands are the four fixed contract scripts. Values are single
// repository-relative executable paths, never shell fragments or arguments.
type Commands struct {
	Bootstrap  string `yaml:"bootstrap"`
	Check      string `yaml:"check"`
	Build      string `yaml:"build"`
	BrowserTest string `yaml:"browser_test"`
}

// ErrField names the manifest path that violated a contract rule. A
// ManifestError carries one such path so a diagnostic can point at exactly
// what failed.
type ManifestError struct {
	Field   string
	Message string
}

func (e *ManifestError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

func newErr(field, msg string) error {
	return &ManifestError{Field: field, Message: msg}
}

// Load reads, decodes, and validates a .factory.yaml at manifestPath within
// worktree. projectRegistryPrefix is the namespace the image destination must
// stay inside.
func Load(worktree, manifestPath, projectRegistryPrefix string) (Manifest, error) {
	var m Manifest
	absWorktree, err := filepath.Abs(worktree)
	if err != nil {
		return m, fmt.Errorf("resolve worktree: %w", err)
	}
	var manifestAbs string
	if filepath.IsAbs(manifestPath) {
		manifestAbs = manifestPath
	} else {
		manifestAbs = filepath.Join(absWorktree, manifestPath)
	}
	data, err := os.ReadFile(manifestAbs)
	if err != nil {
		return m, fmt.Errorf("read manifest %s: %w", manifestPath, err)
	}

	dec := yaml.NewDecoder(strings.NewReader(string(data)))
	dec.KnownFields(true)
	if err := dec.Decode(&m); err != nil {
		var yamlErr *yaml.TypeError
		if errors.As(err, &yamlErr) {
			// Unknown keys or type mismatches surface as TypeErrors; surface
			// the offending fields.
			return m, fmt.Errorf("unknown or mistyped field in manifest: %s", strings.Join(yamlErr.Errors, "; "))
		}
		return m, fmt.Errorf("parse manifest %s: %w", manifestPath, err)
	}

	// A trailing second document after the manifest is malformed input;
	// reject it by attempting to decode another document.
	var trailing yaml.Node
	if err := dec.Decode(&trailing); err != io.EOF {
		return m, newErr("manifest", "multiple YAML documents are not allowed")
	}

	if err := Validate(m, worktree, projectRegistryPrefix); err != nil {
		return m, err
	}
	return m, nil
}
