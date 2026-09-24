// Command factory-assets-validate deterministically checks an agent-assets
// bundle for the conditions the protected asset pipeline rejects before
// packaging. It prints one diagnostic per line and exits non-zero when any
// are found.
//
// Usage:
//
//	factory-assets-validate -root <dir>
//
// root is the directory that contains manifest.yaml. The default "." assumes
// the bundle is the current directory.
package main

import (
	"flag"
	"fmt"
	"os"

	"factory.local/platform/agent-assets/internal/validate"
)

func main() {
	root := flag.String("root", ".", "bundle root: the directory that contains manifest.yaml")
	flag.Parse()

	diags := validate.Bundle(*root)
	if len(diags) == 0 {
		fmt.Println("factory-assets-validate: bundle valid")
		return
	}
	for _, d := range diags {
		// One diagnostic per line; the file field is omitted for
		// whole-bundle findings so output stays stable.
		if d.File != "" {
			fmt.Fprintf(os.Stderr, "factory-assets-validate: %s: [%s] %s\n", d.File, d.Rule, d.Message)
		} else {
			fmt.Fprintf(os.Stderr, "factory-assets-validate: [%s] %s\n", d.Rule, d.Message)
		}
	}
	fmt.Fprintf(os.Stderr, "factory-assets-validate: %d diagnostic(s) found\n", len(diags))
	os.Exit(1)
}
