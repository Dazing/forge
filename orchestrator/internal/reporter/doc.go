// Package reporter emits operator-facing output: labels, idempotent notes on
// issues and merge requests, run-bundle uploads, and metrics. It never
// mutates workflow state; it only observes and records.
//
// This is a Phase 0 placeholder package boundary; its concrete logic lands in
// a later phase. It must not import sibling module packages.
package reporter
