"""Make the pure (HA-free) modules importable standalone for unit tests.

The package ``__init__`` pulls in Home Assistant, so we import the pure modules
(`schedule`, `calc`, `gates`) directly from the package directory instead.
"""

from __future__ import annotations

import pathlib
import sys

_PKG = pathlib.Path(__file__).resolve().parents[1] / "custom_components" / "gardenesp"
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))
