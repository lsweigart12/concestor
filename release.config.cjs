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
    "@semantic-release/commit-analyzer",
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
