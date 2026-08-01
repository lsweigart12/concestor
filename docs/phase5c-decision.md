# Phase 5c — generated outlines from Wikimedia photographs

**Status: planned, not built.** Every figure here was measured on 2026-08-01
against the live services and the current build (`a2b513305e2ddb95`). Do not
re-research them; several cost hours to establish and two of them contradict
the obvious approach.

`handoff.md` §2 must gain a row when this lands. It has none yet, deliberately.

---

## 1. The decision

Generate monochrome vector **outlines** for the ~210,000 tree nodes that have a
Wikimedia photograph and no PhyloPic silhouette of their own, by segmenting the
photograph with Apple's Vision framework and tracing the mask with potrace.

Four things were considered and rejected. They are recorded in §4 with their
numbers so that nobody re-derives them.

**PhyloPic always wins.** A node that carries its own PhyloPic drawing is never
touched. That is 4,539 of the 148,143 matched nodes, and the rule is structural,
not a preference: PhyloPic silhouettes are drawn by people who know the animal,
and a generated outline is a photograph of one individual with the background
removed.

---

## 2. Why the existing corpus is the ceiling

Phase 5a resolves 7,470 nodes to a drawing of their own. It is easy to assume
that better seeding would raise that. It would not, and this is the number that
decides the whole phase:

| | |
|---|---|
| PhyloPic images | 12,863 |
| images whose node declares an OTT id | 11,080 (86.1%) |
| **distinct OTT ids offered by the whole corpus** | **9,461** |
| of those, present in synthesis | 6,976 |
| nodes seeded, after forwards, lifts and name passes | 7,470 |

The corpus knows about 9,461 taxa. Perfect seeding would gain roughly 2,000
nodes. `images.py` already runs five seeding passes and recovers 317 by a
one-hop lift and 337 by name; the well is dry. More silhouettes must come from
a different source, or not at all.

---

## 3. The source

Wikidata property **P9157 carries an OTT id** — the same join `vernaculars.py`
already uses — and **P18 carries an image**. The join needs no name matching.

```sparql
SELECT (COUNT(DISTINCT ?q) AS ?n) WHERE { ?q wdt:P9157 ?o . ?q wdt:P18 ?img }
```

**264,274** items, measured. That is 28× PhyloPic's 9,461.

WDQS truncates at its hard 60 s limit, so the id pull returned 176,157 rows →
159,391 distinct OTT ids, about 60% of the total. **Every population figure
below is therefore a measured floor with an extrapolation beside it.** Complete
the pull by paging on OTT-id ranges before committing to a storage layout.

| | measured (60% pull) | extrapolated |
|---|---|---|
| tree nodes matched | 148,143 | ~230,000 |
| — leaves / internal | 113,110 / 35,033 | |
| already hold a native PhyloPic (`method='exact'`) | 4,539 | ~6,600 |
| **eligible** | **143,604** | **~210,000** |
| — of which leaves | 109,886 | |

### What it buys

Simulated by running the real `propagate()` with the new seeds added, so this is
the actual metric the phase 5a gates measure, not a proxy:

| | now | with generated outlines |
|---|---|---|
| nodes with their own drawing | 7,470 | **151,074** |
| median clade a picture speaks for | 3,153 tips | **270 tips** |
| p90 | 46,221 | 11,549 |
| nodes whose picture claims > 10,000 tips | 27.8% | **10.5%** |

That is an order of magnitude on the number that `images.py` was rewritten to
optimise, from 60% of the available data.

The right comparison is not "generated outline vs good silhouette". On a random
sample of 70 eligible nodes, the drawing each one shows **today** is borrowed
from a relative whose shared clade holds a median of **706 tips**. That is the
thing being replaced.

---

## 4. Four rejected approaches, with their numbers

### 4.1 Photographs shown as photographs — rejected

`handoff.md` §1 argues for silhouettes because a silhouette legitimately
represents a *clade* where a photograph represents one member, and
`design-reference.md` L222 makes a filled shape *mean* silhouette on this canvas.
Shipping 210,000 photographs would put two visual languages on one screen.

### 4.2 Interior detail carved from tone — rejected

A pure outline loses real information: at outline-only a tiger is a generic cat,
a zebra a donkey, a bald eagle a generic raptor. Carving the light regions of
the subject into negative space recovers all three, and the monarch's wing cells.

It was still rejected, on a **random** sample rather than the charismatic
megafauna that motivated it. Tigers and zebras are a rounding error in this
tree; the corpus is moths, beetles, grasses and fungi, and on those the carving
reads as noise — the yak goes blotchy, the snail speckled, sedges become
scribble. Two gates were tried:

- **Fragmentation** — wrong. It demoted *T. rex* and a spider, because ribs and
  leg banding are as fragmented as caustics are.
