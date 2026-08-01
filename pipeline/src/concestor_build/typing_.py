"""Shared type aliases.

The topology is a handful of flat numpy arrays whose dtypes are load-bearing —
`parent` being `u32` is what makes it 10.9 MB rather than 21.8 — so the aliases
name the dtype rather than hiding behind a bare `np.ndarray`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import numpy as np
from numpy.typing import NDArray

# Topology arrays, per architecture §3.2.
type U8Array = NDArray[np.uint8]
type U32Array = NDArray[np.uint32]
type I64Array = NDArray[np.int64]
type U64Array = NDArray[np.uint64]
type F32Array = NDArray[np.float32]
type F64Array = NDArray[np.float64]
type BoolArray = NDArray[np.bool_]

# `depth` is u8 for the synthesis tree and u32 for a fully-resolved chronogram,
# whose depth exceeds 255.
type DepthArray = NDArray[np.uint8] | NDArray[np.uint32]

# Phases print progress as they go; tests and subagents pass something else.
type Log = Callable[[str], None]

# Decoded JSON. `Any` is the honest type for a payload whose shape is the
# remote service's business, not ours.
type Json = Any
type JsonDict = dict[str, Any]
