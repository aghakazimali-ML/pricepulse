"""Polite async HTTP client: robots.txt, rate limiting, concurrency cap and retries."""

import asyncio
import logging
import random
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import httpx
from tenacity import (
    AsyncRetrying,
    RetryCallState,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential_jitter,
)

from src.config import Settings
from src.extract.base import ExtractStats

log = logging.getLogger(__name__)

RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class RetryableStatusError(Exception):
    def __init__(self, response: httpx.Response) -> None:
        super().__init__(f"HTTP {response.status_code} for {response.request.url}")
        self.response = response


class RobotsDisallowedError(Exception):
    pass


def _is_retryable(exc: BaseException) -> bool:
    return isinstance(exc, (RetryableStatusError, httpx.TimeoutException, httpx.TransportError))


class PoliteClient:
    """Wraps httpx.AsyncClient. Use as `async with PoliteClient(settings, stats) as client`."""

    def __init__(
        self,
        settings: Settings,
        stats: ExtractStats,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self.stats = stats
        self._semaphore = asyncio.Semaphore(settings.max_concurrency)
        self._robots: dict[str, RobotFileParser | None] = {}
        self._robots_lock = asyncio.Lock()
        self._client = httpx.AsyncClient(
            headers={"User-Agent": settings.user_agent, "Accept-Language": "en"},
            timeout=settings.request_timeout_seconds,
            follow_redirects=True,
            transport=transport,
        )

    async def __aenter__(self) -> "PoliteClient":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self._client.aclose()

    async def _robot_parser(self, url: str) -> RobotFileParser | None:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        async with self._robots_lock:
            if origin not in self._robots:
                parser: RobotFileParser | None = RobotFileParser()
                try:
                    resp = await self._client.get(urljoin(origin, "/robots.txt"))
                    if resp.status_code == 200:
                        parser.parse(resp.text.splitlines())
                    else:
                        parser = None  # no robots.txt (404 etc.) -> everything allowed
                except httpx.HTTPError as exc:
                    log.warning("robots.txt unavailable, assuming allowed", extra={"origin": origin, "error": str(exc)})
                    parser = None
                self._robots[origin] = parser
            return self._robots[origin]

    async def allowed(self, url: str) -> bool:
        if not self.settings.respect_robots_txt:
            return True
        parser = await self._robot_parser(url)
        return parser is None or parser.can_fetch(self.settings.user_agent, url)

    def _on_retry(self, state: RetryCallState) -> None:
        self.stats.retries += 1
        exc = state.outcome.exception() if state.outcome else None
        log.warning("retrying request", extra={"attempt": state.attempt_number, "error": str(exc)})

    async def get_text(self, url: str) -> str:
        """GET a page politely and return its decoded body.

        Raises RobotsDisallowedError, or the last error after retries are exhausted.
        """
        if not await self.allowed(url):
            self.stats.robots_blocked += 1
            raise RobotsDisallowedError(f"robots.txt disallows {url}")

        async with self._semaphore:
            retrying = AsyncRetrying(
                retry=retry_if_exception(_is_retryable),
                stop=stop_after_attempt(self.settings.max_retries),
                wait=wait_exponential_jitter(initial=0.5, max=10, jitter=0.5)
                if self.settings.max_delay_seconds > 0
                else wait_exponential_jitter(initial=0, max=0, jitter=0),
                before_sleep=self._on_retry,
                reraise=True,
            )
            async for attempt in retrying:
                with attempt:
                    await self._polite_pause()
                    response = await self._client.get(url)
                    if response.status_code in RETRYABLE_STATUS:
                        raise RetryableStatusError(response)
                    response.raise_for_status()
            self.stats.pages_fetched += 1
            return response.text

    async def _polite_pause(self) -> None:
        delay = random.uniform(self.settings.min_delay_seconds, self.settings.max_delay_seconds)
        if delay > 0:
            await asyncio.sleep(delay)
