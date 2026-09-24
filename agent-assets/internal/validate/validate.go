// Package validate deterministically checks an agent-assets bundle for the
// conditions the factory asset pipeline must reject before packaging. It is
// stateless shared infrastructure: it reads the bundle tree and returns
// diagnostics; it does not execute workflows, own orchestrator state, or import
// any orchestrator slice.
package validate

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// maxAssetBytes is the size limit for any single file in the bundle. A bundle
// that ships an oversized file is rejected; the limit keeps a packaged artifact
// from carrying unbounded content.
const maxAssetBytes = 256 * 1024

// schemaVersion is the constant every factory JSON schema pins to its draft.
const schemaVersion = "https://json-schema.org/draft/2020-12/schema"

// Diagnostic is one validation finding against a bundle. File is the
// bundle-relative path the finding applies to (or "" for a whole-bundle
// finding); Rule is a short stable identifier; Message explains the violation.
type Diagnostic struct {
	File    string
	Rule    string
	Message string
}

// Bundle validates the agent-assets bundle rooted at root. root is the
// directory that contains manifest.yaml. It returns all diagnostics found; an
// empty slice means the bundle is valid. Every check rejects rather than
// normalizes: path escapes, missing references, oversized files, symlinks,
// and secret-shaped content are all reported, never repaired.
func Bundle(root string) []Diagnostic {
	var out []Diagnostic

	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return []Diagnostic{{Rule: "root", Message: "bundle root is missing or is not a directory"}}
	}

	walk, walkErr := walkBundle(root)
	if walkErr != nil {
		out = append(out, Diagnostic{File: root, Rule: "walk", Message: walkErr.Error()})
	}

	out = append(out, checkSymlinks(walk)...)
	out = append(out, checkSizes(walk)...)
	out = append(out, checkSecrets(root, walk)...)
	out = append(out, checkFrontmatter(root, walk)...)
	out = append(out, checkSchemas(root, walk)...)
	out = append(out, checkManifest(root, walk)...)
	out = append(out, checkHarness(root, walk)...)
	out = append(out, checkSuite(root, walk)...)

	sortDiagnostics(out)
	return out
}

// bundleFile is one walked entry in the bundle tree.
type bundleFile struct {
	rel     string // bundle-relative path
	size    int64
	symlink bool
}

// walkBundle lists every entry under root, flagging symlinks without following
// them. The returned slice is in deterministic lexicographic order.
func walkBundle(root string) ([]bundleFile, error) {
	var files []bundleFile
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(root, p)
		if relErr != nil {
			rel = p
		}
		if rel == "." {
			return nil
		}
		isSym := d.Type()&fs.ModeSymlink != 0
		var size int64
		if !isSym && d.Type().IsRegular() {
			if fi, fiErr := d.Info(); fiErr == nil {
				size = fi.Size()
			}
		}
		files = append(files, bundleFile{rel: filepath.ToSlash(rel), size: size, symlink: isSym})
		return nil
	})
	return files, err
}

// checkSymlinks reports every symlink in the bundle. Symlinks can escape the
// bundle or point at credentials; none are permitted.
func checkSymlinks(walk []bundleFile) []Diagnostic {
	var out []Diagnostic
	for _, f := range walk {
		if f.symlink {
			out = append(out, Diagnostic{File: f.rel, Rule: "symlink", Message: "symlinks are not allowed in the bundle"})
		}
	}
	return out
}

// checkSizes reports every file over the per-file size limit.
func checkSizes(walk []bundleFile) []Diagnostic {
	var out []Diagnostic
	for _, f := range walk {
		if f.size > maxAssetBytes {
			out = append(out, Diagnostic{File: f.rel, Rule: "size", Message: fmt.Sprintf("file exceeds the %d byte limit", maxAssetBytes)})
		}
	}
	return out
}

