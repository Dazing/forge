package manifest

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// supportedServices is the initial protected platform service catalog. The
// launcher resolves each name to a pinned image digest, synthetic environment,
// health check, and resource limit. Names not in this catalog fail closed
// until a trusted catalog update adds them.
var supportedServices = map[string]bool{
	"postgres-test": true,
	"redis-test":    true,
}

// internalSuffixes are reserved name suffixes for factory control surfaces
// (GitLab, registry, inference, hypervisor, deployment networks). A public
// egress host must never end with one of these.
var internalSuffixes = []string{
	".internal",
	".local",
	".lan",
	".home.arpa",
	".arpa",
	".corporate",
	".intranet",
}

// hostnamePattern matches a syntactically valid DNS hostname: dotted labels
// of alphanumerics and hyphens, no leading/trailing hyphen.
var hostnamePattern = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

// Validate enforces every fixed .factory.yaml rule against m. worktree is the
// application repository root that command paths resolve against, and
// projectRegistryPrefix is the registry namespace the image destination must
// stay inside.
func Validate(m Manifest, worktree, projectRegistryPrefix string) error {
	// version
	if m.Version != 1 {
		return newErr("version", fmt.Sprintf("unsupported version %d; only 1 is accepted", m.Version))
	}

	// agent.image must be digest-pinned
	if err := validateAgentImage(m.Agent.Image); err != nil {
		return newErr("agent.image", err.Error())
	}

	// image destination must stay inside the project registry namespace
	if err := validateImageDestination(m.Artifacts.Image, projectRegistryPrefix); err != nil {
		return newErr("artifacts.image", err.Error())
	}

	// command paths
	commands := []struct {
		field string
		path  string
	}{
		{"commands.bootstrap", m.Commands.Bootstrap},
		{"commands.check", m.Commands.Check},
		{"commands.build", m.Commands.Build},
	}
	for _, c := range commands {
		if err := validateCommand(c.path, worktree, c.field); err != nil {
			return err
		}
	}
	// browser_test is optional; validate only when declared.
	if m.Commands.BrowserTest != "" {
		if err := validateCommand(m.Commands.BrowserTest, worktree, "commands.browser_test"); err != nil {
			return err
		}
	}

	// services must all come from the protected catalog
	for i, s := range m.Services {
		if !supportedServices[s] {
			return newErr(fmt.Sprintf("services[%d]", i), fmt.Sprintf("unsupported service %q; only catalog services are accepted", s))
		}
	}

	// egress hosts must be exact public hostnames
	for i, h := range m.Network.EgressHosts {
		if reason, ok := unsafeEgressHost(h); ok {
			return newErr(fmt.Sprintf("network.egress_hosts[%d]", i), reason)
		}
	}

	return nil
}

// validateAgentImage requires an OCI digest reference (@sha256:...). Floating
// tags and non-SHA-256 digests are mutable and rejected.
func validateAgentImage(image string) error {
	if image == "" {
		return fmt.Errorf("agent image is required")
	}
	if !strings.Contains(image, "@sha256:") {
		return fmt.Errorf("image %q is not digest-pinned; only @sha256: digests are accepted", image)
	}
	// The digest portion after @sha256: must be a 64-character lowercase hex
	// value, i.e. a complete SHA-256.
	digest := image[strings.Index(image, "@sha256:")+len("@sha256:"):]
	if !isSHA256Hex(digest) {
		return fmt.Errorf("image %q does not carry a complete SHA-256 digest", image)
	}
	return nil
}

// isSHA256Hex reports whether s is a 64-character lowercase hexadecimal
// SHA-256 digest.
func isSHA256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// validateImageDestination rejects an image destination outside the supplied
// project registry namespace.
func validateImageDestination(dest, prefix string) error {
	if dest == "" {
		return fmt.Errorf("image destination is required")
	}
	if !strings.HasPrefix(dest, prefix) {
		return fmt.Errorf("image destination %q is outside the project registry namespace %q", dest, prefix)
	}
	// A bare prefix match on a shared prefix (e.g. "apps/example" vs
	// "apps/example-evil") must not be mistaken for containment. The
	// destination must equal the prefix or extend it as a registry path
	// segment.
	remainder := dest[len(prefix):]
	if remainder != "" && !strings.HasPrefix(remainder, "/") {
		return fmt.Errorf("image destination %q is not a registry path within namespace %q", dest, prefix)
	}
	return nil
}

