// Package scheduler owns the dispatch decision: priority ranking, dependency
// readiness, WIP-lane admission, and conflict-lease acquisition before a run
// is launched. It writes to the lease table and orders the launcher queue.
//
// This is a Phase 0 placeholder package boundary; its concrete logic lands in
// a later phase. It must not import sibling module packages.
package scheduler
