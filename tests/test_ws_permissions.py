"""Guard: every WebSocket command carries the authorisation it is meant to (FR-P2).

The handlers live in ``websocket_api.py``, which imports Home Assistant, so this
test reads the module as **source** (``ast``) instead of importing it — the same
trick ``test_translations.py`` uses to stay runnable in the HA-free unittest CI.

What it pins down:

* the classification below covers *every* registered command, so adding one
  fails here until its authorisation has been decided on purpose;
* config-writing commands guard with ``_require_admin``, manual start/stop with
  the entity-permission check ``_require_control``, and the card's read commands
  with neither;
* the guard is an early ``if not …: return``, not merely a mention of the helper;
* the settings panel itself is registered ``require_admin=True``.
"""

from __future__ import annotations

import ast
import pathlib
import unittest

PKG = pathlib.Path(__file__).resolve().parents[1] / "custom_components" / "gardenesp"

# Writes configuration (or exposes the generated device config) → admin.
ADMIN = {
    "ws_settings_set",
    "ws_upsert",
    "ws_delete",
    "ws_box_yaml",
    "ws_box_exported",
    "ws_box_sync",
}
# Operates the line's valve → checked against the caller's entity permissions,
# deliberately not admin (a household user may flip that switch anyway).
CONTROL = {"ws_line_start", "ws_line_stop"}
# Read-only, needed by the dashboard card for every authenticated user.
OPEN = {"ws_config_get", "ws_topology", "ws_wiring", "ws_history"}
# Writes display state only (hides the reboot banner for everyone), no config, no
# output → deliberately open to every authenticated user (decision 2026-11-07).
ACK = {"ws_box_reboot_ack"}


def _module(name: str) -> ast.Module:
    return ast.parse((PKG / name).read_text(encoding="utf-8"))


def _functions(mod: ast.Module) -> dict[str, ast.AST]:
    return {
        n.name: n
        for n in mod.body
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _guards(fn: ast.AST) -> set[str]:
    """Names called in an ``if not <call>(...): return`` at the top of ``fn``."""
    found: set[str] = set()
    for node in ast.walk(fn):
        if not isinstance(node, ast.If):
            continue
        test = node.test
        if not (isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not)):
            continue
        call = test.operand
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name)):
            continue
        if any(isinstance(b, ast.Return) and b.value is None for b in node.body):
            found.add(call.func.id)
    return found


class TestWebsocketAuthorisation(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = _module("websocket_api.py")
        self.fns = _functions(self.mod)

    def _registered(self) -> set[str]:
        register = _functions(self.mod)["async_register"]
        names: set[str] = set()
        for node in ast.walk(register):
            if isinstance(node, ast.Tuple):
                names |= {e.id for e in node.elts if isinstance(e, ast.Name)}
        return names

    def test_classification_covers_every_registered_command(self):
        self.assertEqual(self._registered(), ADMIN | CONTROL | OPEN | ACK)

    def test_admin_commands_guard_with_require_admin(self):
        for name in sorted(ADMIN):
            with self.subTest(command=name):
                self.assertIn("_require_admin", _guards(self.fns[name]))

    def test_line_commands_guard_with_entity_permission(self):
        for name in sorted(CONTROL):
            with self.subTest(command=name):
                self.assertIn("_require_control", _guards(self.fns[name]))

    def test_read_commands_stay_open(self):
        for name in sorted(OPEN | ACK):
            with self.subTest(command=name):
                guards = _guards(self.fns[name])
                self.assertNotIn("_require_admin", guards)
                self.assertNotIn("_require_control", guards)

    def test_helpers_deny_by_default(self):
        """Both guards must end in a refusal, not fall through to ``True``."""
        for helper in ("_require_admin", "_require_control"):
            with self.subTest(helper=helper):
                fn = self.fns[helper]
                last = fn.body[-1]
                self.assertIsInstance(last, ast.Return)
                self.assertIs(last.value.value, False)
                sends = [
                    n
                    for n in ast.walk(fn)
                    if isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Attribute)
                    and n.func.attr == "send_error"
                ]
                self.assertTrue(sends)


class TestServiceAuthorisation(unittest.TestCase):
    """The HA services take a ``line_id``, so HA's own service permission check
    (entity-target services only) never fires — the integration has to do it."""

    def setUp(self) -> None:
        self.mod = _module("services.py")
        self.fns = _functions(self.mod)

    def _handlers(self) -> dict[str, ast.AST]:
        """The inner ``_start_line`` / ``_stop_line`` closures."""
        register = self.fns["async_register_services"]
        return {
            n.name: n
            for n in ast.walk(register)
            if isinstance(n, ast.AsyncFunctionDef) and n.name.endswith("_line")
        }

    def test_both_services_check_control(self):
        handlers = self._handlers()
        self.assertEqual(set(handlers), {"_start_line", "_stop_line"})
        for name, fn in sorted(handlers.items()):
            with self.subTest(service=name):
                called = {
                    n.func.id
                    for n in ast.walk(fn)
                    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                }
                self.assertIn("_async_require_control", called)

    def test_check_runs_before_the_line_is_driven(self):
        """Order matters: refusing after the run started would be theatre."""
        for name, drives in (("_start_line", "async_start_line"), ("_stop_line", "async_stop_line")):
            with self.subTest(service=name):
                src = ast.dump(self._handlers()[name])
                self.assertLess(src.index("_async_require_control"), src.index(drives))

    def test_automations_pass_but_unknown_users_do_not(self):
        """`user_id is None` (automation/script) returns early; everything else
        must end in the refusal, not fall through."""
        fn = self.fns["_async_require_control"]
        early = [
            n
            for n in ast.walk(fn)
            if isinstance(n, ast.If)
            and isinstance(n.test, ast.Compare)
            and isinstance(n.test.ops[0], ast.Is)
            and any(isinstance(b, ast.Return) and b.value is None for b in n.body)
        ]
        self.assertTrue(early, "no early return for a call without a user context")
        last = fn.body[-1]
        self.assertIsInstance(last, ast.Raise)
        self.assertEqual(last.exc.func.id, "Unauthorized")


class TestPanelRegistration(unittest.TestCase):
    def test_panel_requires_admin(self):
        """The panel is settings-only; its commands are admin-gated (FR-P2)."""
        mod = _module("__init__.py")
        values = [
            kw.value
            for node in ast.walk(mod)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "async_register_built_in_panel"
            for kw in node.keywords
            if kw.arg == "require_admin"
        ]
        self.assertEqual([v.value for v in values], [True])


if __name__ == "__main__":
    unittest.main()