// secretPatterns are the secret-shaped strings the bundle must never contain.
// They are high-signal credential markers, not a full secret scanner.
var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`AKIA[0-9A-Z]{16}`),
	regexp.MustCompile(`gh[pousr]_[A-Za-z0-9]{20,}`),
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
	regexp.MustCompile(`(?i)\b(api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9+/=_\-]{12,}["']`),
}

// checkSecrets reports any regular file containing a secret-shaped string.
func checkSecrets(root string, walk []bundleFile) []Diagnostic {
	var out []Diagnostic
	for _, f := range walk {
		if f.symlink {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, f.rel))
		if err != nil {
			continue
		}
		for _, re := range secretPatterns {
			if loc := re.Find(data); loc != nil {
				out = append(out, Diagnostic{File: f.rel, Rule: "secret", Message: "secret-shaped content: " + string(loc)})
				break
			}
		}
	}
	return out
}

// markdownKinds maps a bundle-relative markdown asset path to the frontmatter
// `kind` its YAML header must declare. Files outside this set (docs, suite
// prose) are not frontmatter-bearing and are not checked.
func markdownKind(rel string) (kind string, ok bool) {
	switch {
	case strings.HasPrefix(rel, "commands/") && strings.HasSuffix(rel, ".md"):
		return "command", true
	case strings.HasSuffix(rel, "/SKILL.md"):
		return "skill", true
	case strings.HasSuffix(rel, "/system.md"):
		return "role-prompt", true
	default:
		return "", false
	}
}

// checkFrontmatter verifies that every markdown asset begins with a YAML
// frontmatter block that declares its kind.
func checkFrontmatter(root string, walk []bundleFile) []Diagnostic {
	var out []Diagnostic
	for _, f := range walk {
		expected, ok := markdownKind(f.rel)
		if !ok {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, f.rel))
		if err != nil {
			out = append(out, Diagnostic{File: f.rel, Rule: "frontmatter", Message: "cannot read file"})
			continue
		}
		m, err := parseFrontmatter(data)
		if err != nil {
			out = append(out, Diagnostic{File: f.rel, Rule: "frontmatter", Message: err.Error()})
			continue
		}
		if got, ok := m["kind"].(string); !ok || got == "" {
			out = append(out, Diagnostic{File: f.rel, Rule: "frontmatter", Message: "frontmatter is missing a non-empty kind"})
			continue
		} else if got != expected {
			out = append(out, Diagnostic{File: f.rel, Rule: "frontmatter", Message: fmt.Sprintf("frontmatter kind %q does not match expected %q", got, expected)})
		}
	}
	return out
}

// parseFrontmatter extracts the leading YAML block of a markdown file. It
// returns an error when the block is missing, unterminated, or does not parse.
func parseFrontmatter(data []byte) (map[string]any, error) {
	lines := strings.Split(strings.TrimPrefix(string(data), "\ufeff"), "\n")
	if len(lines) == 0 || lines[0] != "---" {
		return nil, fmt.Errorf("frontmatter block is missing (file must begin with ---)")
	}
	closeIdx := -1
	for i := 1; i < len(lines); i++ {
		if lines[i] == "---" || lines[i] == "..." {
			closeIdx = i
			break
		}
	}
	if closeIdx < 0 {
		return nil, fmt.Errorf("frontmatter block is not terminated")
	}
	block := strings.Join(lines[1:closeIdx], "\n")
	var m map[string]any
	if err := yaml.Unmarshal([]byte(block), &m); err != nil {
		return nil, fmt.Errorf("frontmatter is not valid YAML: %v", err)
	}
	if m == nil {
		return nil, fmt.Errorf("frontmatter block is empty")
	}
	return m, nil
}

