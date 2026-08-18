import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

try:
    from .main import REVIEW_JOBS, get_review_job, resolve_review_job_artifact
except ImportError:
    from main import REVIEW_JOBS, get_review_job, resolve_review_job_artifact


class ReviewJobOwnershipTest(unittest.TestCase):
    def setUp(self):
        self.job_id = "ownership-test-job"
        self.temp_dir = tempfile.TemporaryDirectory()
        self.output_root = Path(self.temp_dir.name) / "output"
        self.output_root.mkdir()
        REVIEW_JOBS[self.job_id] = {
            "ownerId": "user-a",
            "outputRoot": str(self.output_root),
            "status": "completed",
        }

    def tearDown(self):
        REVIEW_JOBS.pop(self.job_id, None)
        self.temp_dir.cleanup()

    def test_owner_can_read_job_but_other_user_sees_not_found(self):
        self.assertEqual(get_review_job(self.job_id, "user-a")["ownerId"], "user-a")
        with self.assertRaises(HTTPException) as context:
            get_review_job(self.job_id, "user-b")
        self.assertEqual(context.exception.status_code, 404)

    def test_artifact_path_is_restricted_to_job_output_directory(self):
        artifact = self.output_root / "result.json"
        artifact.write_text("{}", encoding="utf-8")
        job = REVIEW_JOBS[self.job_id]
        self.assertEqual(resolve_review_job_artifact(job, "result.json"), artifact.resolve())

        outside = Path(self.temp_dir.name) / "outside.json"
        outside.write_text("{}", encoding="utf-8")
        with self.assertRaises(HTTPException) as context:
            resolve_review_job_artifact(job, "../outside.json")
        self.assertEqual(context.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
