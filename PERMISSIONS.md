# PERMISSIONS

What an agent may do in this repository without asking, what it must ask
before, and what it may never do. The fenced `yaml permissions-contract` block
below is the machine surface: `contracts eval` renders a verdict for one
tool call, the PreToolUse gate refuses or asks citing the rule, and
`permd compile` turns it into a Claude Code settings fragment. Semantics are
deny > ask > allow — when several rules match, the most restrictive wins.
Edit the YAML, keep the fence line exactly as-is. Never soften a rule to get
past a gate: the gate is the contract.

```yaml permissions-contract
version: "0.1"
rules:
  - verdict: deny
    tool: Bash
    cmd_pattern: "rm -rf *"
    reason: destructive shell
  - verdict: deny
    tool: Bash
    cmd_pattern: "git push --force*"
    reason: rewriting shared history is operator-owned
  - verdict: ask
    tool: Bash
    cmd_pattern: "git push*"
    reason: remote mutation
  - verdict: deny
    path_glob: "**/*.pem"
    reason: key material stays unread
  - verdict: allow
    tool: Bash
    cmd_pattern: "npm test*"
  - verdict: allow
    tool: Read
floors:
  merge:
    default: pr-review
    prod: ask
  deploy:
    default: staged
    prod: ask
crossings:
  - name: prod-merge
    verdict: ask
  - name: credential-mint
    verdict: deny
    reason: operator-owned, never autonomous
```

## Notes for contributors

- `cmd_pattern` and `path_glob` use `*` and `?` only (a linear matcher, never a
  regex) — a pattern is matched against the whole command string.
- Add rules; do not delete `deny` rules to unblock an agent. If a deny is
  wrong, change it in a reviewed PR with the reason in the commit.
