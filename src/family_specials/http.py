"""A polite HTTP client: robots.txt, delays between requests, a request budget,
and a hard stop at the first sign of blocking. It never retries around a block."""

from __future__ import annotations

import logging
import random
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import httpx

log = logging.getLogger(__name__)

UA_TOKEN = "FamilySpecialsFinder"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    f"Chrome/130.0 Safari/537.36 {UA_TOKEN}/0.1 (household use)"
)

class Blocked(Exception):
    """The site refused or challenged us. Stop collecting from this chain."""


class NotFound(Exception):
    """HTTP 404: the page doesn't exist (not a block). Skip it and carry on."""


class RobotsDisallowed(Exception):
    pass


class BudgetExceeded(Exception):
    pass


@dataclass
class RobotsRules:
    """robots.txt rules for one host, with Google-style `*` and `$` wildcards
    (Python's urllib.robotparser doesn't support them)."""

    rules: list[tuple[bool, re.Pattern, int]] = field(default_factory=list)

    @classmethod
    def parse(cls, text: str, agent_token: str = UA_TOKEN) -> RobotsRules:
        groups: list[tuple[list[str], list[tuple[bool, str]]]] = []
        agents: list[str] = []
        lines: list[tuple[bool, str]] = []
        last_was_agent = False
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            key, value = (p.strip() for p in line.split(":", 1))
            key = key.lower()
            if key == "user-agent":
                if not last_was_agent and (agents or lines):
                    groups.append((agents, lines))
                    agents, lines = [], []
                agents.append(value.lower())
                last_was_agent = True
            elif key in ("allow", "disallow"):
                lines.append((key == "allow", value))
                last_was_agent = False
            else:
                last_was_agent = False
        if agents or lines:
            groups.append((agents, lines))

        token = agent_token.lower()
        specific = [ls for ags, ls in groups if any(a != "*" and a in token for a in ags)]
        chosen = specific or [ls for ags, ls in groups if "*" in ags]
        rules = []
        for ls in chosen:
            for allow, pattern in ls:
                if not pattern:  # "Disallow:" (empty) allows everything
                    continue
                rules.append((allow, _robots_regex(pattern), len(pattern)))
        return cls(rules)

    def allowed(self, path_and_query: str) -> bool:
        best: tuple[int, bool] | None = None
        for allow, regex, length in self.rules:
            if regex.match(path_and_query):
                if best is None or length > best[0] or (length == best[0] and allow):
                    best = (length, allow)
        return True if best is None else best[1]


def _robots_regex(pattern: str) -> re.Pattern:
    anchored = pattern.endswith("$")
    if anchored:
        pattern = pattern[:-1]
    body = ".*".join(re.escape(part) for part in pattern.split("*"))
    return re.compile(body + ("$" if anchored else ""))


class PoliteClient:
    def __init__(
        self,
        chain: str,
        *,
        delay_seconds: tuple[float, float] = (3.0, 6.0),
        max_requests: int = 100,
        user_agent: str = DEFAULT_USER_AGENT,
        cookies: dict[str, str] | None = None,
        sleep=time.sleep,
    ):
        self.chain = chain
        self.delay_seconds = delay_seconds
        self.max_requests = max_requests
        self.requests_made = 0
        self._sleep = sleep
        self._last_request_at: float | None = None
        self._robots: dict[str, RobotsRules] = {}
        self.http = httpx.Client(
            headers={
                "User-Agent": user_agent,
                "Accept-Language": "en-AU,en;q=0.9",
            },
            cookies=cookies,
            timeout=httpx.Timeout(30.0),
            follow_redirects=True,
        )

    def close(self) -> None:
        self.http.close()

    def __enter__(self) -> PoliteClient:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- robots.txt -------------------------------------------------------

    def _rules_for(self, url: str) -> RobotsRules:
        parts = urlsplit(url)
        host = f"{parts.scheme}://{parts.netloc}"
        if host not in self._robots:
            robots_url = f"{host}/robots.txt"
            self._wait()
            self._count()
            try:
                resp = self.http.get(robots_url)
            except httpx.HTTPError as e:
                raise Blocked(f"Couldn't read {robots_url}: {e}") from e
            ctype = resp.headers.get("content-type", "")
            if resp.status_code >= 500:
                raise Blocked(f"{robots_url} returned {resp.status_code}; not collecting")
            if resp.status_code >= 400 or "html" in ctype or resp.text.lstrip().startswith("<"):
                # No robots.txt published (Costco serves its app page instead): no rules.
                rules = RobotsRules()
            else:
                rules = RobotsRules.parse(resp.text)
            self._robots[host] = rules
        return self._robots[host]

    def check_robots(self, url: str) -> None:
        parts = urlsplit(url)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        if not self._rules_for(url).allowed(path):
            raise RobotsDisallowed(f"robots.txt disallows {url}")

    # -- requests ---------------------------------------------------------

    def _wait(self) -> None:
        if self._last_request_at is not None:
            gap = random.uniform(*self.delay_seconds)
            elapsed = time.monotonic() - self._last_request_at
            if elapsed < gap:
                self._sleep(gap - elapsed)
        self._last_request_at = time.monotonic()

    def _count(self) -> None:
        if self.requests_made >= self.max_requests:
            raise BudgetExceeded(f"{self.chain}: request budget of {self.max_requests} used up")
        self.requests_made += 1

    def request(
        self,
        method: str,
        url: str,
        *,
        expect: str = "json",
        require: str | None = None,
        **kwargs,
    ) -> httpx.Response:
        """expect: 'json' (must parse as JSON), 'html' (must contain `require`), or 'any'."""
        self.check_robots(url)
        if self.requests_made >= self.max_requests:
            raise BudgetExceeded(f"{self.chain}: request budget of {self.max_requests} used up")
        self._wait()
        self._count()
        log.debug("%s %s %s", self.chain, method, url)
        try:
            resp = self.http.request(method, url, **kwargs)
        except httpx.HTTPError as e:
            raise Blocked(f"{method} {url} failed: {e}") from e
        self._check_blocked(resp, expect, require)
        return resp

    def get(self, url: str, **kwargs) -> httpx.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs) -> httpx.Response:
        return self.request("POST", url, **kwargs)

    @staticmethod
    def _check_blocked(resp: httpx.Response, expect: str, require: str | None) -> None:
        where = f"{resp.request.method} {resp.request.url}"
        if resp.status_code == 404:
            raise NotFound(f"{where} returned HTTP 404")
        if resp.status_code >= 400:
            raise Blocked(f"{where} returned HTTP {resp.status_code}")
        if expect == "json":
            if "json" not in resp.headers.get("content-type", ""):
                raise Blocked(f"{where}: expected JSON, got a web page (possible bot challenge)")
            try:
                resp.json()
            except ValueError as e:
                raise Blocked(f"{where}: unreadable JSON") from e
        elif expect == "html" and require and require not in resp.text:
            raise Blocked(f"{where}: page is missing '{require}' (possible bot challenge)")