// validateCommand enforces that a command value is a single worktree-relative
// executable path: it begins with ./, contains no .., no arguments or shell
// fragments, resolves to a regular file inside the worktree, and is
// executable. Symlinks that escape the worktree are rejected.
func validateCommand(path, worktree, field string) error {
	if path == "" {
		return newErr(field, "command path is required")
	}
	if !strings.HasPrefix(path, "./") {
		return newErr(field, fmt.Sprintf("command path %q must be worktree-relative and begin with ./", path))
	}
	if strings.Contains(path, "..") {
		return newErr(field, fmt.Sprintf("command path %q must not contain .. (path escape)", path))
	}
	if strings.ContainsAny(path, " \t;|&$`<>()") {
		return newErr(field, fmt.Sprintf("command path %q must be a single path with no arguments or shell fragments", path))
	}

	absWorktree, err := filepath.Abs(worktree)
	if err != nil {
		return newErr(field, fmt.Sprintf("resolve worktree: %v", err))
	}
	target := filepath.Join(absWorktree, path)

	// Symlink-escape check: resolve the path and ensure it stays inside the
	// worktree.
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		if os.IsNotExist(err) {
			return newErr(field, fmt.Sprintf("command path %q does not exist", path))
		}
		return newErr(field, fmt.Sprintf("resolve command path %q: %v", path, err))
	}
	if !isWithin(resolved, absWorktree) {
		return newErr(field, fmt.Sprintf("command path %q resolves outside the worktree", path))
	}

	info, err := os.Stat(target)
	if err != nil {
		return newErr(field, fmt.Sprintf("command path %q is not a regular file: %v", path, err))
	}
	if info.Mode()&0111 == 0 {
		return newErr(field, fmt.Sprintf("command path %q is not executable", path))
	}
	return nil
}

// isWithin reports whether p is inside (or equal to) root, both absolute and
// evaluated through symlinks where possible.
func isWithin(p, root string) bool {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return rel == "." || !strings.HasPrefix(rel, "..")
}

// unsafeEgressHost returns a non-empty reason (and true) when host is not an
// exact public DNS hostname. It rejects empty values, URL schemes/paths,
// wildcards, IP literals (including RFC1918, link-local, loopback, and
// Tailscale/CGNAT ranges), localhost, and internal control-surface suffixes.
func unsafeEgressHost(host string) (string, bool) {
	if strings.TrimSpace(host) == "" {
		return "egress host is empty", true
	}
	// URL schemes or paths are not hostnames.
	if strings.Contains(host, "://") || strings.Contains(host, "/") || strings.Contains(host, ":") {
		return fmt.Sprintf("egress host %q must be a bare DNS hostname with no scheme, port, or path", host), true
	}
	if strings.Contains(host, "*") {
		return fmt.Sprintf("egress host %q must be an exact hostname, not a wildcard", host), true
	}
	lower := strings.ToLower(strings.TrimSuffix(host, "."))

	// IP literals are rejected outright (including private/link-local/loopback
	// and Tailscale ranges); egress is restricted to public hostnames.
	if ip := net.ParseIP(lower); ip != nil {
		return fmt.Sprintf("egress host %q is an IP literal; public hostnames only", host), true
	}

	// localhost and reserved local names.
	if lower == "localhost" {
		return "egress host must not be localhost", true
	}
	for _, suf := range internalSuffixes {
		if strings.HasSuffix(lower, suf) {
			return fmt.Sprintf("egress host %q points to an internal control surface", host), true
		}
	}

	// Syntactically invalid hostname (e.g. a bare IP-shaped label already
	// handled above, or bad punctuation).
	if !hostnamePattern.MatchString(lower) {
		return fmt.Sprintf("egress host %q is not a valid DNS hostname", host), true
	}

	// Guard against an IPv4-masquerading label set: four all-numeric labels
	// that form an in-range private address. net.ParseIP above catches the
	// dotted form; this is a belt-and-suspenders check for edge spellings.
	if isPrivateIPv4Literal(lower) {
		return fmt.Sprintf("egress host %q is in a private or reserved range", host), true
	}

	return "", false
}

// isPrivateIPv4Literal reports whether host is a dotted-quad private/reserved
// IPv4 address. net.ParseIP already rejects IP literals in unsafeEgressHost,
// so this only needs to catch forms that ParseIP normalizes differently.
func isPrivateIPv4Literal(host string) bool {
	parts := strings.Split(host, ".")
	if len(parts) != 4 {
		return false
	}
	var octets []int
	for _, p := range parts {
		v, err := strconv.Atoi(p)
		if err != nil || v < 0 || v > 255 {
			return false
		}
		octets = append(octets, v)
	}
	a, b := octets[0], octets[1]
	switch {
	case a == 10: // 10.0.0.0/8
		return true
	case a == 172 && b >= 16 && b <= 31: // 172.16.0.0/12
		return true
	case a == 192 && b == 168: // 192.168.0.0/16
		return true
	case a == 169 && b == 254: // link-local 169.254.0.0/16
		return true
	case a == 127: // loopback 127.0.0.0/8
		return true
	case a == 100 && b >= 64 && b <= 127: // Tailscale/CGNAT 100.64.0.0/10
		return true
	case a == 0: // 0.0.0.0/8
		return true
	}
	return false
}
