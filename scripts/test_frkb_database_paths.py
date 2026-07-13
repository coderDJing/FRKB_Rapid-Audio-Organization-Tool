import os
import unittest
from unittest.mock import patch

import frkb_database_paths as paths


class FrkbDatabasePathsTests(unittest.TestCase):
    def test_process_benchmark_root_has_highest_priority(self) -> None:
        with patch.dict(
            os.environ,
            {
                "FRKB_BENCHMARK_DATABASE_ROOT": "G:/benchmark-root",
                "FRKB_DEV_DATABASE_URL": "G:/dev-root",
            },
            clear=False,
        ):
            self.assertEqual(paths.resolve_frkb_database_root().as_posix(), "G:/benchmark-root")

    def test_process_dev_root_precedes_repository_dotenv(self) -> None:
        with patch.dict(
            os.environ,
            {"FRKB_BENCHMARK_DATABASE_ROOT": "", "FRKB_DEV_DATABASE_URL": "G:/dev-root"},
            clear=False,
        ), patch.object(paths, "_read_dotenv_value", return_value="D:/dotenv-root"):
            self.assertEqual(paths.resolve_frkb_database_root().as_posix(), "G:/dev-root")

    def test_missing_configuration_fails_instead_of_guessing_a_drive(self) -> None:
        with patch.dict(
            os.environ,
            {"FRKB_BENCHMARK_DATABASE_ROOT": "", "FRKB_DEV_DATABASE_URL": ""},
            clear=False,
        ), patch.object(paths, "_read_dotenv_value", return_value=""):
            with self.assertRaisesRegex(RuntimeError, "database root is not configured"):
                paths.resolve_frkb_database_root()


if __name__ == "__main__":
    unittest.main()
