package health_test

import (
	"context"
	"errors"
	"testing"

	"factory.local/platform/orchestrator/internal/health"
)

func okDep(name string) health.Dependency {
	return health.Dependency{Name: name, Check: func(ctx context.Context) error { return nil }}
}

func failingDep(name string) health.Dependency {
	return health.Dependency{Name: name, Check: func(ctx context.Context) error {
		return errors.New("down")
	}}
}

func TestCheckerReadyWhenAllPass(t *testing.T) {
	c := health.NewChecker(okDep("database"), okDep("gitlab"), okDep("publisher"), okDep("worker"))
	if !c.Ready(context.Background()) {
		t.Fatalf("Ready = false, want true when all deps pass")
	}
}

func TestCheckerNotReadyWhenOneFails(t *testing.T) {
	c := health.NewChecker(okDep("database"), failingDep("gitlab"), okDep("publisher"), okDep("worker"))
	if c.Ready(context.Background()) {
		t.Fatalf("Ready = true, want false when gitlab fails")
	}
}

func TestCheckerResultsCarryNamesOnly(t *testing.T) {
	c := health.NewChecker(okDep("database"), failingDep("gitlab"))
	results := c.Check(context.Background())
	if len(results) != 2 {
		t.Fatalf("got %d results, want 2", len(results))
	}
	byName := map[string]health.Result{}
	for _, r := range results {
		byName[r.Dependency] = r
	}
	if !byName["database"].Ready {
		t.Fatalf("database not ready, want ready")
	}
	if byName["gitlab"].Ready {
		t.Fatalf("gitlab ready, want not ready")
	}
	// Status strings are bounded tokens, never the raw error text.
	if byName["gitlab"].Status != "unavailable" {
		t.Fatalf("gitlab status = %q, want unavailable", byName["gitlab"].Status)
	}
	if byName["database"].Status != "ok" {
		t.Fatalf("database status = %q, want ok", byName["database"].Status)
	}
}

func TestCheckerEmptyIsReady(t *testing.T) {
	c := health.NewChecker()
	if !c.Ready(context.Background()) {
		t.Fatalf("empty checker should be ready")
	}
}
