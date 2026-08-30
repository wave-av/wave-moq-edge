# TESTING

How to run this project's tests, for people and for agents. The fenced
`yaml test-contract` block below is the machine surface: `testmd validate`
checks it, `testmd run` executes it and writes receipts, and the stop gate
verifies receipts before an agent may claim DONE. Edit the YAML, keep the
fence line exactly as-is, and never paste secret values into it (fixture
NAMES only).

```yaml test-contract
version: "0.1"
entry: npm test
suites:
  unit:
    cmd: npm test
    timeout_s: 600
  lint:
    cmd: npm run lint
    required: false
    timeout_s: 120
pass:
  exit: 0
forbidden:
  - skip-failing
  - delete-tests
  - mock-prod
  - claim-pass-on-timeout
flake:
  retries: 0
  on_flaky: fail
receipt:
  format: json
  path: .testmd/receipts
  bind: gitCommit
```

## Notes for contributors

- `testmd run` executes every suite and writes one receipt per suite under
  `.testmd/receipts/` (add that directory to `.gitignore`).
- A receipt is bound to the contract text AND the git commit it ran at; edit
  either and the receipt goes stale — re-run.
- Optional suites (`required: false`) may fail without failing the gate.
