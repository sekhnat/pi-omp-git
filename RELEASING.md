# Releasing pi-omp-git to npm

Releases are **manual and gated**. No publishing automation exists, and none
should be added until npm release ownership / trusted-publisher setup is
deliberately configured. `scripts/release-check.mjs` verifies the gates; it
never publishes and never touches credentials.

## Gate order (enforced by `scripts/release-check.mjs`)

1. **Tag/version agreement** — the latest `v*` tag must equal the
   `package.json` version. A mismatched or missing tag fails here, before any
   build, check, smoke, or inspection step runs.
2. **Clean worktree** — `git status --porcelain` must be empty.
3. **Tag at HEAD** — the release tag must point at the current commit.
4. **`npm run check`** — typecheck, Biome, and the full Vitest suite.
5. **`npm run smoke:pack`** — packed tarball installed and exercised in an
   isolated fixture (CLI entrypoint, Pi extension loading, declared peers).
6. **Tarball inspection** — the packed `.tgz` must contain the entrypoints
   and required documentation (`README.md`, `LICENSE`, `CHANGELOG.md`,
   `SECURITY.md`), and its embedded `package.json` version must match.

Any failure aborts with exit code 1 and prints
`nothing was built, verified, or published` context — fix and re-run.

## Checklist

Run every step from a clean checkout on a supported environment (Node
22.19+, `git` on `PATH`):

- [ ] CI is green on `main` for both Ubuntu and macOS
      (`npm ci`, `npm run check`, `npm run smoke:pack`).
- [ ] `CHANGELOG.md` has a finalized entry for the release version with a
      real date (replace `Unreleased` when publishing) and every intentional
      compatibility change is listed.
- [ ] `package.json` version is the candidate version (lockfile updated via
      `npm install` after any manifest change).
- [ ] `README.md` examples match the implemented CLI and extension behavior.
- [ ] Documentation set is present: `README.md`, `LICENSE`, `SECURITY.md`,
      `CHANGELOG.md`, `CONTRIBUTING.md`, this file.
- [ ] Commit the release state and create the release tag at that commit:

      ```sh
      git tag -a vX.Y.Z -m "pi-omp-git vX.Y.Z"
      ```

      The tag must match the manifest version exactly (`v` + version); the
      gate script verifies this and refuses to continue otherwise.
- [ ] Run the gate script:

      ```sh
      node scripts/release-check.mjs
      ```

      It must print `all gates passed` before you consider publishing.
- [ ] Dry-run the publication and review the file list and metadata:

      ```sh
      npm publish --dry-run
      ```

      (`--dry-run` does not contact the registry or require credentials.)
- [ ] Publish deliberately, from an interactive shell:

      ```sh
      npm publish
      ```

      Enter your npm 2FA OTP when npm prompts for it. **Never** store, echo,
      commit, or paste OTPs or tokens into files, environment setup, shell
      history, or CI variables for this workflow; this repository ships no
      publishing workflow at all.
- [ ] Push the commit and tag: `git push origin main vX.Y.Z`.
- [ ] Post-publication verification:

      ```sh
      npm view pi-omp-git version          # reports X.Y.Z
      npm view pi-omp-git dist.tarball     # URL of the published tarball
      ```

      Then, in a scratch directory, install the published package with the
      Pi host packages available and confirm the CLI starts
      (`pi-omp-git --help`) and the extension loads through Pi's supported
      loader path.

## Failure and rollback

- A failed gate before publication is a code/config fix: correct it, re-run
  the gate script, and re-tag if the version content changed.
- Once a version is published to npm it is immutable: **never** overwrite,
  unpublish, or force-move a tag. Fix forward with a new version.
- No credentials of any kind are stored in this repository; if you find
  credential material committed anywhere, treat it as leaked, rotate it
  immediately, and report it per `SECURITY.md`.