- **Edge-coincidence**, the fraction of carved boundary sitting on a real image
  gradient — better (zebra 0.89, eagle 0.81, *T. rex* 0.78, oak 0.00) but still
  wrong in principle. It detects that a real edge exists, and fur and feather
  texture are real edges that are still noise at 46 px.

Outline-only is also 1.65× smaller before quantisation and deletes the entire
tone-carving stage. **Do not reintroduce interior detail without re-testing on a
random draw, not on mammals.**

### 4.3 Text-prompted segmentation — rejected

The idea was that naming the subject would stop the segmenter welding the
organism to its perch. Deriving the prompt works well and is worth keeping if
anything else ever needs it: walking up the lineage to an everyday word
resolved **69 of 70** (`Batrachedra praeangusta` → "moth"), and the vernacular
table supplied a specific name for 23.

The segmentation is worse:

| | Vision | OWLv2-base + SAM-vit-base |
|---|---|---|
| box-filling rectangles | **0 / 66** | 6 / 64 |
| median bbox fill | 0.46 | 0.53 |

When SAM cannot find a coherent object inside the prompt box it returns *the
box*. Vision has no box to fall back to and so never does this. It also drops
fine appendages — a click beetle keeps its legs and antennae under Vision and
loses them under SAM — and it **did not fix the substrate problem** it was
brought in for. The two agree at IoU ≥ 0.80 on 29 of 66; using that as an
acceptance gate caps the yield at the weaker model's competence, which is why
it is not used.

Untested, and the only versions worth testing: `sam-vit-huge` and SAM3, which
takes text natively instead of through the box handoff that produces the
rectangles.

### 4.4 Other image sources — rejected

EOL, iNaturalist and GBIF are photograph sources too, and Wikidata already
aggregates the best of them behind a join key we hold. PhyloPic's 1,783
OTT-less images are already partly recovered by the name passes.

---

## 5. The pipeline

```
Commons CDN thumbnail (960px)
  → Vision pass 1: locate the subject
  → crop to its bounding box + 8% margin
  → Vision pass 2: re-segment on the crop
  → clean, keep the largest component
  → potrace, viewBox tight to the subject
  → per-entry gzip into the packed blob
```

### 5.1 Segmentation

`VNGenerateForegroundInstanceMaskRequest`, macOS 14+. No model download, GPU
accelerated, ~30 lines of Swift.

**Take the largest instance, never the union.** A union welds a specimen plate's
two moths into one shape. Vision reports one instance for most images — a bee on
a flower is *one subject* to it — so this fixes plates, not substrate.

66 of 70 random taxa segmented; 4 returned no foreground instance, which is an
honest refusal and needs no gate.

### 5.2 Reframing — do not skip this

The first implementation traced the whole frame, so the SVG viewBox was the
whole photograph. Measured on the random 66, the subject filled a median of
**46%** of the canvas, p10 **18%**, worst **1.6%**; ten of 66 were under a
quarter. Those silhouettes rendered tiny inside empty boxes *and* were computed
from few pixels.

The second pass gives a median **1.30×** linear resolution gain, up to **6.75×**.
A guard compares pass 2's mask area against pass 1's cropped area and falls back
to pass 1 outside the band (0.55, 1.8), because a tight crop can lose the figure.

Tight viewBoxes mean on-screen size carries no hint of real organism size. That
is already true of PhyloPic's own SVGs, so this makes the two **consistent**
rather than introducing a second convention.

### 5.3 Tracing

```
potrace -s -a 1.2 -t 6 -O 0.45 --flat -u 1
```

`-u 1` is the load-bearing flag. Reframing pushed SVGs from 3.41 KB to 5.63 KB
because the outline resolves detail it previously discarded, and a wide sweep of
`-a`/`-t`/`-O` moved that only from 5.79 to 5.50 KB — **the bytes are coordinate
precision, not curve count**. Quantising to whole pixels on a 900 px subject is
far below visible error and returns the file to its original size:

| | raw | gzipped |
|---|---|---|
| full-frame canvas | 3.41 KB | 1.63 KB |
| reframed | 5.63 KB | 2.50 KB |
| **reframed + `-u 1`** | **~4.3 KB** | **~1.6 KB** |

Reframing is free. Output is a single path, `fill="currentColor"`, so the UI
themes it like any PhyloPic SVG.

potrace is GPLv2 and is a build-time tool only; its output is not a derivative
of it.

---

## 6. Rejection

An earlier rule accepted 41% and a hand-labelling pass called 53% "usable". Both
used the wrong bar. The alternative is not a good silhouette, it is a drawing
borrowed from a taxon 706 tips away, so **only output carrying no shape
information at all is refused**:

| refuse when | catches |
|---|---|
| subject < 0.4% of frame | specimen plates where the organism is a speck |
| compactness > 0.88 | featureless discs — shell photos, lichen coins |
| bbox fill > 0.92 | featureless rectangles — figure panels, vegetation walls |

**64 of 66 ship: a 97% accept rate.** A refused node keeps its borrowed
silhouette and loses nothing.

