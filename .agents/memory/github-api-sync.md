---
name: GitHub API sync
description: How to synchronize this workspace when raw Git transport credentials are unavailable.
---

When the attached GitHub connection works but raw `git fetch` or `git push` cannot authenticate, synchronize by comparing the authenticated remote tree with the local tree, then materialize changed blobs and deletions through the GitHub API. Keep the remote commit SHA and verify the resulting local tree SHA.

**Why:** The environment can have a valid GitHub integration while the local Git HTTPS remote has no usable credential, and remote branches may advance independently during a session.

**How to apply:** Refresh the branch ref immediately before the sync, retry transient API reads, refuse to apply if the ref moves during the operation, and avoid deleting untracked workspace data.