"""
Cross-language conformance: the Python client drives the TypeScript reference
server over HTTP, and every message the server returns is validated against the
*published* JSON Schemas in ``schemas/``. If the TS implementation ever drifts
from the contract, these tests fail — proving the schemas are a real, shared
contract and not TS-only documentation.

Run from anywhere: ``python -m pytest clients/python`` (needs a built ``dist/``).
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from agentbus import AgentBusClient, AgentBusError, PROTOCOL_ID

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "dist" / "cli.js"
SCHEMAS = ROOT / "schemas"

ALL_TYPES = {
    "task.created",
    "task.claimed",
    "task.completed",
    "task.blocked",
    "task.released",
    "task.cancelled",
    "status.update",
    "request.help",
}


def _validator(name: str) -> Draft202012Validator:
    schema = json.loads((SCHEMAS / name).read_text())
    return Draft202012Validator(schema, format_checker=FormatChecker())


MESSAGE = _validator("message.schema.json")
MESSAGE_INPUT = _validator("message.input.schema.json")
TASK = _validator("task.schema.json")


def assert_valid(validator: Draft202012Validator, instance) -> None:
    errors = sorted(validator.iter_errors(instance), key=str)
    assert not errors, "schema violations: " + "; ".join(e.message for e in errors) + f"\n{instance}"


@pytest.fixture()
def client():
    assert CLI.exists(), f"built CLI not found at {CLI} — run `pnpm build` first"
    tmp = tempfile.mkdtemp(prefix="agentbus-py-")
    proc = subprocess.Popen(
        ["node", str(CLI), "serve", "--port", "0", "--dir", tmp],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    url = None
    deadline = time.time() + 20
    while time.time() < deadline:
        line = proc.stdout.readline() if proc.stdout else ""
        if not line:
            if proc.poll() is not None:
                raise RuntimeError("server exited before reporting a URL")
            continue
        m = re.search(r"at (http://\S+)", line)
        if m:
            url = m.group(1).strip()
            break
    if not url:
        proc.terminate()
        raise RuntimeError("could not determine server URL")

    c = AgentBusClient(url)
    healthy = False
    for _ in range(50):
        try:
            if c.health().get("ok"):
                healthy = True
                break
        except Exception:
            pass
        time.sleep(0.1)
    if not healthy:
        proc.terminate()
        raise RuntimeError("server started but never became healthy")
    try:
        yield c
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


def test_identity(client):
    assert client.health()["protocol"] == PROTOCOL_ID
    assert client.meta()["protocol"] == PROTOCOL_ID


def test_post_assigns_envelope_and_validates(client):
    m = client.post({"type": "status.update", "agent": "py", "text": "hello"})
    assert m["seq"] == 1
    assert isinstance(m["id"], str) and m["id"]
    assert isinstance(m["ts"], str) and m["ts"]
    assert_valid(MESSAGE, m)


def test_input_payload_satisfies_published_input_schema(client):
    payload = {"type": "status.update", "agent": "py", "text": "hi"}
    assert_valid(MESSAGE_INPUT, payload)  # the payload we send is itself contract-valid
    assert_valid(MESSAGE, client.post(payload))


def test_full_lifecycle_messages_all_validate(client):
    client.create_task(title="A", agent="lead", task_id="a")
    client.claim("a", "w1")
    client.complete("a", "w1", result={"ok": True})

    client.create_task(title="B", agent="lead", task_id="b")
    client.claim("b", "w1")
    client.block("b", "w1", reason="stuck")
    client.release("b", "w1")

    client.create_task(title="C", agent="lead", task_id="c")
    client.cancel("c", "lead")

    client.post({"type": "status.update", "agent": "py", "text": "note"})
    client.post({"type": "request.help", "agent": "py", "text": "help", "severity": "high"})

    msgs = client.get_messages()
    for m in msgs:
        assert_valid(MESSAGE, m)
    assert {m["type"] for m in msgs} == ALL_TYPES  # every type exercised


def test_task_view_validates_against_task_schema(client):
    client.create_task(
        title="Full", agent="lead", task_id="t1", description="d", priority="high", tags=["x", "y"]
    )
    client.claim("t1", "w1")
    task = client.get_task("t1")
    assert_valid(TASK, task)
    assert task["state"] == "claimed"
    assert client.get_task("missing") is None


def test_single_claimer(client):
    client.create_task(title="one", agent="lead", task_id="t1")
    first = client.claim("t1", "w1")
    assert first["ok"] is True
    second = client.claim("t1", "w2")
    assert second["ok"] is False
    assert second["reason"] == "not_open"


def test_concurrent_claims_single_winner(client):
    import concurrent.futures as cf

    client.create_task(title="one", agent="lead", task_id="t1")
    with cf.ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(lambda i: client.claim("t1", f"w{i}"), range(10)))
    wins = [r for r in results if r["ok"]]
    assert len(wins) == 1
    assert all(r["reason"] == "not_open" for r in results if not r["ok"])


def test_validation_error_maps_to_400(client):
    with pytest.raises(AgentBusError) as ei:
        client.post({"type": "task.created", "agent": "a"})  # missing title
    assert ei.value.status == 400
    assert ei.value.body["error"] == "validation"


def test_illegal_transition_maps_to_409(client):
    client.create_task(title="X", agent="lead", task_id="t1")
    client.post({"type": "task.claimed", "agent": "w1", "taskId": "t1"})
    with pytest.raises(AgentBusError) as ei:
        client.post({"type": "task.claimed", "agent": "w2", "taskId": "t1"})
    assert ei.value.status == 409
    assert ei.value.body["reason"] == "not_open"


def test_idempotent_repost(client):
    a = client.post({"type": "status.update", "agent": "a", "text": "once", "id": "fixed"})
    b = client.post({"type": "status.update", "agent": "a", "text": "twice", "id": "fixed"})
    assert a["seq"] == b["seq"]
    assert b["text"] == "once"


def test_message_filters(client):
    client.create_task(title="A", agent="lead", task_id="t1")
    client.create_task(title="B", agent="lead", task_id="t2")
    client.post({"type": "status.update", "agent": "w1", "text": "on it", "taskId": "t1"})
    assert len(client.get_messages(type="task.created")) == 2
    assert len(client.get_messages(task_id="t1")) == 2  # created + the status update
    assert len(client.get_messages(agent="w1")) == 1
    assert [m["seq"] for m in client.get_messages(from_seq=2)] == [3]


def test_subscribe_streams_in_order(client):
    client.post({"type": "status.update", "agent": "a", "text": "1"})
    client.post({"type": "status.update", "agent": "a", "text": "2"})
    client.post({"type": "status.update", "agent": "a", "text": "3"})
    got = []
    for m in client.subscribe(from_seq=0):
        assert_valid(MESSAGE, m)
        got.append(m["seq"])
        if len(got) >= 3:
            break
    assert got == [1, 2, 3]