Two failure modes survive this and are accepted knowingly. **Substrate**: a bird
arrives with its branch, an insect with its stem, because Vision considers them
one subject. **Vegetation**: dense foliage and herbarium sheets segment to a
mass. Both produce a shape that is still about the right organism, which is more
than the borrowed drawing manages.

---

## 7. Fetching — three findings that decide the design

### 7.1 Never use `Special:FilePath`

It is a MediaWiki app-server redirect and Wikimedia throttles it to **3.0 KB/s**,
while the same client pulls 12.8 MB/s from `files.opentreeoflife.org`. Use the
CDN directly:

```
https://upload.wikimedia.org/wikipedia/commons/thumb/{h[0]}/{h[0:2]}/{name}/{W}px-{name}
```

`name` has spaces replaced by underscores; `h = md5(name)`. Measured at
**3,568 KB/s** on a warm object.

### 7.2 Only four widths are served

**250, 500, 960, 1280.** Every other width — 320, 640, 800, 1024, 1200, 1600 —
returns `400 Use thumbnail sizes listed on https://w.wiki/GHai`, consistently
across every file tested. Use **960**, which matches the 900 px working
resolution.

### 7.3 It is request-limited, not byte-limited

22 KB thumbnails run at 0.67 img/s and 174 KB thumbnails at 0.85 img/s, with the
same number of 60 s stalls. A smaller thumbnail buys **nothing** in wall clock,
so width is a quality decision alone — and the larger thumbnail is what gives
reframing headroom on a small subject.

Sustained rate is **~0.8 img/s**: p50 latency 0.19 s warm, with a tail pinned at
the timeout. That is throttling, and it is not negotiable by concurrency.

**Pace it, checkpoint it, resume it, and order it by reader value** — nodes with
a vernacular and a high `search_rank` first. `images.py` already establishes the
precedent: an interrupted crawl has stored the images people actually resolve.
At 0.8 img/s this matters more than anywhere else in the pipeline.

---

## 8. Cost

| stage | rate | 143,604 | ~210,000 |
|---|---|---|---|
| download | 0.8 img/s | **50 h** | **73 h** |
| Vision, two passes, 8-way | 1.21 taxa/s/proc | 3.7 h | 5.4 h |
| clean + trace | 31 img/s | 1.3 h | 1.9 h |

Storage, at ~4.3 KB raw / ~1.6 KB gzipped per SVG (95% CI on the raw mean, from
n=66: [3.01, 3.81] KB before quantisation — **re-measure on the first few
thousand of the real crawl**):

| | 143,604 | ~210,000 |
|---|---|---|
| blob, raw | 630 MB | 916 MB |
| **blob, per-entry gzipped, + offsets + node index** | **~243 MB** | **~349 MB** |
| transient JPEG, streamed and discarded | 25 GB | 37 GB |

Against a 3.2 GB `build/` and the 173 MB PhyloPic mirror, the artifact is minor
and the crawl is the entire cost: **two to three days of continuous polite
fetching.**

Storage and serving are specified in `image-store.md`, not here. That contract
governs phase 5a's output too.

---

## 9. Licensing

Sampled 100 Commons files behind P18: **100% freely licensed**, as Commons
requires. CC BY-SA 3.0 24%, public domain 22%, CC BY-SA 4.0 17%, CC0 11%,
CC BY 3.0 6%, the rest ≤ 5% each.

**~49% carry ShareAlike, and an outline traced from a photograph is a
derivative**, so those SVGs inherit BY-SA. This is a data problem, not new code:
phase 5a already stores `license_url`, `attribution` and `contributor` per image
and `licence_gates` already checks them. Record the Commons filename **and
revision** as `origin_ref` so a credit can be regenerated without re-crawling.

---

## 10. Gates

**require**

- every eligible node either has an outline or a recorded refusal reason
- no accepted mask fails the §6 rules — recomputed from the mask, not trusted
  from the writer
- no generated outline is attached to a node whose `method = 'exact'`
  (PhyloPic wins, checked on the array)
- median clade a picture speaks for ≤ 400 tips (3,153 today, 270 simulated)
- every accepted image has a non-null `license_url` and `origin_ref`

**observe**

- accept rate, and the count in each refusal class
- reframe gain distribution, and how often the pass-2 guard fired
- SVG size distribution — the storage estimate depends on it
- crawl throughput, to detect a change in Wikimedia's throttle

---

## 11. Two things that will cost you

**Vision is macOS-only.** This phase builds only on a Mac, unlike every other
phase. If it must run on Linux or in CI the substitute is a U²-Net / `rembg`
ONNX model — cross-platform, unmeasured here, and expected to be worse, since
Vision produced **zero** box-filling rectangles across 66 masks.

**The Wikidata id pull is incomplete.** Everything in §3 scales with what a
complete paged pull returns. Do that first.
