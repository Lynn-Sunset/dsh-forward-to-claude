# Repository setup and release

This repository is prepared for GitHub publication, but the GitHub owner is
still a placeholder (`OWNER`) in `package.json` and `README.md`.

## 1. Replace the owner

Replace every `OWNER` occurrence with the GitHub account or organization:

```bash
grep -rl OWNER . --exclude-dir=.git
```

Update at least:

- `package.json` → `repository`, `homepage`, `bugs`
- `README.md` → CI badge URL and clone URL
- this file

## 2. Initialize and push

```bash
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin git@github.com:OWNER/dsh-forward-to-claude.git
git push -u origin main
```

## 3. Tag the release

```bash
git tag -a v1.0.3 -m "dsh-forward-to-claude 1.0.3"
git push origin v1.0.3
```

Create a GitHub Release from that tag and paste the relevant
[CHANGELOG](CHANGELOG.md) section.

## 4. Install from the repository

Once public, a DSH agent can install it with:

```text
plugin_manager install_bundle target: "github:OWNER/dsh-forward-to-claude"
```

Pin a commit for a reproducible installation:

```text
plugin_manager install_bundle target: "github:OWNER/dsh-forward-to-claude#<full-commit-sha>"
```

## 5. Optional npm publication

The package is currently unscoped:

```text
dsh-forward-to-claude
```

If that name is available under the intended npm account:

```bash
npm publish
```

Before publishing:

- verify the name is not already taken;
- confirm the `files` list in `package.json` is the intended package contents;
- run `npm test`;
- replace `OWNER` in the repository metadata;
- consider adding `publishConfig` or a scope if the unscoped name is taken.

## 6. Verify the repository artifact

```bash
npm pack --dry-run
npm test
```

The packed file list should contain `index.js`, `cordis.patch.yml`, locales,
`docs`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `icon.svg`. Tests and CI
files remain in the Git repository but are not part of the npm tarball.
