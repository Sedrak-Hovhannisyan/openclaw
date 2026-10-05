# PR handoff queue

Cloud Claude sessions cannot write to openclaw/openclaw, so they queue GitHub
actions here for a session running on Sedrak's machine to perform with his
own GitHub login. `actions.json` lists the actions; each `id` runs once.
Action types: `edit_pr_body` (pr, body_file), `comment` (pr, body),
`open_pr` (head branch on the fork, title, body_file), `edit_pr` (head branch: find the open PR with that head, then set title and body_file).
This branch is scratch space and can be deleted when the queue is empty.
