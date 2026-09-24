package publish_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"factory.local/platform/publisher/internal/protocol"
	"factory.local/platform/publisher/internal/publish"
)

// fakeGit implements publish.GitClient and records calls.
type fakeGit struct {
	cloneErr     error
	applyErr     error
	submodErr    error
	symlinkErr   error
	credErr      error
	commitSHA    string
	pushErr      error
}

func (f *fakeGit) Clone(ctx context.Context, url, baseSHA, dest string) error {
	return f.cloneErr
}
func (f *fakeGit) ApplyPatch(ctx context.Context, dir, patchPath string) error {
	return f.applyErr
}
func (f *fakeGit) CheckSubmodules(dir string) error {
	return f.submodErr
}
func (f *fakeGit) CheckEscapingSymlinks(dir string) error {
	return f.symlinkErr
}
func (f *fakeGit) CheckCredentialMarkers(ctx context.Context, patchPath string) error {
	return f.credErr
}
func (f *fakeGit) Commit(ctx context.Context, dir, message string) (string, error) {
	return f.commitSHA, nil
}
func (f *fakeGit) Push(ctx context.Context, dir, branch string) error {
	return f.pushErr
}

func validReq() protocol.PublishRequest {
	return protocol.PublishRequest{
		ProjectID:      101,
		IssueIID:       42,
		BaseSHA:        "0123456789abcdef0123456789abcdef01234567",
		PatchPath:      "/tmp/patch-42.bundle",
		Branch:         protocol.NewBranchName(101, 42),
		PatchSHA256:    "abcdef",
		IdempotencyKey: "pk-1",
	}
}

func TestPublish_AcceptsValidRequest(t *testing.T) {
	svc := &publish.Service{Git: &fakeGit{commitSHA: "deadbeef"}}
	res, err := svc.Publish(context.Background(), validReq())
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if res.Branch != "factory/p-101-i-42" {
		t.Fatalf("Branch = %q", res.Branch)
	}
	if res.HeadSHA != "deadbeef" {
		t.Fatalf("HeadSHA = %q", res.HeadSHA)
	}
	if res.IsNoop {
		t.Fatal("IsNoop = true, want false")
	}
}

func TestPublish_RejectsNonFactoryBranch(t *testing.T) {
	svc := &publish.Service{Git: &fakeGit{}}
	req := validReq()
	req.Branch = "main"
	_, err := svc.Publish(context.Background(), req)
	if err == nil {
		t.Fatal("Publish accepted branch main")
	}
	if !strings.Contains(err.Error(), "not the factory branch") {
		t.Fatalf("error %q does not mention factory branch", err)
	}
}

func TestPublish_RejectsArbitraryBranch(t *testing.T) {
	svc := &publish.Service{Git: &fakeGit{}}
	req := validReq()
	req.Branch = "feature/my-branch"
	_, err := svc.Publish(context.Background(), req)
	if err == nil {
		t.Fatal("Publish accepted a non-deterministic branch")
	}
}

func TestPublish_RejectsBaseMismatch(t *testing.T) {
	git := &fakeGit{}
	svc := &publish.Service{Git: git}
	// Simulate a base mismatch by having Clone fail (which is what happens
	// when the expected SHA is not in the remote).
	git.cloneErr = errors.New("SHA not found")
	_, err := svc.Publish(context.Background(), validReq())
	if err == nil {
		t.Fatal("Publish accepted a base that does not exist")
	}
	if !strings.Contains(err.Error(), "re-clone base") {
		t.Fatalf("error %q does not mention re-clone base", err)
	}
}

func TestPublish_RejectsSubmodule(t *testing.T) {
	git := &fakeGit{submodErr: errors.New("gitlink found")}
	svc := &publish.Service{Git: git}
	_, err := svc.Publish(context.Background(), validReq())
	if err == nil {
		t.Fatal("Publish accepted a patch with a submodule")
	}
	if !strings.Contains(err.Error(), "submodule") {
		t.Fatalf("error %q does not mention submodule", err)
	}
}

func TestPublish_RejectsEscapingSymlink(t *testing.T) {
	git := &fakeGit{symlinkErr: errors.New("symlink escapes")}
	svc := &publish.Service{Git: git}
	_, err := svc.Publish(context.Background(), validReq())
	if err == nil {
		t.Fatal("Publish accepted a patch with an escaping symlink")
	}
	if !strings.Contains(err.Error(), "escaping symlink") {
		t.Fatalf("error %q does not mention escaping symlink", err)
	}
}

func TestPublish_RejectsCredentialMarkers(t *testing.T) {
	git := &fakeGit{credErr: errors.New("PEM private key found")}
	svc := &publish.Service{Git: git}
	_, err := svc.Publish(context.Background(), validReq())
	if err == nil {
		t.Fatal("Publish accepted a patch with embedded credentials")
	}
	if !strings.Contains(err.Error(), "credential") {
		t.Fatalf("error %q does not mention credential", err)
	}
}

func TestValidateBranch_AcceptsDeterministicBranch(t *testing.T) {
	if err := publish.ValidateBranch(101, 42, "factory/p-101-i-42"); err != nil {
		t.Fatalf("ValidateBranch: %v", err)
	}
}

func TestValidateBranch_RejectsMain(t *testing.T) {
	if err := publish.ValidateBranch(101, 42, "main"); err == nil {
		t.Fatal("ValidateBranch accepted main")
	}
}

func TestValidateBranch_RejectsWrongIID(t *testing.T) {
	if err := publish.ValidateBranch(101, 42, "factory/p-101-i-99"); err == nil {
		t.Fatal("ValidateBranch accepted a wrong IID")
	}
}
