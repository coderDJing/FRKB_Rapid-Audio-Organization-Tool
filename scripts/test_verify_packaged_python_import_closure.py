import tempfile
import unittest
from pathlib import Path

from verify_packaged_python_import_closure import verify_import_closure


class PackagedPythonImportClosureTests(unittest.TestCase):
    def test_reports_missing_transitive_top_level_module(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "source"
            packaged = root / "packaged"
            source.mkdir()
            packaged.mkdir()
            (source / "entry.py").write_text("import helper\n", encoding="utf-8")
            (source / "helper.py").write_text("import selector\n", encoding="utf-8")
            (source / "selector.py").write_text("VALUE = 1\n", encoding="utf-8")
            (packaged / "entry.py").write_text("import helper\n", encoding="utf-8")
            (packaged / "helper.py").write_text("import selector\n", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "selector"):
                verify_import_closure(
                    source_root=source,
                    packaged_root=packaged,
                    entries=["entry.py"],
                )

    def test_accepts_complete_transitive_top_level_closure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "source"
            packaged = root / "packaged"
            source.mkdir()
            packaged.mkdir()
            files = {
                "entry.py": "import helper\n",
                "helper.py": "from selector import VALUE\n",
                "selector.py": "VALUE = 1\n",
            }
            for name, content in files.items():
                (source / name).write_text(content, encoding="utf-8")
                (packaged / name).write_text(content, encoding="utf-8")

            result = verify_import_closure(
                source_root=source,
                packaged_root=packaged,
                entries=["entry.py"],
            )

            self.assertEqual([], result["missingLocalModules"])
            self.assertEqual(["entry", "helper", "selector"], result["visitedLocalModules"])


if __name__ == "__main__":
    unittest.main()
