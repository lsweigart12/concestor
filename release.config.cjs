// One version for the whole repository, and the git tag is the only place it
// is written down. Nothing is committed back to main: no bump in
// package.json or pyproject.toml, no CHANGELOG.md, no bot commit. The release
// notes live on the GitHub Release, generated from the commits between tags,
// and are therefore never stale.
//
// That single version is the honest one. architecture.md §4 makes version
// pinning structural — the artifact set and the code that reads it ship
// together, so there is no way to serve v16.1 dates against a v15.1 topology
// — and three components drifting apart at 0.1.0, 0.4.2 and 1.1.0 would
// describe a system this is not.
//
// It is a *code* version and says nothing about the dataset. `/v1/about`
// reports both: `release` is this tag, `build_id` is the artifact set the
// running instance has mmap'd. They move on completely different cadences,
// and conflating them would be the same mistake as merging `age_ma` into
// `age_layout` to save 10 MB.
//
// CommonJS rather than .json so these can be comments rather than "//" keys
// smuggled through a schema that may or may not tolerate them.

module.exports = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        // **This is the only place the bump is decided, and the only place it
        // is written down.** `feat:` bumps the minor, `fix:` the patch,
        // `BREAKING CHANGE:` in a body the major; `build`, `chore`, `ci`,
        // `docs`, `refactor`, `style` and `test` release nothing. A `revert:`
        // releases nothing on its own but cuts a patch when it carries git's
        // own `This reverts commit <sha>.` footer — the analyser reads the
        // footer rather than the prefix, and the same footer is what drops the
        // reverted commit from the analysis.
        //
        // `perf` deliberately does not bump — a faster induced-subtree walk is
        // not a new capability, and shipping it as one would make the version
        // number a worse description of the change than the commit already is.
        // That is the whole of the difference from the preset: everything
        // above is the default angular rules, under which `perf` cuts a patch.
        //
        // It had been asserted in three prose files and enforced in none, and
        // the prose named `commitlint.config.cjs` as the source — a file that
        // decides which types are *well-formed* and has never decided which
        // ones bump. So the rule is stated here, next to the two lines that
        // make it true, and the prose now points here rather than restating
        // it.
        //
        // The second rule is not redundant and is the one to watch: a commit
        // matching *any* custom rule skips the default rules entirely, so
        // `{type: "perf", release: false}` alone swallows a breaking `perf:`
        // — measured, no release at all, which is a worse answer than the
        // patch this exists to prevent. Handing the breaking case back to
        // `major` explicitly is what keeps `BREAKING CHANGE:` unconditional.
        //
        // Not bumping is not the same as not being mentioned: a `perf:` riding
        // in the same release as a `feat:` still gets its own line in the
        // notes below. It just cannot cut a version by itself.
        releaseRules: [
          { type: "perf", release: false },
          { type: "perf", breaking: true, release: "major" },
        ],
      },
    ],
    "@semantic-release/release-notes-generator",

    [
      "@semantic-release/exec",
      {
        // Runs after the version is decided and before the release is
        // published — the only point at which the version exists and can be
        // compiled in.
        prepareCmd: "scripts/ci/build-release.sh ${nextRelease.version}",
      },
    ],

    [
      "@semantic-release/github",
      {
        assets: [
          {
            path: "release-artifacts/concestor-serve_*_linux_amd64.tar.gz",
            label: "Server, Linux x86-64",
          },
          {
            path: "release-artifacts/concestor-serve_*_linux_arm64.tar.gz",
            label: "Server, Linux arm64",
          },
          {
            path: "release-artifacts/concestor-web_*.tar.gz",
            label: "Frontend, built",
          },
          { path: "release-artifacts/SHA256SUMS", label: "Checksums" },
        ],

        // No comments on the merged pull requests or the issues they closed.
        // It would be the only thing in this repository that writes to an
        // issue, and turning it off keeps the release job's token down to
        // `contents: write`.
        successComment: false,
        failComment: false,
        failTitle: false,
        releasedLabels: false,
      },
    ],
  ],
};
