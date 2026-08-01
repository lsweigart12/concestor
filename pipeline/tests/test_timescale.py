import math

import pytest

from concestor_build.timescale import (
    C_MAX,
    GTSD,
    L_MAX,
    L_MIN,
    SKOS,
    Blank,
    Iri,
    K,
    Literal,
    TurtleError,
    delta_e,
    dim,
    extract,
    hex_to_oklab,
    humanise,
    in_srgb_gamut,
    oklab_to_hex,
    oklab_to_oklch,
    oklch_to_oklab,
    parse_turtle,
)

# A miniature chart.ttl. Every shape the real file uses appears here at least
# once: SPARQL-style PREFIX with no trailing dot, the `a` keyword, blank-node
# property lists, language-tagged and datatyped literals, decimals and
# integers, booleans, a comment, a long string, and — the one that matters —
# `skos:note "uncertain"` sitting *ahead* of `gtsd:inMYA` inside the bound.
FIXTURE = """
PREFIX gts: <http://resource.geosciml.org/ontology/timescale/gts#>
PREFIX gtsd: <https://data.stratigraphy.org/data/gts/>
PREFIX rank: <http://resource.geosciml.org/ontology/timescale/rank/>
PREFIX schema: <https://schema.org/>
PREFIX sh: <http://www.w3.org/ns/shacl#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX time: <http://www.w3.org/2006/time#>

# A comment, which must not be mistaken for a colour.
gtsd:Paleozoic
    a skos:Concept ;
    gts:rank rank:Era ;
    gts:ratifiedGSSP true ;
    skos:prefLabel
        "Paleozoic"@en ,
        "Paläozoikum"@de ;
    skos:narrower gtsd:Cambrian ;
    time:hasBeginning [ gtsd:inMYA 538.8 ; schema:marginOfError 0.6 ; ] ;
    time:hasEnd [ gtsd:inMYA 251.9 ; ] ;
    sh:order 155 ;
    schema:color "#99C08D"^^gtsd:RGBHex ;
.

gtsd:Cambrian
    a skos:Concept ;
    gts:rank rank:Period ;
    skos:broader gtsd:Paleozoic ;
    skos:prefLabel "Cambrian"@en ;
    skos:definition \"\"\"A long
    definition, spanning lines.\"\"\"@en ;
    time:hasBeginning
        [
            skos:note "uncertain" ;
            gtsd:inMYA 538.8 ;
        ] ;
    time:hasEnd [ gtsd:inMYA 486.85 ; schema:marginOfError 1.5 ; ] ;
    sh:order 154 ;
    schema:color "#7FA056"^^gtsd:RGBHex ;
.

gtsd:LowerOrdovician
    a skos:Concept ;
    gts:rank rank:Epoch ;
    skos:broader gtsd:Cambrian ;
    time:hasBeginning [ gtsd:inMYA 486.85 ; ] ;
    time:hasEnd [ gtsd:inMYA 471.3 ; ] ;
    sh:order 139 ;
    schema:color "#1A9D6F"^^gtsd:RGBHex ;
.
"""


# --- the Turtle reader ------------------------------------------------------


def test_prefixes_expand_and_the_a_keyword_is_rdf_type():
    graph = parse_turtle(FIXTURE)
    props = graph[GTSD + "Cambrian"]
    types = props["http://www.w3.org/1999/02/22-rdf-syntax-ns#type"]
    assert types == [Iri(SKOS + "Concept")]
    assert props[SKOS + "broader"] == [Iri(GTSD + "Paleozoic")]


def test_language_tags_and_datatypes_survive():
    props = parse_turtle(FIXTURE)[GTSD + "Paleozoic"]
    labels = props[SKOS + "prefLabel"]
    assert Literal("Paleozoic", lang="en") in labels
    assert Literal("Paläozoikum", lang="de") in labels
    color = props["https://schema.org/color"][0]
    assert color == Literal("#99C08D", datatype=GTSD + "RGBHex")


def test_long_strings_and_comments_do_not_confuse_the_lexer():
    props = parse_turtle(FIXTURE)[GTSD + "Cambrian"]
    definition = props[SKOS + "definition"][0]
    assert isinstance(definition, Literal)
    assert definition.lang == "en"
    assert definition.value.startswith("A long\n")
    # `# A comment` above Paleozoic must not have produced a subject, and the
    # `#` inside "#7FA056" must not have started one.
    assert props["https://schema.org/color"] == [
        Literal("#7FA056", datatype=GTSD + "RGBHex")
    ]


