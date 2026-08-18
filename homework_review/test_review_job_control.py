import asyncio
import unittest

try:
    from .review_job_control import (
        FairUserConcurrencyLimiter,
        ReviewAuthenticationError,
        SupabaseTokenVerifier,
        extract_bearer_token,
    )
except ImportError:
    from review_job_control import (
        FairUserConcurrencyLimiter,
        ReviewAuthenticationError,
        SupabaseTokenVerifier,
        extract_bearer_token,
    )


class BearerTokenTest(unittest.TestCase):
    def test_extracts_case_insensitive_bearer_token(self):
        self.assertEqual(extract_bearer_token("bEaReR sample-token"), "sample-token")

    def test_rejects_missing_or_wrong_scheme(self):
        for value in (None, "", "sample-token", "Basic sample-token", "Bearer   "):
            with self.subTest(value=value):
                with self.assertRaises(ReviewAuthenticationError):
                    extract_bearer_token(value)

    def test_verifier_caches_user_identity_without_storing_raw_token(self):
        verifier = SupabaseTokenVerifier(
            supabase_url="https://example.supabase.co",
            cache_seconds=60,
        )
        calls = []

        def fake_verify(token):
            calls.append(token)
            return "user-123", None

        verifier._verify_jwt = fake_verify
        self.assertEqual(verifier.verify("secret-access-token"), "user-123")
        self.assertEqual(verifier.verify("secret-access-token"), "user-123")
        self.assertEqual(calls, ["secret-access-token"])
        self.assertNotIn("secret-access-token", verifier._cache)


class FairUserConcurrencyLimiterTest(unittest.IsolatedAsyncioTestCase):
    async def test_enforces_global_and_per_user_caps(self):
        limiter = FairUserConcurrencyLimiter(global_limit=3, per_user_limit=2)
        release = asyncio.Event()
        entered = []

        async def worker(user_id, index):
            async with limiter.slot(user_id):
                entered.append((user_id, index))
                await release.wait()

        tasks = [
            asyncio.create_task(worker("user-a", index))
            for index in range(3)
        ] + [
            asyncio.create_task(worker("user-b", index))
            for index in range(2)
        ]

        for _ in range(100):
            if len(entered) == 3:
                break
            await asyncio.sleep(0.01)
        snapshot = await limiter.snapshot()
        self.assertEqual(snapshot["activeTotal"], 3)
        self.assertLessEqual(snapshot["activeByUser"].get("user-a", 0), 2)
        self.assertLessEqual(snapshot["activeByUser"].get("user-b", 0), 2)
        self.assertEqual(set(snapshot["activeByUser"]), {"user-a", "user-b"})

        release.set()
        await asyncio.gather(*tasks)
        self.assertEqual((await limiter.snapshot())["activeTotal"], 0)

    async def test_new_user_gets_next_slot_before_existing_user_backlog(self):
        limiter = FairUserConcurrencyLimiter(global_limit=1, per_user_limit=1)
        await limiter.acquire("user-a")
        order = []

        async def take_one(user_id):
            async with limiter.slot(user_id):
                order.append(user_id)
                await asyncio.sleep(0)

        user_a_backlog = asyncio.create_task(take_one("user-a"))
        await asyncio.sleep(0)
        new_user = asyncio.create_task(take_one("user-b"))
        await asyncio.sleep(0)

        await limiter.release("user-a")
        await asyncio.gather(user_a_backlog, new_user)
        self.assertEqual(order, ["user-b", "user-a"])

    async def test_cancelled_waiter_does_not_leak_capacity(self):
        limiter = FairUserConcurrencyLimiter(global_limit=1, per_user_limit=1)
        await limiter.acquire("user-a")
        waiter = asyncio.create_task(limiter.acquire("user-b"))
        await asyncio.sleep(0)
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        await limiter.release("user-a")

        snapshot = await limiter.snapshot()
        self.assertEqual(snapshot["activeTotal"], 0)
        self.assertEqual(snapshot["queuedByUser"], {})


if __name__ == "__main__":
    unittest.main()
