#### Ticket Dependency + Merge
- Add ticket field "dependsOnTickets" (dependsOnTickets: [ "ticket-abc", "ticket-dfg" ])
- Plan + Merge tickets that are dependant on eachother
- Strategy? Sequential work / commits in same workspace? New workspace for reach and seperate branches per ticket + 1 for the merged one?

#### Stage commits to enable tracing and analysis of the outcome of each stage to enable compound engineering
- Commit in the workspace between coding/review/etc
- Provide some commit message (output 'message' from stage agent?)
- Set PR to squash on merge if supported

Implemented: see `docs/plans/stage-commits-and-squash-merge-implementation-plan.md` and the `Merge method preference` section of `README.md`.
