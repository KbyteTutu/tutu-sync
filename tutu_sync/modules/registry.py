from __future__ import annotations

import importlib.metadata
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tutu_sync.modules.base import SyncModule

ENTRY_POINT_GROUP = "tutu_sync.modules"


def discover_modules() -> dict[str, type[SyncModule]]:
    modules: dict[str, type[SyncModule]] = {}
    try:
        entry_points = importlib.metadata.entry_points(group=ENTRY_POINT_GROUP)
    except TypeError:
        eps = importlib.metadata.entry_points()
        entry_points = eps.select(group=ENTRY_POINT_GROUP)

    for ep in entry_points:
        try:
            cls = ep.load()
        except Exception:
            continue
        modules[ep.name] = cls

    return modules


def get_module(name: str) -> SyncModule:
    modules = discover_modules()
    if name not in modules:
        raise ValueError(
            f"unknown module: {name!r}. Available: {list(modules.keys())}"
        )
    return modules[name]()


def list_modules() -> list[str]:
    return sorted(discover_modules().keys())
