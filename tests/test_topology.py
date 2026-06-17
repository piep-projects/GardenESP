"""Unit tests for the pure topology lens (Roadmap #7)."""

from __future__ import annotations

import unittest

import _path  # noqa: F401
import topology


def _config():
    """A small two-box config: a cistern (pump + connected pre-valve) and mains."""
    return {
        "boxes": {
            "box_a": {
                "id": "box_a",
                "label": "A",
                "outputs": [
                    {"id": "o7", "type": "pump", "name": "Eheim Pumpe", "channel": "7",
                     "gpio": "GPIO19", "emergency_shutdown_min": 60, "connected": []},
                    {"id": "o3", "type": "valve", "name": "Vierfach Ventil 1/4",
                     "channel": "3", "gpio": "GPIO16", "emergency_shutdown_min": 15},
                    {"id": "o2", "type": "valve", "name": "Hunter Ventil 1",
                     "channel": "2", "gpio": "GPIO14", "emergency_shutdown_min": 10},
                ],
                "inputs": [
                    {"id": "i5", "kind": "pressure", "name": "Drucksensor 2", "pin": "GPIO36"},
                    {"id": "i2", "kind": "pulse_meter", "name": "Wasserzähler", "pin": "GPIO33"},
                    {"id": "i1", "kind": "rain", "name": "RainClik", "pin": "GPIO32"},
                ],
            },
            "box_b": {
                "id": "box_b",
                "label": "B",
                "outputs": [
                    {"id": "p", "type": "pump", "name": "Eheim Pumpe", "channel": "R1",
                     "gpio": "", "emergency_shutdown_min": 45, "connected": ["v"]},
                    {"id": "v", "type": "valve", "name": "Ventil vor Pumpe", "channel": "3"},
                ],
                "inputs": [{"id": "i3", "kind": "pressure", "name": "Zittern 1800", "pin": "A1"}],
            },
        },
        "sources": {
            "src_z": {"id": "src_z", "name": "Zisterne1", "type": "cistern",
                      "level_input": "box_a#i5", "pump_output": "box_a#o7",
                      "min_fill_pct": 10, "max_volume_l": 500},
            "src_m": {"id": "src_m", "name": "Festwasser", "type": "mains",
                      "meter_input": "box_a#i2"},
            "src_pre": {"id": "src_pre", "name": "Zisterne B", "type": "cistern",
                        "level_input": "box_b#i3", "pump_output": "box_b#p", "min_fill_pct": 10},
        },
        "lines": {
            "ln2": {"id": "ln2", "name": "hortensien", "box_id": "box_a", "kind": "irrigation",
                    "valve_output": "box_a#o3", "source_id": "src_z", "seq": 2,
                    "automatic": True, "sensor_input": "box_a#i1"},
            "ln1": {"id": "ln1", "name": "Tomaten", "box_id": "box_a", "kind": "irrigation",
                    "valve_output": "box_a#o3", "source_id": "src_z", "seq": 1, "automatic": True},
            "lm": {"id": "lm", "name": "Zisterne füllen", "box_id": "box_a", "kind": "irrigation",
                   "valve_output": "box_a#o2", "source_id": "src_m", "seq": 5, "automatic": False},
            "sw": {"id": "sw", "name": "Frosch", "box_id": "box_a", "kind": "switch",
                   "valve_output": "box_a#o2", "source_id": None, "seq": 0},
        },
    }


class TestTopology(unittest.TestCase):
    def setUp(self):
        self.strands = topology.build(_config())
        self.by_src = {s["source"]["id"]: s for s in self.strands}

    def test_one_strand_per_source(self):
        self.assertEqual({s["source"]["id"] for s in self.strands}, {"src_z", "src_m", "src_pre"})

    def test_source_box_and_sensor(self):
        z = self.by_src["src_z"]["source"]
        self.assertEqual(z["box_label"], "A")
        self.assertEqual(z["sensor"]["name"], "Drucksensor 2")
        self.assertEqual(z["sensor"]["pin"], "GPIO36")

    def test_pump_short_id_and_meta(self):
        pump = self.by_src["src_z"]["pump"]
        self.assertEqual(pump["short_id"], "A7")  # box label + channel
        self.assertEqual(pump["gpio"], "GPIO19")
        self.assertEqual(pump["emergency_min"], 60)
        self.assertEqual(pump["connected"], [])

    def test_connected_prevalve_on_pump(self):
        pump = self.by_src["src_pre"]["pump"]
        self.assertEqual(pump["short_id"], "BR1")
        self.assertEqual(len(pump["connected"]), 1)
        self.assertEqual(pump["connected"][0]["short_id"], "B3")
        self.assertEqual(pump["connected"][0]["name"], "Ventil vor Pumpe")

    def test_mains_has_no_pump(self):
        m = self.by_src["src_m"]
        self.assertIsNone(m["pump"])
        self.assertEqual(m["source"]["sensor"]["name"], "Wasserzähler")

    def test_valves_sorted_by_seq_with_line_ids(self):
        valves = self.by_src["src_z"]["valves"]
        self.assertEqual([v["line"]["line_id"] for v in valves], ["L1", "L2"])
        self.assertEqual([v["line"]["name"] for v in valves], ["Tomaten", "hortensien"])
        self.assertEqual(valves[0]["output"]["short_id"], "A3")

    def test_line_sensor_and_automatic(self):
        hort = next(v for v in self.by_src["src_z"]["valves"] if v["line"]["name"] == "hortensien")
        self.assertEqual(hort["line"]["sensor_name"], "RainClik")
        self.assertTrue(hort["line"]["automatic"])
        füllen = self.by_src["src_m"]["valves"][0]
        self.assertEqual(füllen["line"]["line_id"], "L5")
        self.assertFalse(füllen["line"]["automatic"])

    def test_switch_lines_excluded(self):
        names = [v["line"]["name"] for st in self.strands for v in st["valves"]]
        self.assertNotIn("Frosch", names)

    def test_empty_config_is_empty(self):
        self.assertEqual(topology.build({}), [])
        self.assertEqual(topology.build(None), [])


if __name__ == "__main__":
    unittest.main()
