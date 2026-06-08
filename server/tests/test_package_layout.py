"""Smoke test: every scaffolded subpackage is importable.

This is the only test the scaffold ships with; it exists so the
coverage gate has something to bite on while the real modules are
still empty. As real code lands per phase, this file can shrink.
"""

import importlib

import pytest

_SUBMODULES = [
    "dashboard",
    "dashboard.web",
    "dashboard.api",
    "dashboard.policy",
    "dashboard.events",
    "dashboard.integrations",
    "dashboard.transport",
    "dashboard.transport.ssh",
    "dashboard.transport.ansible",
    "dashboard.transport.activitywatch",
    "dashboard.transport.adguard",
]


@pytest.mark.parametrize("module_name", _SUBMODULES)
def test_submodule_importable(module_name: str) -> None:
    importlib.import_module(module_name)
