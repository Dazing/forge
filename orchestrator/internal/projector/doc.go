// Package projector folds webhook deliveries and periodic GitLab API
// snapshots into the desired/observed state model held in the work_item,
// dependency, and merge_request tables. It is the single writer that
// advances desired_state vs observed_state.
//
// This is a Phase 0 placeholder package boundary; its concrete logic lands in
// a later phase. It must not import sibling module packages.
package projector