// schemaRequiredFields pins, per schema file, the top-level fields that must
// appear in the schema's `required` array. This enforces the documented
// plan/implementation/review contracts and the suite configuration/scorecard
// contracts without a full JSON-Schema engine.
var schemaRequiredFields = map[string][]string{
	"schemas/plan.schema.json":             {"schema_version", "issue", "base_sha", "summary", "approach", "acceptance_checks", "risks", "decision"},
	"schemas/implementation.schema.json":   {"schema_version", "run_id", "base_sha", "summary", "changed_paths", "unexpected_paths", "acceptance_evidence", "risks", "decision"},
	"schemas/review.schema.json":           {"schema_version", "project_id", "merge_request_iid", "reviewed_sha", "verdict", "criteria", "findings", "summary"},
	"suite/configuration-record.schema.json": {"schema_version", "model_endpoint_revision", "inference_runtime", "context_limit", "tool_parser", "reasoning_parser", "harness", "asset_commit", "asset_digest", "repository_sha", "limits", "concurrent_sessions"},
	"suite/scorecard.schema.json":          {"schema_version", "configuration_record", "cases", "gates", "go_no_go"},
}

// checkSchemas validates every .schema.json in the bundle: it must be valid
// JSON, pin the 2020-12 draft, be an object with `type` and `properties`, and
// (for the documented schemas) declare the required top-level fields.
func checkSchemas(root string, walk []bundleFile) []Diagnostic {
	var out []Diagnostic
	for _, f := range walk {
		if !strings.HasSuffix(f.rel, ".schema.json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, f.rel))
		if err != nil {
			out = append(out, Diagnostic{File: f.rel, Rule: "schema", Message: "cannot read file"})
			continue
		}
		var doc map[string]any
		if err := json.Unmarshal(data, &doc); err != nil {
			out = append(out, Diagnostic{File: f.rel, Rule: "schema", Message: "not valid JSON: " + err.Error()})
			continue
		}
		if sv, _ := doc["$schema"].(string); sv != schemaVersion {
			out = append(out, Diagnostic{File: f.rel, Rule: "schema", Message: "schema must pin the 2020-12 draft"})
		}
		if _, ok := doc["type"]; !ok {
			out = append(out, Diagnostic{File: f.rel, Rule: "schema", Message: "schema is missing its type"})
		}
		if _, ok := doc["properties"]; !ok {
			out = append(out, Diagnostic{File: f.rel, Rule: "schema", Message: "schema is missing its properties"})
		}
		if required, known := schemaRequiredFields[f.rel]; known {
			have := jsonRequiredSet(doc)
			for _, field := range required {
				if !have[field] {
					out = append(out, Diagnostic{File: f.rel, Rule: "schema", Message: "schema omits required field " + field})
				}
			}
		}
	}
	return out
}

// jsonRequiredSet collects the strings in a schema document's `required`
// array into a set for quick membership checks.
func jsonRequiredSet(doc map[string]any) map[string]bool {
	set := map[string]bool{}
	for _, r := range doc["required"].([]any) {
		if s, ok := r.(string); ok {
			set[s] = true
		}
	}
	return set
}

// manifest is the typed view of agent-assets/manifest.yaml.
type manifest struct {
	Version  int      `yaml:"version"`
	Roles    []string `yaml:"roles"`
	Commands []string `yaml:"commands"`
	Skills   []string `yaml:"skills"`
	Schemas  []string `yaml:"schemas"`
	Harness  []string `yaml:"harness"`
	Suite    []string `yaml:"suite"`
}

// roleManifest is the typed view of roles/<role>/manifest.yaml.
type roleManifest struct {
	Role           string         `yaml:"role"`
	Command        string         `yaml:"command"`
	Skills         []string       `yaml:"skills"`
	Tools          []string       `yaml:"tools"`
	OutputSchema   string         `yaml:"output_schema"`
	ModelAlias     string         `yaml:"model_alias"`
	ResourcePolicy map[string]any `yaml:"resource_policy"`
}

// checkManifest validates manifest.yaml and, through it, every role manifest,
// command, skill, schema, and suite reference. A reference that escapes the
// bundle is a `path` finding; a reference that is in-bundle but has no file is
// a `reference` finding; a role asset that is not in the central allowlist is
// an `allowlist` finding.
func checkManifest(root string, walk []bundleFile) []Diagnostic {
	exists := pathSet(walk)

	man, manDiags := loadManifest(root, exists)
	out := manDiags
	if man == nil {
		return out
	}

	// Every allowlisted list entry must be a relative, in-bundle, existing file.
	for _, list := range []struct {
		label string
		refs  []string
	}{
		{"role", man.Roles},
		{"command", man.Commands},
		{"skill", man.Skills},
		{"schema", man.Schemas},
		{"harness", man.Harness},
		{"suite", man.Suite},
	} {
		for _, ref := range list.refs {
			out = append(out, checkRef(root, exists, ref, list.label+" allowlist")...)
		}
	}

	allowCommands := refSet(man.Commands)
	allowSkills := refSet(man.Skills)
	allowSchemas := refSet(man.Schemas)

	for _, ref := range man.Roles {
		out = append(out, checkRole(root, exists, ref, allowCommands, allowSkills, allowSchemas)...)
	}
	return out
}

// loadManifest reads and parses manifest.yaml, checking its version and that it
// names at least one role.
func loadManifest(root string, exists map[string]bool) (*manifest, []Diagnostic) {
	rel := "manifest.yaml"
	if !exists[rel] {
		return nil, []Diagnostic{{File: rel, Rule: "manifest", Message: "manifest.yaml is missing"}}
	}
	data, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		return nil, []Diagnostic{{File: rel, Rule: "manifest", Message: "cannot read manifest: " + err.Error()}}
	}
	var m manifest
	if err := yaml.Unmarshal(data, &m); err != nil {
		return nil, []Diagnostic{{File: rel, Rule: "manifest", Message: "manifest is not valid YAML: " + err.Error()}}
	}
	if m.Version != 1 {
		return nil, []Diagnostic{{File: rel, Rule: "manifest", Message: "manifest version must be 1"}}
	}
	if len(m.Roles) == 0 {
		return nil, []Diagnostic{{File: rel, Rule: "manifest", Message: "manifest must name at least one role"}}
	}
	return &m, nil
}

