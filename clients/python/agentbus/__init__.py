"""
agent-bus — minimal Python reference client for the HTTP transport.

A second-language implementation of the ``agent-bus/0`` protocol, used to prove
the wire contract is language-agnostic: it talks to the TypeScript reference
server and its messages validate against the *same* published JSON Schemas
(see ``schemas/``). Standard library only — no third-party runtime dependencies.

This is a thin, faithful client (request/response + SSE); the server upholds the
ordering and single-claimer guarantees (PROTOCOL.md §6).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Iterator, Optional
from urllib.parse import quote, urlencode

PROTOCOL_ID = "agent-bus/0"

__all__ = ["AgentBusClient", "AgentBusError", "PROTOCOL_ID"]


class AgentBusError(Exception):
    """An HTTP-level error returned by the bus (non-2xx, unexpected status).

    Carries the HTTP ``status`` and the parsed JSON ``body`` so callers can
    branch on ``body.get("error")`` / ``body.get("reason")`` exactly as the
    protocol's reason codes are documented (PROTOCOL.md §5).
    """

    def __init__(self, status: int, body: Any):
        self.status = status
        self.body = body
        message = ""
        if isinstance(body, dict):
            message = body.get("message") or body.get("error") or ""
        super().__init__(f"HTTP {status}: {message}")


class AgentBusClient:
    """A client for a running ``agent-bus`` HTTP server."""

    def __init__(self, base_url: str, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # ---- low-level ----------------------------------------------------------

    def _request(self, method: str, path: str, body: Optional[dict] = None):
        url = self.base_url + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8")
            try:
                parsed = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = {"error": "error", "message": raw}
            return e.code, parsed

    def _expect(self, method: str, path: str, body: Optional[dict], ok: int):
        status, data = self._request(method, path, body)
        if status != ok:
            raise AgentBusError(status, data)
        return data

    # ---- identity -----------------------------------------------------------

    def health(self) -> dict:
        return self._expect("GET", "/health", None, 200)

    def meta(self) -> dict:
        return self._expect("GET", "/meta", None, 200)

    # ---- messages -----------------------------------------------------------

    def post(self, message: dict) -> dict:
        """Append any message. The bus assigns id/seq/ts and returns the record."""
        return self._expect("POST", "/messages", message, 201)

    def get_messages(
        self,
        from_seq: Optional[int] = None,
        type: Optional[Any] = None,
        task_id: Optional[str] = None,
        agent: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> list:
        params: dict[str, Any] = {}
        if from_seq is not None:
            params["fromSeq"] = from_seq
        if type is not None:
            params["type"] = type  # str or list of str (doseq handles lists)
        if task_id is not None:
            params["taskId"] = task_id
        if agent is not None:
            params["agent"] = agent
        if limit is not None:
            params["limit"] = limit
        qs = urlencode(params, doseq=True)
        return self._expect("GET", "/messages" + (f"?{qs}" if qs else ""), None, 200)

    # ---- tasks --------------------------------------------------------------

    def create_task(
        self,
        title: str,
        agent: str,
        task_id: Optional[str] = None,
        description: Optional[str] = None,
        priority: Optional[str] = None,
        tags: Optional[list] = None,
        id: Optional[str] = None,
    ) -> dict:
        body: dict[str, Any] = {"title": title, "agent": agent}
        if task_id is not None:
            body["taskId"] = task_id
        if description is not None:
            body["description"] = description
        if priority is not None:
            body["priority"] = priority
        if tags is not None:
            body["tags"] = tags
        if id is not None:
            body["id"] = id
        return self._expect("POST", "/tasks", body, 201)

    def get_tasks(self, state: Optional[Any] = None) -> list:
        params: dict[str, Any] = {}
        if state is not None:
            params["state"] = state
        qs = urlencode(params, doseq=True)
        return self._expect("GET", "/tasks" + (f"?{qs}" if qs else ""), None, 200)

    def get_task(self, task_id: str) -> Optional[dict]:
        status, data = self._request("GET", f"/tasks/{quote(task_id)}", None)
        if status == 404:
            return None
        if status != 200:
            raise AgentBusError(status, data)
        return data

    def claim(self, task_id: str, agent: str, id: Optional[str] = None) -> dict:
        """Attempt to claim a task. Returns a ClaimResult dict (``{"ok": ...}``).
        201 = won, 409 = lost the race — both are successful exchanges."""
        body: dict[str, Any] = {"agent": agent}
        if id is not None:
            body["id"] = id
        status, data = self._request("POST", f"/tasks/{quote(task_id)}/claim", body)
        if status in (201, 409):
            return data
        raise AgentBusError(status, data)

    def complete(self, task_id: str, agent: str, result: Any = None, note: Optional[str] = None) -> dict:
        body: dict[str, Any] = {"agent": agent}
        if result is not None:
            body["result"] = result
        if note is not None:
            body["note"] = note
        return self._expect("POST", f"/tasks/{quote(task_id)}/complete", body, 201)

    def block(self, task_id: str, agent: str, reason: str, note: Optional[str] = None) -> dict:
        body: dict[str, Any] = {"agent": agent, "reason": reason}
        if note is not None:
            body["note"] = note
        return self._expect("POST", f"/tasks/{quote(task_id)}/block", body, 201)

    def release(self, task_id: str, agent: str, reason: Optional[str] = None) -> dict:
        body: dict[str, Any] = {"agent": agent}
        if reason is not None:
            body["reason"] = reason
        return self._expect("POST", f"/tasks/{quote(task_id)}/release", body, 201)

    def cancel(self, task_id: str, agent: str, reason: Optional[str] = None) -> dict:
        body: dict[str, Any] = {"agent": agent}
        if reason is not None:
            body["reason"] = reason
        return self._expect("POST", f"/tasks/{quote(task_id)}/cancel", body, 201)

    # ---- subscriptions (Server-Sent Events) ---------------------------------

    def subscribe(self, from_seq: int = 0) -> Iterator[dict]:
        """Yield every message with ``seq`` > ``from_seq``, in order. The
        underlying HTTP connection stays open; break out of the loop to close."""
        url = self.base_url + f"/subscribe?fromSeq={from_seq}"
        req = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
        resp = urllib.request.urlopen(req, timeout=self.timeout)
        try:
            for raw in resp:
                line = raw.decode("utf-8").rstrip("\n")
                if not line.startswith("data:"):
                    continue
                payload = line[len("data:") :].strip()
                try:
                    obj = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict) and isinstance(obj.get("seq"), int):
                    yield obj
        finally:
            resp.close()
