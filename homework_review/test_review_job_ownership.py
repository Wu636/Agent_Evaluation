import asyncio
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

try:
    from .main import (
        REVIEW_JOBS,
        cancel_active_review_job,
        get_active_review_jobs,
        get_review_job,
        resolve_review_job_artifact,
    )
except ImportError:
    from main import (
        REVIEW_JOBS,
        cancel_active_review_job,
        get_active_review_jobs,
        get_review_job,
        resolve_review_job_artifact,
    )


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


class ActiveReviewJobRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.job_ids = ["active-running-job", "active-queued-job", "other-user-job"]
        self.running_task = asyncio.create_task(asyncio.Event().wait())
        common = {
            "files": ["student.docx"],
            "logs": [],
            "error": None,
            "cancelRequested": False,
            "createdAt": "2026-08-19T01:00:00+00:00",
            "updatedAt": "2026-08-19T01:00:00+00:00",
        }
        REVIEW_JOBS[self.job_ids[0]] = {
            **common,
            "jobId": self.job_ids[0],
            "ownerId": "user-a",
            "status": "running",
            "engine": "skill",
            "_task": self.running_task,
        }
        REVIEW_JOBS[self.job_ids[1]] = {
            **common,
            "jobId": self.job_ids[1],
            "ownerId": "user-a",
            "status": "queued",
        }
        REVIEW_JOBS[self.job_ids[2]] = {
            **common,
            "jobId": self.job_ids[2],
            "ownerId": "user-b",
            "status": "running",
        }

    async def asyncTearDown(self):
        if not self.running_task.done():
            self.running_task.cancel()
        await asyncio.gather(self.running_task, return_exceptions=True)
        for job_id in self.job_ids:
            REVIEW_JOBS.pop(job_id, None)

    async def test_lists_only_current_users_active_jobs(self):
        response = await get_active_review_jobs(review_user_id="user-a")
        self.assertEqual(
            [item["jobId"] for item in response["jobs"]],
            ["active-running-job", "active-queued-job"],
        )
        self.assertEqual(response["runningCount"], 1)
        self.assertEqual(response["queuedCount"], 1)

    async def test_cancel_active_stops_running_job_but_preserves_queue(self):
        response = await cancel_active_review_job(review_user_id="user-a")
        self.assertEqual(response["jobId"], "active-running-job")
        self.assertEqual(REVIEW_JOBS["active-running-job"]["status"], "cancelled")
        self.assertTrue(self.running_task.cancelled())
        self.assertEqual(REVIEW_JOBS["active-queued-job"]["status"], "queued")


if __name__ == "__main__":
    unittest.main()
