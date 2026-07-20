from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from rkb_sealed_batch_common import collect_dependency_files


class SolverDependencyArtifactTests(unittest.TestCase):
    def test_dependency_collector_accepts_non_python_model_leaf(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            scripts_root = Path(temp_dir) / "scripts"
            scripts_root.mkdir()
            entry = scripts_root / "entry.py"
            helper = scripts_root / "helper.py"
            model = scripts_root / "models" / "candidate.json"
            model.parent.mkdir()
            entry.write_text("import helper\n", encoding="utf-8")
            helper.write_text("VALUE = 1\n", encoding="utf-8")
            model.write_text('{"version": 1}\n', encoding="utf-8")

            dependencies = collect_dependency_files([entry, model], scripts_root)

            self.assertEqual({entry.resolve(), helper.resolve(), model.resolve()}, set(dependencies))


if __name__ == "__main__":
    unittest.main()