// checkRole validates one role manifest: required fields present, `command`
// resolving to exactly one allowlisted command file, every skill and the output
// schema allowlisted and present, a model alias, and a resource policy.
func checkRole(root string, exists map[string]bool, ref string, allowCommands, allowSkills, allowSchemas map[string]bool) []Diagnostic {
	var out []Diagnostic
	for _, d := range checkRef(root, exists, ref, "role") {
		out = append(out, d)
	}
	if !exists[ref] {
		return out
	}
	data, err := os.ReadFile(filepath.Join(root, ref))
	if err != nil {
		out = append(out, Diagnostic{File: ref, Rule: "role-manifest", Message: "cannot read role manifest: " + err.Error()})
		return out
	}
	var raw map[string]any
	if err := yaml.Unmarshal(data, &raw); err != nil {
		out = append(out, Diagnostic{File: ref, Rule: "role-manifest", Message: "role manifest is not valid YAML: " + err.Error()})
		return out
	}
	for _, key := range []string{"role", "command", "skills", "tools", "output_schema", "model_alias", "resource_policy"} {
		if _, ok := raw[key]; !ok {
			out = append(out, Diagnostic{File: ref, Rule: "role-manifest", Message: "role manifest is missing field " + key})
		}
	}
	var rm roleManifest
	if err := yaml.Unmarshal(data, &rm); err != nil {
		out = append(out, Diagnostic{File: ref, Rule: "role-manifest", Message: "role manifest has an invalid shape: " + err.Error()})
		return out
	}
	if rm.Role == "" {
		out = append(out, Diagnostic{File: ref, Rule: "role-manifest", Message: "role field is empty"})
	}
	if rm.Command == "" {
		out = append(out, Diagnostic{File: ref, Rule: "role-manifest", Message: "command field is empty"})
	} else {
		for _, d := range checkRef(root, exists, rm.Command, "command") {
			out = append(out, d)
		}
		if exists[rm.Command] && !allowCommands[rm.Command] {
			out = append(out, Diagnostic{File: ref, Rule: "allowlist", Message: "command " + rm.Command + " is not in the manifest command allowlist"})
		}
	}
	for _, sk := range rm.Skills {
		for _, d := range checkRef(root, exists, sk, "skill") {
			out = append(out, d)
		}
		if exists[sk] && !allowSkills[sk] {
			out = append(out, Diagnostic{File: ref, Rule: "allowlist", Message: "skill " + sk + " is not in the manifest skill allowlist"})
		}
	}
	if rm.OutputSchema == "" {
		out = append(out, Diagnostic{File: ref, Rule: "role-manifest", Message: "output_schema field is empty"})
	} else {
		for _, d := range checkRef(root, exists, rm.OutputSchema, "schema") {
			out = append(out, d)
		}
		if exists[rm.OutputSchema] && !allowSchemas[rm.OutputSchema] {
			out = append(out, Diagnostic{File: ref, Rule: "allowlist", Message: "output_schema " + rm.OutputSchema + " is not in the manifest schema allowlist"})
		}
	}
	if rm.ModelAlias == "" {
		out = append(out, Diagnostic{File: ref, Rule: "role-manifest", Message: "model_alias field is empty"})
	}
	if len(rm.ResourcePolicy) == 0 {
		out = append(out, Diagnostic{File: ref, Rule: "role-manifest", Message: "resource_policy is empty"})
	}
	return out
}

