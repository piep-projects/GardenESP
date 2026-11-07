"""``models.InvalidObject``: malformed WS/storage data names the bad field instead
of surfacing as a bare ``TypeError`` (→ ``unknown_error`` at the WS caller)."""

from __future__ import annotations

import unittest

import _path  # noqa: F401
import models

LINE = {"id": "ln_1", "name": "Rasen", "box_id": "box_1", "valve_output": "box_1#o1"}
BOX = {"id": "box_1", "name": "Garten", "hw_type": "esp32_wroom"}


class ModelsValidationTest(unittest.TestCase):
    def _msg(self, fn, data) -> str:
        with self.assertRaises(models.InvalidObject) as cm:
            fn(data)
        return str(cm.exception)

    def test_valid_objects_still_build(self):
        self.assertEqual(models.Line.from_dict(LINE).valve_output, "box_1#o1")
        self.assertEqual(models.Box.from_dict(BOX).hw_type, "esp32_wroom")

    def test_unknown_keys_still_ignored(self):
        self.assertEqual(models.Line.from_dict({**LINE, "future": 1}).name, "Rasen")

    def test_line_without_valve_output(self):
        data = {k: v for k, v in LINE.items() if k != "valve_output"}
        self.assertEqual(
            self._msg(models.Line.from_dict, data),
            "line: missing required field(s): valve_output",
        )

    def test_several_missing_listed(self):
        msg = self._msg(models.Line.from_dict, {"id": "ln_1"})
        self.assertEqual(msg, "line: missing required field(s): name, box_id, valve_output")

    def test_nested_output_path(self):
        data = {**BOX, "outputs": [{"id": "o1", "type": "valve", "name": "V1"}, {"id": "o2"}]}
        self.assertEqual(
            self._msg(models.Box.from_dict, data),
            "box.outputs[1]: missing required field(s): type, name",
        )

    def test_nested_schedule_path(self):
        data = {**LINE, "schedule": [{"time": "05:00"}]}
        self.assertEqual(
            self._msg(models.Line.from_dict, data),
            "line.schedule[0]: missing required field(s): repeat",
        )

    def test_wrong_shapes(self):
        self.assertEqual(
            self._msg(models.Box.from_dict, {**BOX, "inputs": "rain"}),
            "box.inputs: expected a list, got str",
        )
        self.assertEqual(
            self._msg(models.Box.from_dict, {**BOX, "inputs": ["rain"]}),
            "box.inputs[0]: expected an object, got str",
        )
        self.assertEqual(
            self._msg(models.Source.from_dict, None), "source: expected an object, got NoneType"
        )

    def test_is_a_value_error(self):
        self.assertTrue(issubclass(models.InvalidObject, ValueError))


if __name__ == "__main__":
    unittest.main()
