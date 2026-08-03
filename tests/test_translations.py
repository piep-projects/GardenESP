"""Guard tests for the HA-native translation catalogs (i18n concept §12, P0).

These keep the three sides in sync that HA itself cannot check for us:

* the ``STATUS_*`` constants a line sensor may report,
* the ENUM sensor's ``options`` list (HA rejects a state that is not in it),
* ``entity.sensor.status.state.*`` in every catalog — without those entries HA
  shows the raw values (``blocked_sensor`` …) in more-info, history, logbook and
  the automation editor, in *every* language.

The modules under test import Home Assistant, which is not installed in the pure
unit-test environment, so the constants and descriptions are read from source
text instead of imported. That is deliberate: the check must run in plain CI.
"""

from __future__ import annotations

import json
import pathlib
import re
import unittest

import _path  # noqa: F401

_PKG = pathlib.Path(_path._PKG)
_CATALOGS = ("strings.json", "translations/en.json", "translations/de.json")
# strings.json is not processed for custom integrations (i18n concept §15.0) —
# it is the dev reference and must be mirrored manually, so it is checked too.


def _read(rel: str) -> str:
    return (_PKG / rel).read_text(encoding="utf-8")


def _catalog(rel: str) -> dict:
    return json.loads(_read(rel))


def _status_constants() -> set[str]:
    """``STATUS_* = "value"`` from const.py (source text, see module docstring)."""
    return set(re.findall(r'^STATUS_[A-Z_]+:\s*Final\s*=\s*"([^"]+)"', _read("const.py"), re.M))


def _line_statuses() -> list[str]:
    """The ``LINE_STATUSES`` tuple, resolved to its string values."""
    body = re.search(r"LINE_STATUSES:\s*Final\s*=\s*\((.*?)\)", _read("const.py"), re.S)
    assert body, "LINE_STATUSES tuple not found in const.py"
    names = re.findall(r"\b(STATUS_[A-Z_]+)\b", body.group(1))
    values = dict(re.findall(r'^(STATUS_[A-Z_]+):\s*Final\s*=\s*"([^"]+)"', _read("const.py"), re.M))
    return [values[n] for n in names]


def _flat_keys(obj, prefix: str = "") -> set[str]:
    keys: set[str] = set()
    for key, value in obj.items():
        path = f"{prefix}{key}"
        if isinstance(value, dict):
            keys |= _flat_keys(value, path + ".")
        else:
            keys.add(path)
    return keys


def _translation_keys(module: str) -> set[str]:
    """``translation_key="x"`` occurrences in a platform module."""
    return set(re.findall(r'translation_key="([^"]+)"', _read(module)))


class TestStatusEnum(unittest.TestCase):
    """The line status is a ``SensorDeviceClass.ENUM`` — three sides, one truth."""

    def test_line_statuses_covers_every_constant(self):
        self.assertEqual(set(_line_statuses()), _status_constants())

    def test_line_statuses_has_no_duplicates(self):
        statuses = _line_statuses()
        self.assertEqual(len(statuses), len(set(statuses)))

    def test_sensor_declares_options_from_the_constant(self):
        # A literal list here would silently drift from const.py.
        self.assertIn("options=list(LINE_STATUSES)", _read("sensor.py"))

    def test_every_catalog_translates_every_status(self):
        expected = set(_line_statuses())
        for rel in _CATALOGS:
            with self.subTest(catalog=rel):
                states = _catalog(rel)["entity"]["sensor"]["status"].get("state", {})
                self.assertEqual(
                    set(states),
                    expected,
                    f"{rel}: entity.sensor.status.state must cover exactly the "
                    "LINE_STATUSES (missing → HA shows the raw value; extra → orphan)",
                )

    def test_no_status_label_is_empty(self):
        for rel in _CATALOGS:
            for status, label in _catalog(rel)["entity"]["sensor"]["status"]["state"].items():
                with self.subTest(catalog=rel, status=status):
                    self.assertTrue(label.strip())


class TestCatalogParity(unittest.TestCase):
    """en is the base/fallback and must stay complete; de is kept equal to it."""

    def test_all_catalogs_have_the_same_keys(self):
        reference = _flat_keys(_catalog("translations/en.json"))
        for rel in _CATALOGS:
            with self.subTest(catalog=rel):
                self.assertEqual(_flat_keys(_catalog(rel)), reference)

    def test_no_key_reference_placeholders(self):
        # '[%key:...%]' is a Core build-time feature; in a custom integration the
        # user would see the raw placeholder (i18n concept §15.0).
        for rel in _CATALOGS:
            with self.subTest(catalog=rel):
                self.assertNotIn("[%key:", _read(rel))

    def test_every_translation_key_has_a_name(self):
        for module, platform in (("sensor.py", "sensor"), ("binary_sensor.py", "binary_sensor")):
            for key in _translation_keys(module):
                for rel in _CATALOGS:
                    with self.subTest(catalog=rel, platform=platform, key=key):
                        entry = _catalog(rel)["entity"].get(platform, {}).get(key)
                        self.assertIsNotNone(entry, f"{rel}: missing entity.{platform}.{key}")
                        self.assertTrue(entry.get("name"))


if __name__ == "__main__":
    unittest.main()
