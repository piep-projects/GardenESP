"""Guard: the deprecated ``DeviceInfo.via_device`` is only a fallback.

HA 2026.8 introduced ``via_device_id`` and deprecated ``via_device`` (breaks in
2027.8). ``entity.child_device_info`` must use the new field whenever HA offers
it and keep the old one only for older HA. Read via ``ast`` because the module
imports Home Assistant (the unit tests run HA-free).
"""

import ast
import unittest
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent / "custom_components" / "gardenesp"


def _tree(name: str) -> ast.Module:
    return ast.parse((PKG / name).read_text(encoding="utf-8"))


def _func(tree: ast.Module, name: str) -> ast.FunctionDef:
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} not found")


def _subscript_keys(node: ast.AST) -> list[str]:
    """String keys of every ``x["key"] = …`` assignment below ``node``."""
    keys = []
    for sub in ast.walk(node):
        if isinstance(sub, ast.Assign):
            for tgt in sub.targets:
                if isinstance(tgt, ast.Subscript) and isinstance(
                    tgt.slice, ast.Constant
                ):
                    keys.append(tgt.slice.value)
    return keys


class ViaDeviceGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tree = _tree("entity.py")
        self.func = _func(self.tree, "child_device_info")

    def test_switch_is_feature_detection(self) -> None:
        src = ast.unparse(self.tree)
        self.assertIn(
            "_HAS_VIA_DEVICE_ID = hasattr(dr, 'async_get_device_id_by_identifier')",
            src,
        )

    def test_old_field_only_in_fallback_branch(self) -> None:
        fallback = [
            n
            for n in ast.walk(self.func)
            if isinstance(n, ast.If)
            and ast.unparse(n.test) == "not _HAS_VIA_DEVICE_ID"
        ]
        self.assertEqual(len(fallback), 1, "exactly one fallback branch expected")
        self.assertEqual(_subscript_keys(fallback[0]), ["via_device"])
        # Outside the fallback the old key must not appear at all
        all_keys = _subscript_keys(self.func)
        self.assertEqual(all_keys.count("via_device"), 1)
        self.assertEqual(all_keys.count("via_device_id"), 1)

    def test_unknown_box_is_tolerated(self) -> None:
        handlers = [
            h
            for n in ast.walk(self.func)
            if isinstance(n, ast.Try)
            for h in n.handlers
        ]
        self.assertTrue(
            any(h.type is not None and ast.unparse(h.type) == "ValueError"
                for h in handlers),
            "lookup of a missing Box device must not raise out of the builder",
        )

    def test_callers_pass_coordinator(self) -> None:
        calls = 0
        for mod in ("sensor.py", "binary_sensor.py"):
            for node in ast.walk(_tree(mod)):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name)
                    and node.func.id == "child_device_info"
                ):
                    calls += 1
                    self.assertEqual(ast.unparse(node.args[0]), "coordinator", mod)
        self.assertEqual(calls, 4)


class DeviceLookupGuardTest(unittest.TestCase):
    """``async_get_device`` (deprecated 2026.8, breaks 2027.8) only as fallback."""

    def test_old_lookup_only_in_else_branch(self) -> None:
        tree = _tree("coordinator.py")
        calls = [
            n
            for n in ast.walk(tree)
            if isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute)
            and n.func.attr in ("async_get_device", "async_get_device_by_identifier")
        ]
        self.assertEqual(
            sorted(c.func.attr for c in calls),
            ["async_get_device", "async_get_device_by_identifier"],
        )
        switches = [
            n
            for n in ast.walk(tree)
            if isinstance(n, ast.If)
            and ast.unparse(n.test)
            == "hasattr(dev_reg, 'async_get_device_by_identifier')"
        ]
        self.assertEqual(len(switches), 1)
        sw = switches[0]
        new = [c.func.attr for b in sw.body for c in ast.walk(b) if c in calls]
        old = [c.func.attr for b in sw.orelse for c in ast.walk(b) if c in calls]
        self.assertEqual(new, ["async_get_device_by_identifier"])
        self.assertEqual(old, ["async_get_device"])


if __name__ == "__main__":
    unittest.main()
