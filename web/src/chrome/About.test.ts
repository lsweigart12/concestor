/**
 * The version in the About panel's footer.
 *
 * It reads `/v1/about`'s `release` and not its `build_id`, and the two are
 * easy to swap back by accident because both are one opaque-looking string in
 * the same small slot. What distinguishes them is what a reader could do with
 * one: a release is the tag a bug report is filed against, a build id names
 * the dataset the server has mmap'd and moves on the pipeline's cadence.
 *
 * The only formatting the label does is the `v`, and it is a formatting rule
 * rather than a payload change on purpose — `release` stays a bare semver so
 * anything comparing versions can keep parsing it.
 */

import { describe, expect, it } from "vitest";
import { releaseLabel } from "./About";

describe("releaseLabel", () => {
  it("writes a tagged release the way the repository tags it", () => {
    // release.config.cjs's tagFormat is `v${version}`, but build-release.sh
    // compiles in the bare version, so the `v` can only come from here.
    expect(releaseLabel("0.6.0")).toBe("v0.6.0");
    expect(releaseLabel("1.0.0")).toBe("v1.0.0");
  });

  it("leaves a word alone", () => {
    // A `go run` has no tag and main.go reports "dev". "vdev" would read as a
    // version that exists.
    expect(releaseLabel("dev")).toBe("dev");
  });

  it("does not add a second v to something already carrying one", () => {
    // Nothing sends this today — the server sends the bare version — but a
    // future release path that passed the tag through should not print
    // "vv0.6.0".
    expect(releaseLabel("v0.6.0")).toBe("v0.6.0");
  });

  it("prefixes a prerelease and a build-metadata version too", () => {
    expect(releaseLabel("0.7.0-rc.1")).toBe("v0.7.0-rc.1");
  });
});
