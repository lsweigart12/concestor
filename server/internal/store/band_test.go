package store

import "testing"

func TestMatchBand(t *testing.T) {
	cases := []struct {
		name, q string
		want    int
	}{
		{"dog family", "dog", bandToken},
		{"dogbane family", "dog", bandPrefix},
		{"dogbane", "dog", bandPrefix},
		{"Canidae", "dog", bandNone},
		{"shark", "shark", bandExact},
		{"Shark", "shark", bandExact},
		// A plural is the same word. This asserted bandPrefix until the plural
		// rule landed, which was the defect that made "animal" rank Arthropoda
		// over Metazoa: vernaculars are stored plural and people type singular.
		{"mackerel sharks", "shark", bandToken},
		{"animals", "animal", bandToken},
		{"animal", "animals", bandToken},
		{"arthropod animal", "animal", bandToken},
		{"dog family", "dogs", bandToken},
		{"finches", "finch", bandToken},
		// Still a prefix, not a plural: "bane" is not a suffix that makes one.
		{"dogbane family", "dog", bandPrefix},
		// Too short to pluralise safely — otherwise "go" matches "goes" as a
		// whole word, and nothing three letters or shorter is a common name.
		{"goes nowhere", "go", bandPrefix},
		{"Shark catfish", "shark", bandToken},
		{"Homo sapiens", "homo sapiens", bandExact},
		{"Homo sapiens neanderthalensis", "homo sapiens", bandToken},
		{"Homo sapiens", "homo sap", bandPrefix},
		{"T. rex", "t. rex", bandExact},
		{"Tyrannosaurus rex", "rex", bandToken},
		{"Tyrannosaurus rex", "tyranno", bandPrefix},
		{"Cantharellales", "can", bandPrefix},
		{"human lice", "human", bandToken},
		{"Human Fleas", "human", bandToken},
		{"human", "human", bandExact},
		// A hyphen binds a compound word: "can" is a prefix of "can-opener",
		// not a whole word inside it.
		{"Can-opener Smoothdream", "can", bandPrefix},
		{"Can-opener Smoothdream", "can-opener", bandToken},
		{"dog-faced bat", "dog", bandPrefix},
		{"", "dog", bandNone},
		{"dog", "", bandNone},
	}
	for _, c := range cases {
		if got := matchBand(c.name, c.q); got != c.want {
			t.Errorf("matchBand(%q, %q) = %d, want %d", c.name, c.q, got, c.want)
		}
	}
}

func TestLongestToken(t *testing.T) {
	for q, want := range map[string]int{"a": 1, "T. rex": 3, "Can": 3, "": 0, "Homo sapiens": 7} {
		if got := longestToken(q); got != want {
			t.Errorf("longestToken(%q) = %d, want %d", q, got, want)
		}
	}
}
