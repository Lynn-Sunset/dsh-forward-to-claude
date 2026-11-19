# Contributing

## Development

The package has no runtime or development dependencies. Node.js 22 or newer is
required.

```bash
npm test
```

Or run the test file directly (the supported fallback when the DSH Windows
sandbox denies test-runner child-process pipes):

```bash
node tests/integration.mjs
```

`npm test` is the portable Node.js >=22 command used by CI; the direct form is
only the sandbox fallback.

## Guidelines

- Keep the plugin Host-only unless a client UI is explicitly part of the change.
- Do not add network access, telemetry, or Claude communication.
- Keep the runtime free of `@deepseek-ai` imports unless a corresponding peer
  dependency is deliberately added and tested.
- Preserve fail-closed validation: no final artifact may be written before all
  scrub, review, and consistency checks pass.
- Do not weaken the no-echo rule for errors. Report neutral category ids and
  line numbers, never matched terms.
- Add a regression test for every bug fix.
- Update `README.md`, `docs/DETAIL.md`, and `CHANGELOG.md` when behavior changes.

## Pull requests

Please include:

- the behavior change and why it is needed;
- the test command and result;
- any new residual limit;
- confirmation that no network or Claude contact was added.

## License

By contributing, you agree that your contributions are licensed under the MIT
License.