def test_blank_nodes_keep_their_property_list():
    props = parse_turtle(FIXTURE)[GTSD + "Paleozoic"]
    begin = props["http://www.w3.org/2006/time#hasBeginning"][0]
    assert isinstance(begin, Blank)
    assert begin.props[GTSD + "inMYA"] == [Literal("538.8", datatype="number")]
    assert begin.props["https://schema.org/marginOfError"] == [
        Literal("0.6", datatype="number")
    ]


def test_a_note_ahead_of_inmya_is_still_found():
    # The regex trap: 36 real bounds put `skos:note "uncertain"` before the
    # age, and a `hasBeginning\\s*\\[\\s*gtsd:inMYA` pattern misses all of them.
    begin = parse_turtle(FIXTURE)[GTSD + "Cambrian"][
        "http://www.w3.org/2006/time#hasBeginning"
    ][0]
    assert isinstance(begin, Blank)
    assert begin.props[SKOS + "note"] == [Literal("uncertain")]
    assert begin.props[GTSD + "inMYA"] == [Literal("538.8", datatype="number")]


def test_integers_and_booleans_are_distinguishable_from_names():
    graph = parse_turtle(FIXTURE)
    assert graph[GTSD + "Cambrian"]["http://www.w3.org/ns/shacl#order"] == [
        Literal("154", datatype="number")
    ]
    ratified = graph[GTSD + "Paleozoic"][
        "http://resource.geosciml.org/ontology/timescale/gts#ratifiedGSSP"
    ]
    assert ratified == [Literal("true", datatype="boolean")]


def test_malformed_input_raises_rather_than_guessing():
    with pytest.raises(TurtleError, match="undeclared prefix"):
        parse_turtle("nope:Thing a nope:Other .")
    with pytest.raises(TurtleError, match="collections are not supported"):
        parse_turtle("PREFIX p: <http://x/>\np:s p:list ( p:a p:b ) .")
    with pytest.raises(TurtleError, match="unexpected end of file"):
        parse_turtle("PREFIX p: <http://x/>\np:s p:o p:v")
    with pytest.raises(TurtleError, match="unlexable"):
        parse_turtle("PREFIX p: <http://x/>\np:s p:o {} .")


# --- extraction -------------------------------------------------------------


def test_extract_reads_ages_parents_and_the_uncertain_flag():
    by_id = {iv.id: iv for iv in extract(parse_turtle(FIXTURE))}
    assert set(by_id) == {"Paleozoic", "Cambrian", "LowerOrdovician"}

    cambrian = by_id["Cambrian"]
    assert cambrian.name == "Cambrian"
    assert cambrian.rank == "Period"
    assert cambrian.parent == "Paleozoic"
    assert cambrian.depth == 1
    assert (cambrian.begin_ma, cambrian.begin_err) == (538.8, None)
    assert cambrian.begin_approx is True
    assert (cambrian.end_ma, cambrian.end_err) == (486.85, 1.5)
    assert cambrian.end_approx is False
    assert cambrian.color_official == "#7FA056"
    assert cambrian.order == 154

    assert by_id["Paleozoic"].parent is None
    assert by_id["Paleozoic"].depth == 0
    assert by_id["LowerOrdovician"].depth == 2


def test_intervals_sort_into_band_rows_coarse_to_fine():
    ranks = [iv.rank for iv in extract(parse_turtle(FIXTURE))]
    assert ranks == ["Era", "Period", "Epoch"]


def test_an_absent_preflabel_is_derived_and_flagged():
    by_id = {iv.id: iv for iv in extract(parse_turtle(FIXTURE))}
    # 21 real concepts carry no skos:prefLabel in any language.
    assert by_id["LowerOrdovician"].name == "Lower Ordovician"
    assert by_id["LowerOrdovician"].name_informal is True
    assert by_id["Cambrian"].name_informal is False


def test_humanise_splits_camel_case_and_trailing_numbers():
    assert humanise("LowerOrdovician") == "Lower Ordovician"
    assert humanise("UpperPleistocene") == "Upper Pleistocene"
    assert humanise("CambrianStage10") == "Cambrian Stage 10"
    assert humanise("Cambrian") == "Cambrian"


