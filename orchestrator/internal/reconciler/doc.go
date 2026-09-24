// Package reconciler performs startup and periodic GitLab comparison: it
// detects drift between the desired/observed model and remote truth, and
// reconciles the local projection so a stale or crashed service self-heals
// without human intervention.
//
// This is a Phase 0 placeholder package boundary; its concrete logic lands in
// a later phase. It must not import sibling module packages.
package reconciler
