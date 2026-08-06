"""Phase 5b — the ICS geologic timescale, from `chart.ttl` into `timescale.json`.

Reads the pinned ICS International Chronostratigraphic Chart (v2026/06, CC-BY)
and emits the ~40 KB reference scale the client draws beneath the chronogram.
Turtle is parsed by a small purpose-built reader rather than an RDF library:
the file uses a narrow, regular slice of the grammar and this runs once per
build. A regex almost works but misses the 36 bounds carrying `skos:note
"uncertain"` (the chart's `~` ages), so it is a real parser.

## Output shape — `build/timescale.json`

```
{
  "source":   {name, version, file, license, citation, concepts},
  "ranks":    ["Super-Eon", "Eon", ..., "Age"],   # coarse -> fine, band-row order
  "color":    {...}                              # the derived-colour recipe
  "intervals": [ Interval, ... ],   # sorted by (rank row, then oldest first)
  "index": {
    "by_id":    {"Cambrian": 41, ...},        # id -> position in `intervals`
    "by_rank":  {"Period": [30, 31, ...], ...},  # positions, one contiguous run
    "children": {"Paleozoic": [41, 42, ...], ...},  # positions
    "roots":    [0, 1]                        # positions of the two roots
  }
}
```

Every index value is a position in `intervals`, never a nested copy. An
`Interval` carries: id (URI local name), name, name_informal, rank, parent,
depth, begin_ma/begin_err/begin_approx (older bound), end_ma/end_err/end_approx,
color (derived), color_official (CGMW datum), order (sh:order). `begin_ma` is
always the older bound. 21 concepts (Lower/Middle/Upper subdivisions) have no
`skos:prefLabel`; their label is built from the CamelCase local name and marked
`name_informal` so the UI never attributes it to ICS.

## The colour clamp

Both colours ship: `color_official` is the exact CGMW hex; `color` is the
recessive instrument colour, a uniform contraction of OKLab by K about
(L_PIVOT, 0, 0) re-anchored at L_ANCHOR:

    L' = L_ANCHOR + (L - L_PIVOT) * K
    C' = C * K
    H' = H                                   # hue untouched

This is a similarity transform: every pairwise perceptual distance in the
derived palette is exactly K times the official one. `L_MIN`/`L_MAX`/`C_MAX` are
hard guards against a future ICS revision; they do not fire on v2026/06 and a
gate says so. Known limit: the four Paleoproterozoic periods sit below a JND
even in the source, so wayfinding there is by labels and dividers, not hue.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .gates import GateSet
from .paths import BUILD, SNAPSHOT

if TYPE_CHECKING:
    from collections.abc import Iterator

    from .typing_ import JsonDict

CHART = SNAPSHOT / "ics" / "chart.ttl"
OUT = BUILD / "timescale.json"

RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
SKOS = "http://www.w3.org/2004/02/skos/core#"
GTS = "http://resource.geosciml.org/ontology/timescale/gts#"
GTSD = "https://data.stratigraphy.org/data/gts/"
TIME = "http://www.w3.org/2006/time#"
SCHEMA = "https://schema.org/"
SH = "http://www.w3.org/ns/shacl#"
DCTERMS = "http://purl.org/dc/terms/"

# Coarse to fine. This is the band-row order the client draws, and it is also
# the order `intervals` is sorted in.
RANK_ORDER = ("Super-Eon", "Eon", "Era", "Period", "Sub-Period", "Epoch", "Age")

# --- measured against snapshot/ics/chart.ttl (ICS v2026/06) -----------------
EXPECT_CONCEPTS = 178
EXPECT_WITH_BROADER = 176
EXPECT_RANKS = {
    "Super-Eon": 1,
    "Eon": 4,
    "Era": 10,
    "Period": 22,
    "Sub-Period": 2,
    "Epoch": 37,
    "Age": 102,
}
EXPECT_ROOTS = ("Phanerozoic", "Precambrian")
EXPECT_UNCERTAIN_BOUNDS = 36
# Lower/Middle/Upper subdivisions carry no skos:prefLabel in any language.
EXPECT_UNLABELLED = 21
CAMBRIAN_BASE_MA = 538.8
CAMBRIAN_BASE_ERR = 0.6

# --- the colour clamp; see the module docstring ------------------------------
K = 0.22
L_PIVOT = 0.72
L_ANCHOR = 0.32
L_MIN, L_MAX = 0.24, 0.40
C_MAX = 0.060


# =============================================================================
# A small Turtle reader
# =============================================================================


class TurtleError(ValueError):
    """A parse surprise in the pinned, checksummed chart is a bug."""


@dataclass(frozen=True, slots=True)
class Iri:
    value: str


@dataclass(frozen=True, slots=True)
class Literal:
    value: str
    lang: str = ""
    datatype: str = ""


@dataclass(slots=True)
class Blank:
    props: PropMap = field(default_factory=dict)


type Term = Iri | Literal | Blank
type PropMap = dict[str, list[Term]]
type Graph = dict[str, PropMap]

_TOKENS = re.compile(
    r"""
      (?P<ws>\s+)
    | (?P<comment>\#[^\n]*)
    | (?P<longstr>\"\"\"(?:[^"\\]|\\.|\"(?!\"\"))*\"\"\")
    | (?P<string>\"(?:[^"\\\n]|\\.)*\")
    | (?P<iriref><[^<>"{}|^`\\\x00-\x20]*>)
    | (?P<at>@[A-Za-z][A-Za-z0-9-]*)
    | (?P<caret>\^\^)
    | (?P<bnode>_:[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?)
    | (?P<pname>
          (?:[A-Za-z](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?)?
          :
          (?:[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?)?
      )
    | (?P<number>[+-]?(?:\d+\.\d+(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?))
    | (?P<punct>[;,.\[\]()])
    | (?P<word>[A-Za-z][A-Za-z0-9]*)
    """,
    re.VERBOSE,
)

_ESCAPES = {
    "t": "\t",
    "b": "\b",
    "n": "\n",
    "r": "\r",
    "f": "\f",
    '"': '"',
    "'": "'",
    "\\": "\\",
}


def unescape(s: str) -> str:
    if "\\" not in s:
        return s
    out: list[str] = []
    i = 0
    while i < len(s):
        ch = s[i]
        if ch != "\\":
            out.append(ch)
            i += 1
            continue
        code = s[i + 1]
        if code in _ESCAPES:
            out.append(_ESCAPES[code])
            i += 2
        elif code in "uU":
            width = 4 if code == "u" else 8
            out.append(chr(int(s[i + 2 : i + 2 + width], 16)))
            i += 2 + width
        else:
            raise TurtleError(f"unknown string escape \\{code}")
    return "".join(out)


@dataclass(slots=True)
class Token:
    kind: str
    text: str
    pos: int


def tokenize(text: str) -> list[Token]:
    out: list[Token] = []
    pos, n = 0, len(text)
    while pos < n:
        m = _TOKENS.match(text, pos)
        if m is None:
            raise TurtleError(
                f"unlexable input at offset {pos}: {text[pos : pos + 40]!r}"
            )
        kind = m.lastgroup
        assert kind is not None
        if kind not in ("ws", "comment"):
            out.append(Token(kind, m.group(), pos))
        pos = m.end()
    return out


class _Parser:
    """Recursive descent over the token stream, one statement at a time."""

    def __init__(self, tokens: list[Token]) -> None:
        self.toks = tokens
        self.i = 0
        self.prefixes: dict[str, str] = {}
        self.base = ""
        self.graph: Graph = {}
        self.bnode_seq = 0

    # -- token helpers ----------------------------------------------------
    def peek(self, ahead: int = 0) -> Token | None:
        j = self.i + ahead
        return self.toks[j] if j < len(self.toks) else None

    def next(self) -> Token:
        if self.i >= len(self.toks):
            raise TurtleError("unexpected end of file")
        t = self.toks[self.i]
        self.i += 1
        return t

    def expect(self, text: str) -> Token:
        t = self.next()
        if t.text != text:
            raise TurtleError(f"expected {text!r}, got {t.text!r} at offset {t.pos}")
        return t

    # -- names ------------------------------------------------------------
    def expand(self, tok: Token) -> str:
        if tok.kind == "iriref":
            iri = tok.text[1:-1]
            return iri if ":" in iri else self.base + iri
        if tok.kind == "pname":
            prefix, _, local = tok.text.partition(":")
            if prefix not in self.prefixes:
                raise TurtleError(f"undeclared prefix {prefix}: at offset {tok.pos}")
            return self.prefixes[prefix] + local
        raise TurtleError(f"expected an IRI, got {tok.text!r} at offset {tok.pos}")

    # -- document ---------------------------------------------------------
    def parse(self) -> Graph:
        while self.peek() is not None:
            tok = self.peek()
            assert tok is not None
            if tok.text.lower() in ("@prefix", "prefix"):
                self.directive_prefix()
            elif tok.text.lower() in ("@base", "base"):
                self.directive_base()
            else:
                self.statement()
        return self.graph

    def directive_prefix(self) -> None:
        self.next()
        name = self.next()
        if name.kind != "pname" or not name.text.endswith(":"):
            raise TurtleError(f"bad PREFIX label {name.text!r} at offset {name.pos}")
        iri = self.next()
        if iri.kind != "iriref":
            raise TurtleError(f"bad PREFIX IRI {iri.text!r} at offset {iri.pos}")
        self.prefixes[name.text[:-1]] = iri.text[1:-1]
        self.maybe_dot()

    def directive_base(self) -> None:
        self.next()
        iri = self.next()
        if iri.kind != "iriref":
            raise TurtleError(f"bad BASE IRI {iri.text!r} at offset {iri.pos}")
        self.base = iri.text[1:-1]
        self.maybe_dot()

    def maybe_dot(self) -> None:
        t = self.peek()
        if t is not None and t.text == ".":
            self.next()

    def statement(self) -> None:
        subj_tok = self.next()
        if subj_tok.kind == "bnode":
            subject = "_:" + subj_tok.text[2:]
        elif subj_tok.text == "[":
            # `[] p o .` — an anonymous subject. Not used by chart.ttl.
            self.expect("]")
            subject = self.fresh_bnode()
        else:
            subject = self.expand(subj_tok)
        props = self.graph.setdefault(subject, {})
        self.predicate_object_list(props)
        self.expect(".")

    def fresh_bnode(self) -> str:
        self.bnode_seq += 1
        return f"_:anon{self.bnode_seq}"

    def predicate_object_list(self, props: PropMap) -> None:
        while True:
            verb_tok = self.next()
            verb = RDF_TYPE if verb_tok.text == "a" else self.expand(verb_tok)
            bucket = props.setdefault(verb, [])
            while True:
                bucket.append(self.object())
                nxt = self.peek()
                if nxt is None or nxt.text != ",":
                    break
                self.next()
            nxt = self.peek()
            if nxt is None or nxt.text != ";":
                return
            self.next()
            # A trailing `;` before the statement's `.` or a closing `]`.
            nxt = self.peek()
            if nxt is None or nxt.text in (".", "]"):
                return

    def object(self) -> Term:
        tok = self.next()
        if tok.text == "[":
            blank = Blank()
            if (nxt := self.peek()) is not None and nxt.text == "]":
                self.next()
                return blank
            self.predicate_object_list(blank.props)
            self.expect("]")
            return blank
        if tok.text == "(":
            raise TurtleError(f"RDF collections are not supported (offset {tok.pos})")
        if tok.kind in ("string", "longstr"):
            raw = tok.text[3:-3] if tok.kind == "longstr" else tok.text[1:-1]
            value = unescape(raw)
            nxt = self.peek()
            if nxt is not None and nxt.kind == "at":
                self.next()
                return Literal(value, lang=nxt.text[1:])
            if nxt is not None and nxt.kind == "caret":
                self.next()
                return Literal(value, datatype=self.expand(self.next()))
            return Literal(value)
        if tok.kind == "number":
            return Literal(tok.text, datatype="number")
        if tok.kind == "word" and tok.text in ("true", "false"):
            return Literal(tok.text, datatype="boolean")
        if tok.kind == "bnode":
            return Iri("_:" + tok.text[2:])
        return Iri(self.expand(tok))


def parse_turtle(text: str) -> Graph:
    return _Parser(tokenize(text)).parse()


# -- accessors over a parsed graph -------------------------------------------


def one(props: PropMap, predicate: str) -> Term | None:
    terms = props.get(predicate)
    return terms[0] if terms else None


def iri_local(term: Term | None) -> str | None:
    if not isinstance(term, Iri):
        return None
    _, sep, local = term.value.rpartition("/")
    if not sep or not local:
        _, _, local = term.value.rpartition("#")
    return local or None


def lang_value(props: PropMap, predicate: str, lang: str = "en") -> str | None:
    for term in props.get(predicate, []):
        if isinstance(term, Literal) and term.lang == lang:
            return term.value
    return None


def number(term: Term | None) -> float | None:
    if isinstance(term, Literal):
        return float(term.value)
    return None


_CAMEL = re.compile(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)")


def humanise(local: str) -> str:
    """`LowerOrdovician` -> `Lower Ordovician`, for the 21 unlabelled concepts."""
    return _CAMEL.sub(" ", local)


# =============================================================================
# Colour: sRGB <-> OKLab <-> OKLCh, and the dim-band transform
# =============================================================================


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c: float) -> float:
    return 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def hex_to_rgb(value: str) -> tuple[float, float, float]:
    h = value.lstrip("#")
    if len(h) != 6:
        raise ValueError(f"not a 6-digit hex colour: {value!r}")
    return int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255


def rgb_to_hex(rgb: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c * 255))):02X}" for c in rgb)


def rgb_to_oklab(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    """Ottosson's OKLab. Input is *non-linear* sRGB in 0..1."""
    r, g, b = (srgb_to_linear(c) for c in rgb)
    lms_l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    lms_m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    lms_s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    cl, cm, cs = (math.copysign(abs(v) ** (1 / 3), v) for v in (lms_l, lms_m, lms_s))
    return (
        0.2104542553 * cl + 0.7936177850 * cm - 0.0040720468 * cs,
        1.9779984951 * cl - 2.4285922050 * cm + 0.4505937099 * cs,
        0.0259040371 * cl + 0.7827717662 * cm - 0.8086757660 * cs,
    )


def oklab_to_rgb(lab: tuple[float, float, float]) -> tuple[float, float, float]:
    """Inverse of `rgb_to_oklab`. May return values outside 0..1 (out of gamut)."""
    lightness, a, b = lab
    cl = lightness + 0.3963377774 * a + 0.2158037573 * b
    cm = lightness - 0.1055613458 * a - 0.0638541728 * b
    cs = lightness - 0.0894841775 * a - 1.2914855480 * b
    lms_l, lms_m, lms_s = cl**3, cm**3, cs**3
    return (
        linear_to_srgb(
            4.0767416621 * lms_l - 3.3077115913 * lms_m + 0.2309699292 * lms_s
        ),
        linear_to_srgb(
            -1.2684380046 * lms_l + 2.6097574011 * lms_m - 0.3413193965 * lms_s
        ),
        linear_to_srgb(
            -0.0041960863 * lms_l - 0.7034186147 * lms_m + 1.7076147010 * lms_s
        ),
    )


def oklab_to_oklch(lab: tuple[float, float, float]) -> tuple[float, float, float]:
    lightness, a, b = lab
    return lightness, math.hypot(a, b), math.atan2(b, a)


def oklch_to_oklab(lch: tuple[float, float, float]) -> tuple[float, float, float]:
    lightness, chroma, hue = lch
    return lightness, chroma * math.cos(hue), chroma * math.sin(hue)


def hex_to_oklab(value: str) -> tuple[float, float, float]:
    return rgb_to_oklab(hex_to_rgb(value))


def oklab_to_hex(lab: tuple[float, float, float]) -> str:
    return rgb_to_hex(oklab_to_rgb(lab))


def in_srgb_gamut(lab: tuple[float, float, float], eps: float = 1e-6) -> bool:
    return all(-eps <= c <= 1 + eps for c in oklab_to_rgb(lab))


def dim(official: str) -> tuple[str, tuple[float, float, float], bool]:
    """Contract a CGMW colour onto the recessive band.

    Returns the derived hex, its OKLab coordinates, and whether the hard
    lightness/chroma guards had to fire. Hue is never touched.
    """
    lightness, chroma, hue = oklab_to_oklch(hex_to_oklab(official))
    lightness = L_ANCHOR + (lightness - L_PIVOT) * K
    chroma *= K
    clamped_l = min(max(lightness, L_MIN), L_MAX)
    clamped_c = min(chroma, C_MAX)
    guarded = clamped_l != lightness or clamped_c != chroma
    lab = oklch_to_oklab((clamped_l, clamped_c, hue))
    return oklab_to_hex(lab), lab, guarded


def delta_e(x: tuple[float, float, float], y: tuple[float, float, float]) -> float:
    """Euclidean distance in OKLab. Close enough to a ΔE for band comparison."""
    return math.dist(x, y)


# =============================================================================
# Extraction
# =============================================================================


@dataclass(slots=True)
class Interval:
    id: str
    uri: str
    name: str
    name_informal: bool
    rank: str
    parent: str | None
    depth: int
    begin_ma: float
    begin_err: float | None
    begin_approx: bool
    end_ma: float
    end_err: float | None
    end_approx: bool
    color: str
    color_official: str
    order: int
    # Not serialised; the gates work in OKLab.
    lab: tuple[float, float, float] = (0.0, 0.0, 0.0)
    lab_official: tuple[float, float, float] = (0.0, 0.0, 0.0)
    guarded: bool = False

    def to_json(self) -> JsonDict:
        return {
            "id": self.id,
            "name": self.name,
            "name_informal": self.name_informal,
            "rank": self.rank,
            "parent": self.parent,
            "depth": self.depth,
            "begin_ma": self.begin_ma,
            "begin_err": self.begin_err,
            "begin_approx": self.begin_approx,
            "end_ma": self.end_ma,
            "end_err": self.end_err,
            "end_approx": self.end_approx,
            "color": self.color,
            "color_official": self.color_official,
            "order": self.order,
        }


def bound(props: PropMap, predicate: str) -> tuple[float | None, float | None, bool]:
    """Read a `time:hasBeginning` / `time:hasEnd` blank node.

    36 of the 356 bounds carry `skos:note "uncertain"` — the chart's `~`
    approximate ages — and it sits *before* `gtsd:inMYA` in the blank node.
    """
    node = one(props, predicate)
    if not isinstance(node, Blank):
        return None, None, False
    ma = number(one(node.props, GTSD + "inMYA"))
    err = number(one(node.props, SCHEMA + "marginOfError"))
    approx = any(
        isinstance(t, Literal) and t.value == "uncertain"
        for t in node.props.get(SKOS + "note", [])
    )
    return ma, err, approx


def concepts(graph: Graph) -> Iterator[tuple[str, PropMap]]:
    for subject, props in graph.items():
        types = props.get(RDF_TYPE, [])
        if any(isinstance(t, Iri) and t.value == SKOS + "Concept" for t in types):
            yield subject, props


def extract(graph: Graph) -> list[Interval]:
    out: list[Interval] = []
    for uri, props in concepts(graph):
        local = uri.rpartition("/")[2]
        rank = iri_local(one(props, GTS + "rank"))
        color_official = ""
        term = one(props, SCHEMA + "color")
        if isinstance(term, Literal):
            color_official = term.value.upper()
        begin_ma, begin_err, begin_approx = bound(props, TIME + "hasBeginning")
        end_ma, end_err, end_approx = bound(props, TIME + "hasEnd")
        order = number(one(props, SH + "order"))
        parent_term = one(props, SKOS + "broader")
        derived, lab, guarded = (
            dim(color_official) if color_official else ("", (0.0, 0.0, 0.0), False)
        )
        # The Lower/Middle/Upper subdivisions carry no skos:prefLabel; build the
        # label from the URI and flag it informal.
        label = lang_value(props, SKOS + "prefLabel")
        out.append(
            Interval(
                id=local,
                uri=uri,
                name=label or humanise(local),
                name_informal=label is None,
                rank=rank or "",
                parent=iri_local(parent_term),
                depth=0,
                begin_ma=begin_ma if begin_ma is not None else math.nan,
                begin_err=begin_err,
                begin_approx=begin_approx,
                end_ma=end_ma if end_ma is not None else math.nan,
                end_err=end_err,
                end_approx=end_approx,
                color=derived,
                color_official=color_official,
                order=int(order) if order is not None else -1,
                lab=lab,
                lab_official=hex_to_oklab(color_official) if color_official else lab,
                guarded=guarded,
            )
        )

    by_id = {iv.id: iv for iv in out}
    for iv in out:
        depth, cursor, seen = 0, iv.parent, {iv.id}
        while cursor is not None and cursor in by_id and cursor not in seen:
            seen.add(cursor)
            depth += 1
            cursor = by_id[cursor].parent
        iv.depth = depth

    rank_rank = {name: i for i, name in enumerate(RANK_ORDER)}
    out.sort(key=lambda iv: (rank_rank.get(iv.rank, len(RANK_ORDER)), -iv.begin_ma))
    return out


def build_document(intervals: list[Interval], citation: str, version: str) -> JsonDict:
    pos = {iv.id: i for i, iv in enumerate(intervals)}
    by_rank: dict[str, list[int]] = {}
    children: dict[str, list[int]] = {}
    roots: list[int] = []
    for i, iv in enumerate(intervals):
        by_rank.setdefault(iv.rank, []).append(i)
        if iv.parent is None:
            roots.append(i)
        else:
            children.setdefault(iv.parent, []).append(i)
    for kids in children.values():
        kids.sort(key=lambda i: -intervals[i].begin_ma)

    return {
        "source": {
            "name": "ICS International Chronostratigraphic Chart",
            "version": version,
            "file": f"snapshot/ics/{CHART.name}",
            "uri_base": GTSD,
            "license": "CC-BY-4.0",
            "citation": citation,
            "concepts": len(intervals),
        },
        "ranks": [r for r in RANK_ORDER if r in by_rank],
        "color": {
            "note": (
                "`color_official` is the CGMW datum. `color` is a uniform "
                "contraction of OKLab about (L_PIVOT, 0, 0) by K, re-anchored at "
                "L_ANCHOR: hue is preserved exactly and every pairwise "
                "perceptual distance is K times the official one."
            ),
            "space": "oklab",
            "k": K,
            "l_pivot": L_PIVOT,
            "l_anchor": L_ANCHOR,
            "l_range": [L_MIN, L_MAX],
            "c_max": C_MAX,
        },
        "intervals": [iv.to_json() for iv in intervals],
        "index": {
            "by_id": pos,
            "by_rank": by_rank,
            "children": children,
            "roots": roots,
        },
    }


# =============================================================================
# Phase entry point
# =============================================================================


def chart_version(graph: Graph) -> str:
    for props in graph.values():
        term = one(props, "http://www.w3.org/2002/07/owl#versionInfo")
        if isinstance(term, Literal):
            return term.value
    return "v2026/06"


def run() -> int:
    g = GateSet("phase5b-timescale")

    print(f"--- parsing {CHART.name} ({CHART.stat().st_size:,} B) ---", flush=True)
    graph = parse_turtle(CHART.read_text(encoding="utf-8"))
    print(f"  {len(graph):,} subjects", flush=True)

    intervals = extract(graph)
    by_id = {iv.id: iv for iv in intervals}
    citation = (
        lang_value(graph.get(DCTERMS + "bibliographicCitation", {}), SKOS + "prefLabel")
        or ""
    )

    # --- structure -------------------------------------------------------
    print("\n--- structure ---", flush=True)
    g.require("concepts parsed", len(intervals), EXPECT_CONCEPTS)
    g.require(
        "concepts carrying a label",
        sum(1 for i in intervals if i.name),
        EXPECT_CONCEPTS,
    )
    g.require(
        "concepts with no skos:prefLabel in any language",
        sum(1 for i in intervals if i.name_informal),
        EXPECT_UNLABELLED,
        note=(
            "the Lower/Middle/Upper subdivisions, which the printed chart sets in "
            "italic as informal; their label is derived from the URI local name and "
            "flagged name_informal so the UI never attributes it to ICS"
        ),
    )
    g.require(
        "concepts with a rank", sum(1 for i in intervals if i.rank), EXPECT_CONCEPTS
    )
    g.require(
        "concepts with begin and end ages",
        sum(
            1 for i in intervals if not (math.isnan(i.begin_ma) or math.isnan(i.end_ma))
        ),
        EXPECT_CONCEPTS,
    )
    g.require(
        "concepts with an official colour",
        sum(1 for i in intervals if i.color_official),
        EXPECT_CONCEPTS,
    )
    g.require(
        "concepts with a skos:broader parent",
        sum(1 for i in intervals if i.parent),
        EXPECT_WITH_BROADER,
    )
    counts = {r: sum(1 for i in intervals if i.rank == r) for r in RANK_ORDER}
    g.require("rank histogram", counts, EXPECT_RANKS)
    g.require(
        "roots (no skos:broader)",
        tuple(sorted(i.id for i in intervals if i.parent is None)),
        EXPECT_ROOTS,
    )
    g.require(
        "parents that resolve to a parsed concept",
        sum(1 for i in intervals if i.parent is not None and i.parent not in by_id),
        0,
    )
    g.require(
        "sh:order is a permutation of 1..N",
        sorted(i.order for i in intervals) == list(range(1, len(intervals) + 1)),
        True,
    )
    g.require(
        "rank is monotone along skos:broader",
        sum(
            1
            for i in intervals
            if i.parent
            and RANK_ORDER.index(by_id[i.parent].rank) >= RANK_ORDER.index(i.rank)
        ),
        0,
        note="a child band is always finer-ranked than its parent, so `by_rank` is a band row",
    )

    # --- ages ------------------------------------------------------------
    print("\n--- ages ---", flush=True)
    cambrian = by_id["Cambrian"]
    g.require(
        "Cambrian base age (Ma)",
        cambrian.begin_ma,
        CAMBRIAN_BASE_MA,
        note="the correctness check on the age parse; ICS v2026/06",
    )
    g.require(
        "Cambrian base margin of error (Ma)", cambrian.begin_err, CAMBRIAN_BASE_ERR
    )
    g.require(
        "begin_ma >= end_ma everywhere",
        sum(1 for i in intervals if i.begin_ma < i.end_ma),
        0,
        note="begin is the older bound",
    )
    g.require(
        "child intervals lie inside their parent",
        sum(
            1
            for i in intervals
            if i.parent
            and not (
                by_id[i.parent].begin_ma + 1e-9 >= i.begin_ma
                and by_id[i.parent].end_ma - 1e-9 <= i.end_ma
            )
        ),
        0,
    )
    n_approx = sum(i.begin_approx + i.end_approx for i in intervals)
    g.require(
        "bounds flagged uncertain",
        n_approx,
        EXPECT_UNCERTAIN_BOUNDS,
        note="the chart's `~` ages; a regex on hasBeginning[inMYA misses these",
    )
    g.observe(
        "bounds carrying a marginOfError",
        sum((i.begin_err is not None) + (i.end_err is not None) for i in intervals),
        note="null where ICS records none; the UI must not invent a ±",
    )

    # --- colour ----------------------------------------------------------
    print("\n--- colour ---", flush=True)
    g.require(
        "official colours surviving an sRGB->OKLab->sRGB round trip",
        sum(1 for i in intervals if oklab_to_hex(i.lab_official) == i.color_official),
        EXPECT_CONCEPTS,
        note="proves the conversion matrices, not just that they ran",
    )
    g.require(
        "derived colours in sRGB gamut without clipping",
        sum(1 for i in intervals if not in_srgb_gamut(i.lab)),
        0,
    )
    g.require(
        "derived bands needing the L/C guard",
        sum(1 for i in intervals if i.guarded),
        0,
        note=f"the recipe already lands inside L {L_MIN}-{L_MAX}, C<={C_MAX}",
    )
    lightness = [i.lab[0] for i in intervals]
    chroma = [math.hypot(i.lab[1], i.lab[2]) for i in intervals]
    g.observe(
        "derived band, OKLab",
        f"L {min(lightness):.3f}-{max(lightness):.3f}, C {min(chroma):.4f}-{max(chroma):.4f}",
        note="canvas is L 0.145-0.174 (#0A0A0B-#101012); the band recedes and never glows",
    )

    periods = [i for i in intervals if i.rank == "Period"]
    worst = min(
        (
            (delta_e(a.lab, b.lab), delta_e(a.lab_official, b.lab_official), a.id, b.id)
            for n, a in enumerate(periods)
            for b in periods[n + 1 :]
        ),
        default=(0.0, 0.0, "", ""),
    )
    g.observe(
        "period sibling min ΔE (OKLab)",
        round(worst[0], 4),
        note=(
            f"{worst[2]}/{worst[3]}; official {worst[1]:.4f}. Below a JND, and so is "
            f"the source: ICS separates the Paleoproterozoic periods by a lightness "
            f"ramp we deliberately contract. Labels and hairline dividers do the "
            f"wayfinding there (architecture §6)."
        ),
    )
    # The contraction is a similarity transform, so every derived distance must
    # be exactly K times its official counterpart.
    drift = max(
        (
            abs(delta_e(a.lab, b.lab) - K * delta_e(a.lab_official, b.lab_official))
            for n, a in enumerate(periods)
            for b in periods[n + 1 :]
        ),
        default=0.0,
    )
    g.require(
        "derived palette is a faithful K-contraction of CGMW",
        drift < 1e-9,
        True,
        note=f"max |ΔE_derived - {K}·ΔE_official| over period pairs = {drift:.2e}",
    )

    # --- write -----------------------------------------------------------
    print("\n--- writing artifacts ---", flush=True)
    doc = build_document(intervals, citation, chart_version(graph))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    size = OUT.stat().st_size
    g.require(
        "timescale.json size",
        f"{size / 1024:.1f} KB",
        "~40 KB",
        ok=20_000 <= size <= 80_000,
        note="served immutable at /v1/timescale (architecture §4)",
    )
    g.observe("citation carried through for CC-BY attribution", bool(citation))

    g.write(BUILD / "phase5b_gates.json")
    g.exit_if_failed()
    return 0
