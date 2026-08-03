// Conventional Commits, with this repository's voice left intact.
//
// The type prefix decides the version bump, and it is the whole of what is
// being imposed. `feat: Make the card say what a thing is, and let the reader
// walk from it` is five characters longer than the commit that actually
// shipped and says exactly the same thing.
//
// The rules are written out rather than pulled in with
// `extends: ["@commitlint/config-conventional"]`, and that is not a style
// preference. commitlint resolves `extends` relative to *this file's*
// directory, and the repository root has no node_modules — so the extended
// form throws MODULE_NOT_FOUND under `npx`, which is exactly how CI runs it.
// Written out, the only dependency is the linter itself. It also puts the
// type list where the comment explaining it can sit next to it.
//
// Merge commits are ignored by commitlint's own defaults, so the
// `Merge pull request #11 from …` history stays valid.

module.exports = {
  // Dependabot's commits are exempt, and what buys the exemption is that
  // `.github/dependabot.yml` pins their type instead — `ci` for the
  // workflows, `build` for the package ecosystems — so the one thing this
  // check exists to protect is settled before the commit is written rather
  // than after.
  //
  // What cannot be settled there is the body. Dependabot writes a link list,
  // and a *grouped* update writes the whole group onto one line: 364
  // characters naming four packages and their four repositories. Every
  // ecosystem here is grouped, so that is the normal shape and not the
  // exception. Hand-wrapping is not available to a bot, and raising
  // `body-max-line-length` to clear it would raise it for the prose bodies
  // the rule is actually for.
  //
  // The narrow test is the sign-off trailer rather than the author field,
  // because commitlint is handed a message and not a commit.
  ignores: [(message) => /^Signed-off-by: dependabot\[bot\]/m.test(message)],

  rules: {
    // The types semantic-release's analyser understands. This list decides
    // which types are *well-formed*, and nothing else: which of them bump,
    // and by how much, is `release.config.cjs`'s `releaseRules` and is
    // written down there. It used to be described here too, and the
    // description drifted out of agreement with the analyser without anything
    // failing — a linter that cannot cut a release is not a place to record
    // what cutting one costs.
    "type-enum": [
      2,
      "always",
      [
        "build",
        "chore",
        "ci",
        "docs",
        "feat",
        "fix",
        "perf",
        "refactor",
        "revert",
        "style",
        "test",
      ],
    ],
    "type-empty": [2, "never"],
    "type-case": [2, "always", "lower-case"],
    "scope-case": [2, "always", "lower-case"],

    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],

    // Note what is *not* here: `subject-case`. config-conventional forbids a
    // sentence-case subject, which would reject every commit this project has
    // ever written. The subject here is a sentence; that is the point of it.

    // 100 characters, with room to spare: the longest subject in the log —
    // "Make the mouse a first-class path, and stop negotiating with the
    // browser" — is 71, and 77 with a prefix. Still catches a paragraph
    // pasted into the subject line.
    "header-max-length": [2, "always", 100],

    // The bodies here are prose explaining a decision, hand-wrapped at 72.
    // Raised rather than disabled, so a wall of unwrapped text is caught.
    "body-max-line-length": [2, "always", 100],
    "body-leading-blank": [2, "always"],
    "footer-leading-blank": [2, "always"],
  },
};