// checkRef validates a single bundle-relative reference: it must be relative
// and contain no `..` (a `path` finding), and when it is in-bundle the file
// must exist (a `reference` finding). The context label names the reference in
// diagnostics.
func checkRef(root string, exists map[string]bool, ref, context string) []Diagnostic {
	if ref == "" {
		return []Diagnostic{{Rule: "reference", Message: context + " reference is empty"}}
	}
	if strings.HasPrefix(ref, "/") {
		return []Diagnostic{{File: ref, Rule: "path", Message: context + " reference is an absolute path"}}
	}
	if containsDotDot(ref) {
		return []Diagnostic{{File: ref, Rule: "path", Message: context + " reference escapes the bundle with .."}}
	}
	if !exists[ref] {
		return []Diagnostic{{File: ref, Rule: "reference", Message: context + " reference " + ref + " does not exist in the bundle"}}
	}
	return nil
}

// containsDotDot reports whether ref has a `..` path component.
func containsDotDot(ref string) bool {
	for _, part := range strings.Split(ref, "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

// checkHarness validates the harness adapter configurations: each must parse and
// declare which harness it configures.
func checkHarness(root string, walk []bundleFile) []Diagnostic {
	var out []Diagnostic
	exists := pathSet(walk)
	for _, ref := range []string{"harness/openhands.yaml", "harness/opencode.json"} {
		if !exists[ref] {
			out = append(out, Diagnostic{File: ref, Rule: "harness", Message: "harness config is missing"})
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, ref))
		if err != nil {
			out = append(out, Diagnostic{File: ref, Rule: "harness", Message: "cannot read harness config: " + err.Error()})
			continue
		}
		var hasHarness bool
		switch {
		case strings.HasSuffix(ref, ".json"):
			var doc map[string]any
			if err := json.Unmarshal(data, &doc); err != nil {
				out = append(out, Diagnostic{File: ref, Rule: "harness", Message: "harness config is not valid JSON: " + err.Error()})
				continue
			}
			hasHarness = doc["harness"] != nil
		default:
			var doc map[string]any
			if err := yaml.Unmarshal(data, &doc); err != nil {
				out = append(out, Diagnostic{File: ref, Rule: "harness", Message: "harness config is not valid YAML: " + err.Error()})
				continue
			}
			hasHarness = doc["harness"] != nil
		}
		if !hasHarness {
			out = append(out, Diagnostic{File: ref, Rule: "harness", Message: "harness config does not declare a harness identifier"})
		}
	}
	return out
}

// suiteCaseFields are the required fields of a fixed-suite case record.
var suiteCaseFields = []string{"id", "clean_checkout", "requirements", "acceptance_criteria", "technical_constraints", "expected_evidence", "risk_assertions", "gate_assertions"}

// checkSuite validates the fixed evaluation suite: each case record carries the
// required fields, and the rubric and scorecard parse and carry their
// required keys.
func checkSuite(root string, walk []bundleFile) []Diagnostic {
	var out []Diagnostic
	exists := pathSet(walk)

	for _, f := range walk {
		// suite/cases/<id>/case.yaml
		if !strings.HasSuffix(f.rel, "/case.yaml") {
			continue
		}
		out = append(out, checkSuiteCase(root, f.rel, exists)...)
	}

	for ref, fields := range map[string][]string{
		"suite/rubric.yaml":    {"dimensions", "gates"},
		"suite/scorecard.yaml": {"schema_version", "cases", "gates", "go_no_go"},
	} {
		if !exists[ref] {
			out = append(out, Diagnostic{File: ref, Rule: "suite", Message: "suite file is missing"})
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, ref))
		if err != nil {
			out = append(out, Diagnostic{File: ref, Rule: "suite", Message: "cannot read suite file: " + err.Error()})
			continue
		}
		var m map[string]any
		if err := yaml.Unmarshal(data, &m); err != nil {
			out = append(out, Diagnostic{File: ref, Rule: "suite", Message: "suite file is not valid YAML: " + err.Error()})
			continue
		}
		for _, k := range fields {
			if _, ok := m[k]; !ok {
				out = append(out, Diagnostic{File: ref, Rule: "suite", Message: "suite file is missing field " + k})
			}
		}
	}
	return out
}

