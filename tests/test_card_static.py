"""Guard: the Lovelace card is served from the integration dir, not copied to www/.

HACS review (default catalog): the integration must not write into the user's
``config/www/``. The card gets its own static path like the panel, and the
resource cleanup removes the ``/local/`` resource older releases registered.
``__init__`` imports Home Assistant (the unit tests run HA-free), so structure
is checked via ``ast`` and the resource logic is exec'd with stubbed globals.
"""

import ast
import asyncio
import logging
import unittest
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent / "custom_components" / "gardenesp"
INIT = (PKG / "__init__.py").read_text(encoding="utf-8")


def _const(name: str) -> str:
    """Evaluate a ``Final`` string constant from const.py (DOMAIN-based f-strings)."""
    tree = ast.parse((PKG / "const.py").read_text(encoding="utf-8"))
    env: dict = {}
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            try:
                env[node.target.id] = eval(  # noqa: S307 - our own constants
                    compile(ast.Expression(node.value), "const", "eval"), {}, env
                )
            except Exception:  # noqa: BLE001 - non-string constants (Platform…)
                pass
    return env[name]


class _FakeResources:
    loaded = True

    def __init__(self, urls):
        self._items = [{"id": str(i), "url": u, "type": "module"} for i, u in enumerate(urls)]

    def async_items(self):
        return list(self._items)

    async def async_delete_item(self, item_id):
        self._items = [it for it in self._items if it["id"] != item_id]

    async def async_create_item(self, data):
        self._items.append({"id": f"n{len(self._items)}", "url": data["url"], "type": data["res_type"]})

    def urls(self):
        return sorted(it["url"] for it in self._items)


def _register_fn(name="_async_register_lovelace_resource"):
    tree = ast.parse(INIT)
    fn = next(
        n for n in tree.body
        if isinstance(n, ast.AsyncFunctionDef) and n.name == name
    )
    mod = ast.Module(body=[fn], type_ignores=[])
    env = {
        "HomeAssistant": object,
        "CARD_STATIC_URL": _const("CARD_STATIC_URL"),
        "CARD_LEGACY_URL": _const("CARD_LEGACY_URL"),
        "_LOGGER": logging.getLogger("test"),
    }
    exec(compile(mod, "__init__", "exec"), env)  # noqa: S102
    return env[name]


class _Hass:
    def __init__(self, resources):
        self.data = {"lovelace": type("LL", (), {"resources": resources})()}


class CardStaticPathTest(unittest.TestCase):
    def test_no_copy_into_www(self):
        self.assertNotIn("shutil", INIT)
        self.assertNotIn('config.path("www")', INIT)
        self.assertNotIn("_deploy_file", INIT)

    def test_card_url_is_own_static_path(self):
        self.assertEqual(_const("CARD_STATIC_URL"), "/gardenesp_card/gardenesp-card.js")
        self.assertIn("StaticPathConfig(CARD_STATIC_URL", INIT)

    def test_resource_cleanup(self):
        url = "/gardenesp_card/gardenesp-card.js?v=0.14.0"
        res = _FakeResources([
            "/local/gardenesp-card.js?v=0.13.91",       # ours, from the www/ era
            "/gardenesp_card/gardenesp-card.js?v=0.13.99",  # stale version
            "/local/other-card.js",                     # foreign — must stay
            "/hacsfiles/foo/foo.js",
        ])
        asyncio.run(_register_fn()(_Hass(res), url))
        self.assertEqual(
            res.urls(),
            sorted([url, "/local/other-card.js", "/hacsfiles/foo/foo.js"]),
        )

    def test_resource_idempotent(self):
        url = "/gardenesp_card/gardenesp-card.js?v=0.14.0"
        res = _FakeResources([url])
        asyncio.run(_register_fn()(_Hass(res), url))
        self.assertEqual(res.urls(), [url])

    def test_resource_removed_with_integration(self):
        res = _FakeResources([
            "/gardenesp_card/gardenesp-card.js?v=0.14.1",
            "/local/gardenesp-card.js?v=0.13.91",
            "/local/other-card.js",                     # foreign — must stay
        ])
        asyncio.run(_register_fn("_async_remove_lovelace_resource")(_Hass(res)))
        self.assertEqual(res.urls(), ["/local/other-card.js"])

    def test_remove_entry_calls_resource_removal(self):
        tree = ast.parse(INIT)
        fn = next(
            n for n in tree.body
            if isinstance(n, ast.AsyncFunctionDef) and n.name == "async_remove_entry"
        )
        self.assertIn("_async_remove_lovelace_resource", ast.unparse(fn))


if __name__ == "__main__":
    unittest.main()
