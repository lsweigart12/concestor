"""Shared type aliases.

Array dtypes are load-bearing (`parent` as `u32` halves its size), so the
aliases name the dtype rather than using a bare `np.ndarray`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import numpy as np
from numpy.typing import NDArray

type U8Array = NDArray[np.uint8]
type U32Array = NDArray[np.uint32]
type I64Array = NDArray[np.int64]
type U64Array = NDArray[np.uint64]
type F32Array = NDArray[np.float32]
type F64Array = NDArray[np.float64]
type BoolArray = NDArray[np.bool_]

# `depth` is u8 for the synthesis tree and u32 for a chronogram (depth > 255).
type DepthArray = NDArray[np.uint8] | NDArray[np.uint32]

type Log = Callable[[str], None]

# Decoded JSON, whose shape is the remote service's business.
type Json = Any
type JsonDict = dict[str, Any]