# --- colour -----------------------------------------------------------------

# Real chart hexes, spread across the palette: Cambrian green, the Permian
# orange that motivates the whole clamp, the darkest concept (Triassic purple),
# the least saturated (Carboniferous), and a near-white Quaternary stage.
CGMW_SAMPLES = [
    "#7FA056",
    "#F04028",
    "#812B92",
    "#67A599",
    "#FDEDEC",
    "#F9F97F",
    "#009270",
]

# The above plus the canvas and the sRGB corners, for the conversion maths.
SAMPLES = [*CGMW_SAMPLES, "#0A0A0B", "#000000", "#FFFFFF", "#FF0000", "#0000FF"]


@pytest.mark.parametrize("hex_color", SAMPLES)
def test_srgb_oklab_round_trip_is_exact_at_8_bit(hex_color):
    assert oklab_to_hex(hex_to_oklab(hex_color)) == hex_color


@pytest.mark.parametrize("hex_color", SAMPLES)
def test_oklab_oklch_round_trip(hex_color):
    lab = hex_to_oklab(hex_color)
    assert oklch_to_oklab(oklab_to_oklch(lab)) == pytest.approx(lab, abs=1e-12)


def test_oklab_matches_ottossons_published_values():
    # White is L=1 with no chroma; the primaries are the reference points the
    # matrices are usually checked against.
    lightness, a, b = hex_to_oklab("#FFFFFF")
    assert (lightness, a, b) == pytest.approx((1.0, 0.0, 0.0), abs=1e-6)
    assert hex_to_oklab("#000000") == pytest.approx((0.0, 0.0, 0.0), abs=1e-9)
    assert hex_to_oklab("#FF0000") == pytest.approx(
        (0.6279554, 0.2248630, 0.1258463), abs=1e-6
    )


@pytest.mark.parametrize("hex_color", CGMW_SAMPLES)
def test_dim_preserves_hue_exactly(hex_color):
    official_lab = hex_to_oklab(hex_color)
    _, derived_lab, guarded = dim(hex_color)
    assert guarded is False
    official_h = math.atan2(official_lab[2], official_lab[1])
    derived_h = math.atan2(derived_lab[2], derived_lab[1])
    assert derived_h == pytest.approx(official_h, abs=1e-12)


@pytest.mark.parametrize("hex_color", CGMW_SAMPLES)
def test_dim_lands_inside_the_recessive_band_and_in_gamut(hex_color):
    _, lab, _ = dim(hex_color)
    assert L_MIN <= lab[0] <= L_MAX
    assert math.hypot(lab[1], lab[2]) <= C_MAX
    assert in_srgb_gamut(lab)


def test_dim_is_a_uniform_contraction_so_relationships_survive():
    # The whole justification for the clamp: it is a similarity transform, so
    # every pairwise perceptual distance shrinks by exactly K and none of the
    # palette's structure is invented or destroyed.
    for i, x in enumerate(CGMW_SAMPLES):
        for y in CGMW_SAMPLES[i + 1 :]:
            official = delta_e(hex_to_oklab(x), hex_to_oklab(y))
            derived = delta_e(dim(x)[1], dim(y)[1])
            assert derived == pytest.approx(K * official, abs=1e-12)


def test_the_guard_fires_and_reports_itself_outside_the_cgmw_range():
    # Nothing in ICS v2026/06 needs the guard — a gate asserts that — but a
    # future revision could, and the caller has to be able to see it happen.
    assert dim("#000000")[2] is True  # darker than any chart colour
    assert dim("#0000FF")[2] is True  # more saturated than any chart colour
    for out_of_range in ("#000000", "#0000FF"):
        _, lab, _ = dim(out_of_range)
        assert L_MIN <= lab[0] <= L_MAX
        assert math.hypot(lab[1], lab[2]) <= C_MAX + 1e-12


def test_the_band_sits_above_the_canvas_but_far_below_a_trace():
    canvas = hex_to_oklab("#101012")[0]
    trace = hex_to_oklab("#7FF3E0")[0]  # a cool luminous trace, per the design ref
    for hex_color in CGMW_SAMPLES:
        band = dim(hex_color)[1][0]
        assert canvas < band < trace
