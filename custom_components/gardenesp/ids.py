"""Stable object-id generation (FDS §9.1) — pure, no HA imports.

IDs are opaque and never change once assigned; the type prefix only aids
debugging. ``unique_id`` of entities derives from these (FDS §9.2).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable

PREFIXES: dict[str, str] = {
    "box": "box_",
    "line": "ln_",
    "source": "src_",
}


def new_id(kind: str) -> str:
    """Return a new opaque id for ``kind`` (``box``/``line``/``source``).

    Sperr-Sensoren sind keine eigenen Objekte mehr, sondern Box-Eingänge (FDS §4.5)."""
    return PREFIXES[kind] + uuid.uuid4().hex[:8]


def next_line_seq(existing_seqs: Iterable[int]) -> int:
    """Next free box-scoped line number ``L<n>`` (FDS §3).

    Monotonic: ``max`` assigned + 1, never reusing freed numbers, so existing
    lines keep their id even when others are deleted (stable display id)."""
    nums = [int(s) for s in existing_seqs if s]
    return max(nums) + 1 if nums else 1
