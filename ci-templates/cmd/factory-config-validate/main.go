// Command factory-config-validate loads and validates a .factory.yaml
// manifest against the fixed Phase 0 CI contract. It exits non-zero with a
// path-specific diagnostic when the manifest is unsafe.
//
// Usage:
//
//	factory-config-validate -worktree <dir> -manifest <path> -registry-prefix <namespace>
//
// The manifest path is resolved relative to the current directory when not
// absolute. Worktree is the application repository root that command paths
// resolve against; registry-prefix is the namespace the image destination
// must stay inside.
package main

import (
	"flag"
	"fmt"
	"os"

	"factory.local/platform/ci-templates/internal/manifest"
)

func main() {
	var worktree, manifestPath, registryPrefix string
	flag.StringVar(&worktree, "worktree", ".", "application repository root that command paths resolve against")
	flag.StringVar(&manifestPath, "manifest", ".factory.yaml", "path to the .factory.yaml manifest")
	flag.StringVar(&registryPrefix, "registry-prefix", "", "project registry namespace the image destination must stay inside")
	flag.Parse()

	if registryPrefix == "" {
		fmt.Fprintln(os.Stderr, "factory-config-validate: -registry-prefix is required")
		flag.Usage()
		os.Exit(2)
	}

	if _, err := manifest.Load(worktree, manifestPath, registryPrefix); err != nil {
		fmt.Fprintf(os.Stderr, "factory-config-validate: manifest invalid: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("factory-config-validate: manifest valid")
}