// checkSuiteCase validates one case record: required fields present and the
// case id matching its directory name.
func checkSuiteCase(root string, rel string, exists map[string]bool) []Diagnostic {
	var out []Diagnostic
	if !exists[rel] {
		out = append(out, Diagnostic{File: rel, Rule: "suite", Message: "case record is missing"})
		return out
	}
	data, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		out = append(out, Diagnostic{File: rel, Rule: "suite", Message: "cannot read case record: " + err.Error()})
		return out
	}
	var m map[string]any
	if err := yaml.Unmarshal(data, &m); err != nil {
		out = append(out, Diagnostic{File: rel, Rule: "suite", Message: "case record is not valid YAML: " + err.Error()})
		return out
	}
	for _, k := range suiteCaseFields {
		if _, ok := m[k]; !ok {
			out = append(out, Diagnostic{File: rel, Rule: "suite", Message: "case record is missing field " + k})
		}
	}
	if id, ok := m["id"].(string); ok {
		dir := path.Base(path.Dir(rel))
		if id != dir {
			out = append(out, Diagnostic{File: rel, Rule: "suite", Message: "case id " + id + " does not match its directory " + dir})
		}
	}
	return out
}

// pathSet builds a set of bundle-relative paths for existence checks.
func pathSet(walk []bundleFile) map[string]bool {
	set := map[string]bool{}
	for _, f := range walk {
		set[f.rel] = true
	}
	return set
}

// refSet builds a set of reference strings for allowlist membership checks.
func refSet(refs []string) map[string]bool {
	set := map[string]bool{}
	for _, r := range refs {
		set[r] = true
	}
	return set
}

// sortDiagnostics orders findings deterministically for stable output.
func sortDiagnostics(d []Diagnostic) {
	sort.SliceStable(d, func(i, j int) bool {
		if d[i].File != d[j].File {
			return d[i].File < d[j].File
		}
		if d[i].Rule != d[j].Rule {
			return d[i].Rule < d[j].Rule
		}
		return d[i].Message < d[j].Message
	})
}
