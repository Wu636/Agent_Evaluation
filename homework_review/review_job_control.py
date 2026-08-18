"""Authentication and fair concurrency primitives for asynchronous review jobs."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from threading import Lock
from typing import Any, AsyncIterator, Deque, Dict, Optional, Tuple

try:
    import jwt
    from jwt import PyJWKClient
except ImportError:  # pragma: no cover - exercised only before dependencies install
    jwt = None
    PyJWKClient = None


class ReviewAuthenticationError(Exception):
    """The supplied application access token is missing, invalid, or expired."""


class ReviewAuthConfigurationError(Exception):
    """The review service does not have enough Supabase configuration."""


def extract_bearer_token(value: Optional[str]) -> str:
    """Extract an RFC 6750 bearer token from an Authorization header value."""
    if not value:
        raise ReviewAuthenticationError("请先登录后再提交批阅任务")
    scheme, separator, token = value.strip().partition(" ")
    if not separator or scheme.lower() != "bearer" or not token.strip():
        raise ReviewAuthenticationError("登录凭证格式不正确，请重新登录")
    return token.strip()


@dataclass(frozen=True)
class _CachedIdentity:
    user_id: str
    valid_until: float


class SupabaseTokenVerifier:
    """Verify Supabase access tokens locally, with the Auth user API as fallback."""

    def __init__(
        self,
        *,
        supabase_url: str,
        anon_key: str = "",
        jwt_secret: str = "",
        audience: str = "authenticated",
        cache_seconds: int = 60,
    ) -> None:
        self.supabase_url = supabase_url.rstrip("/")
        self.anon_key = anon_key.strip()
        self.jwt_secret = jwt_secret.strip()
        self.audience = audience.strip() or "authenticated"
        self.cache_seconds = max(5, int(cache_seconds))
        self.issuer = f"{self.supabase_url}/auth/v1" if self.supabase_url else ""
        self._cache: Dict[str, _CachedIdentity] = {}
        self._cache_lock = Lock()
        self._jwk_client = (
            PyJWKClient(f"{self.supabase_url}/auth/v1/.well-known/jwks.json", cache_keys=True)
            if self.supabase_url and PyJWKClient is not None
            else None
        )

    @classmethod
    def from_env(cls) -> "SupabaseTokenVerifier":
        return cls(
            supabase_url=os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL", ""),
            anon_key=os.getenv("SUPABASE_ANON_KEY") or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ""),
            jwt_secret=os.getenv("SUPABASE_JWT_SECRET", ""),
            audience=os.getenv("SUPABASE_JWT_AUDIENCE", "authenticated"),
            cache_seconds=int(os.getenv("REVIEW_AUTH_CACHE_SECONDS", "60")),
        )

    def _cache_key(self, token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def _read_cache(self, token: str) -> Optional[str]:
        cache_key = self._cache_key(token)
        now = time.time()
        with self._cache_lock:
            cached = self._cache.get(cache_key)
            if cached and cached.valid_until > now:
                return cached.user_id
            if cached:
                self._cache.pop(cache_key, None)
        return None

    def _write_cache(self, token: str, user_id: str, token_exp: Optional[float] = None) -> None:
        now = time.time()
        valid_until = now + self.cache_seconds
        if token_exp is not None:
            valid_until = min(valid_until, float(token_exp))
        with self._cache_lock:
            self._cache[self._cache_key(token)] = _CachedIdentity(user_id, valid_until)
            if len(self._cache) > 1024:
                expired = [key for key, value in self._cache.items() if value.valid_until <= now]
                for key in expired:
                    self._cache.pop(key, None)

    @staticmethod
    def _user_id_from_claims(claims: Dict[str, Any]) -> str:
        user_id = str(claims.get("sub") or "").strip()
        if not user_id:
            raise ReviewAuthenticationError("登录凭证缺少用户标识，请重新登录")
        return user_id

    def _verify_jwt(self, token: str) -> Tuple[str, Optional[float]]:
        if jwt is None:
            raise ReviewAuthConfigurationError("后端缺少 PyJWT 依赖")

        try:
            header = jwt.get_unverified_header(token)
            algorithm = str(header.get("alg") or "").upper()
            decode_options = {
                "algorithms": [algorithm],
                "audience": self.audience,
                "issuer": self.issuer,
            }
            if algorithm.startswith("HS"):
                if not self.jwt_secret:
                    raise ReviewAuthConfigurationError("HS 系列令牌需要配置 SUPABASE_JWT_SECRET")
                claims = jwt.decode(token, self.jwt_secret, **decode_options)
            else:
                if self._jwk_client is None:
                    raise ReviewAuthConfigurationError("Supabase JWKS 校验地址尚未配置")
                signing_key = self._jwk_client.get_signing_key_from_jwt(token)
                claims = jwt.decode(token, signing_key.key, **decode_options)
        except ReviewAuthConfigurationError:
            raise
        except Exception as exc:
            raise ReviewAuthenticationError("登录已过期或凭证校验失败，请重新登录") from exc

        return self._user_id_from_claims(claims), claims.get("exp")

    def _verify_with_auth_api(self, token: str) -> Tuple[str, Optional[float]]:
        if not self.supabase_url or not self.anon_key:
            raise ReviewAuthConfigurationError(
                "请配置 SUPABASE_URL 与 SUPABASE_ANON_KEY，或同时配置 SUPABASE_JWT_SECRET"
            )
        try:
            request = urllib.request.Request(
                f"{self.supabase_url}/auth/v1/user",
                headers={
                    "apikey": self.anon_key,
                    "Authorization": f"Bearer {token}",
                },
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                if response.status != 200:
                    raise ReviewAuthenticationError("登录已过期或凭证校验失败，请重新登录")
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise ReviewAuthenticationError("登录已过期或凭证校验失败，请重新登录") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise ReviewAuthenticationError("登录服务连接失败，请稍后重试") from exc
        except (ValueError, json.JSONDecodeError) as exc:
            raise ReviewAuthenticationError("登录服务返回了异常响应") from exc
        user_id = str(payload.get("id") or "").strip()
        if not user_id:
            raise ReviewAuthenticationError("登录凭证缺少用户标识，请重新登录")
        return user_id, None

    def verify(self, token: str) -> str:
        cached_user_id = self._read_cache(token)
        if cached_user_id:
            return cached_user_id
        if not self.supabase_url:
            raise ReviewAuthConfigurationError("请在 Railway 配置 SUPABASE_URL")

        try:
            user_id, token_exp = self._verify_jwt(token)
        except ReviewAuthConfigurationError:
            user_id, token_exp = self._verify_with_auth_api(token)
        self._write_cache(token, user_id, token_exp)
        return user_id


class FairUserConcurrencyLimiter:
    """Bound global/per-user work while rotating fairly across waiting users."""

    def __init__(self, global_limit: int, per_user_limit: int) -> None:
        self.global_limit = max(1, int(global_limit))
        self.per_user_limit = min(self.global_limit, max(1, int(per_user_limit)))
        self._lock = asyncio.Lock()
        self._active_total = 0
        self._active_by_user: Dict[str, int] = defaultdict(int)
        self._waiters: Dict[str, Deque[asyncio.Future[None]]] = {}
        self._rotation: Deque[str] = deque()

    def _drop_cancelled_locked(self, user_id: str) -> None:
        queue = self._waiters.get(user_id)
        if queue is None:
            return
        while queue and queue[0].cancelled():
            queue.popleft()
        if not queue:
            self._waiters.pop(user_id, None)

    def _dispatch_locked(self) -> None:
        while self._active_total < self.global_limit and self._rotation:
            round_size = len(self._rotation)
            granted_this_round = False
            for _ in range(round_size):
                user_id = self._rotation.popleft()
                self._drop_cancelled_locked(user_id)
                queue = self._waiters.get(user_id)
                if not queue:
                    continue

                if self._active_by_user[user_id] < self.per_user_limit:
                    waiter = queue.popleft()
                    if not waiter.cancelled():
                        self._active_total += 1
                        self._active_by_user[user_id] += 1
                        waiter.set_result(None)
                        granted_this_round = True

                self._drop_cancelled_locked(user_id)
                if user_id in self._waiters:
                    self._rotation.append(user_id)
                if self._active_total >= self.global_limit:
                    break
            if not granted_this_round:
                break

    async def acquire(self, user_id: str) -> None:
        normalized_user_id = str(user_id).strip()
        if not normalized_user_id:
            raise ValueError("user_id is required")
        loop = asyncio.get_running_loop()
        waiter: asyncio.Future[None] = loop.create_future()
        async with self._lock:
            queue = self._waiters.get(normalized_user_id)
            if queue is None:
                queue = deque()
                self._waiters[normalized_user_id] = queue
                # A newly waiting user goes first on the next available slot.
                self._rotation.appendleft(normalized_user_id)
            queue.append(waiter)
            self._dispatch_locked()

        try:
            await asyncio.shield(waiter)
        except asyncio.CancelledError:
            async with self._lock:
                if waiter.done() and not waiter.cancelled():
                    self._active_total -= 1
                    self._active_by_user[normalized_user_id] -= 1
                    if self._active_by_user[normalized_user_id] <= 0:
                        self._active_by_user.pop(normalized_user_id, None)
                else:
                    waiter.cancel()
                    queue = self._waiters.get(normalized_user_id)
                    if queue is not None:
                        try:
                            queue.remove(waiter)
                        except ValueError:
                            pass
                    self._drop_cancelled_locked(normalized_user_id)
                    if normalized_user_id not in self._waiters:
                        self._rotation = deque(
                            item for item in self._rotation if item != normalized_user_id
                        )
                self._dispatch_locked()
            raise

    async def release(self, user_id: str) -> None:
        normalized_user_id = str(user_id).strip()
        async with self._lock:
            if self._active_by_user.get(normalized_user_id, 0) <= 0:
                raise RuntimeError("concurrency slot released without a matching acquire")
            self._active_total -= 1
            self._active_by_user[normalized_user_id] -= 1
            if self._active_by_user[normalized_user_id] == 0:
                self._active_by_user.pop(normalized_user_id, None)
            self._dispatch_locked()

    @asynccontextmanager
    async def slot(self, user_id: str) -> AsyncIterator[None]:
        await self.acquire(user_id)
        try:
            yield
        finally:
            await asyncio.shield(self.release(user_id))

    async def snapshot(self) -> Dict[str, Any]:
        async with self._lock:
            return {
                "globalLimit": self.global_limit,
                "perUserLimit": self.per_user_limit,
                "activeTotal": self._active_total,
                "activeByUser": dict(self._active_by_user),
                "queuedByUser": {
                    user_id: sum(1 for waiter in queue if not waiter.cancelled())
                    for user_id, queue in self._waiters.items()
                },
            }
