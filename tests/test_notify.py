import base64
import json
from datetime import datetime, timezone

import pytest

from family_specials.notify import decode_code, plan

FRI = datetime(2026, 10, 16, 1, 0, tzinfo=timezone.utc)        # Friday 16 Oct in Sydney (week from Wed 14 Oct)
SAT = datetime(2026, 10, 17, 1, 0, tzinfo=timezone.utc)
NEXT_THU = datetime(2026, 10, 22, 1, 0, tzinfo=timezone.utc)    # Thursday 22 Oct: the next week (from Wed 21 Oct)


def offer(chain="woolworths", price=520, was=690, since="2026-10-15T22:00:00Z", special=True, unit=None):
    return {"id": f"{chain}:1", "chain": chain, "store": chain.title(), "name": "Product", "price_cents": price,
            "price_per": "each", "was_cents": was, "multibuy": None, "special": special, "promo": "20% Off",
            "signals": [], "special_since": since, "seen_at": since, "unit_cents": unit or price,
            "multibuy_unit_cents": None, "valid_to": None, "valid_to_assumed": False}


def watch(*items):
    return {"items": [{"key": k, "name": k.title(), "offers": offers} for k, offers in items]}


def status(woolworths_updated="2026-10-15T22:30:00Z", coles="paused"):
    return {"stores": [{"chain": "woolworths", "updates_from": "mac", "last_updated": woolworths_updated},
                       {"chain": "coles", "updates_from": coles, "last_updated": None}]}


def test_first_run_sends_one_digest_covering_everything_on_special():
    w = watch(("peas", [offer()]), ("tea", [offer(price=675, was=1350)]), ("milk", [offer(special=False)]))
    messages, rows = plan(w, status(), [], FRI)
    assert len(messages) == 1 and messages[0]["tag"] == "digest"
    assert "2 watched items on special, could save $8.45" in messages[0]["body"]
    assert {r["item_key"] for r in rows if r["kind"] == "digest-item"} == {"peas", "tea"}
    # Run again: nothing new.
    assert plan(w, status(), rows, FRI) == ([], [])


def test_one_notification_per_item_per_week():
    w = watch(("peas", [offer()]))
    _, sent = plan(w, status(), [], FRI)
    # Saturday: ALDI also puts peas on special. Already told this week, so it's only remembered.
    w2 = watch(("peas", [offer(), offer(chain="aldi", price=359, was=399, since="2026-10-16T23:00:00Z")]))
    messages, rows = plan(w2, status(), sent, SAT)
    assert messages == [] and [r["kind"] for r in rows] == ["seen"]


def test_new_item_midweek_gets_its_own_notification():
    _, sent = plan(watch(("peas", [offer()])), status(), [], FRI)
    w = watch(("peas", [offer()]), ("tea", [offer(price=675, was=1350, since="2026-10-16T23:00:00Z")]))
    messages, rows = plan(w, status(), sent, SAT)
    assert [m["title"] for m in messages] == ["Tea is on special"]
    assert messages[0]["body"] == "Woolworths: $6.75, was $13.50 (20% Off)."
    assert messages[0]["url"] == "#/watch/tea"


def test_many_new_items_at_once_are_combined():
    _, sent = plan(watch(), status(), [], FRI)           # the digest has gone out
    w = watch(*[(k, [offer(since="2026-10-16T23:00:00Z")]) for k in ("a", "b", "c", "d", "e")])
    messages, _ = plan(w, status(), sent, SAT)
    assert len(messages) == 1 and messages[0]["title"] == "5 watched items on special"
    assert messages[0]["body"] == "A, B, C, D and 1 more."


def test_a_special_that_carries_on_into_next_week_isnt_told_again():
    w = watch(("peas", [offer()]))
    _, sent = plan(w, status(), [], FRI)
    messages, rows = plan(w, status("2026-10-21T22:30:00Z"), sent, NEXT_THU)
    assert [m["tag"] for m in messages] == ["digest"]                 # the weekly digest only
    assert [r["kind"] for r in rows] == ["digest"]


def test_digest_waits_for_woolworths_until_thursday_evening():
    w = watch(("peas", [offer(chain="aldi")]))
    # Woolworths last updated the week before (Fri 16 Oct), so this week's digest waits until Thursday 6pm.
    early = datetime(2026, 10, 21, 22, 0, tzinfo=timezone.utc)       # Thu 22 Oct, 9am Sydney
    messages, _ = plan(w, status("2026-10-15T22:30:00Z"), [], early)
    assert [m["tag"] for m in messages] == ["item-peas"]
    late = datetime(2026, 10, 22, 8, 0, tzinfo=timezone.utc)         # Thu 22 Oct, 7pm Sydney
    messages, _ = plan(w, status("2026-10-15T22:30:00Z"), [], late)
    assert [m["tag"] for m in messages] == ["digest"]


def test_paused_stores_never_notify():
    messages, rows = plan(watch(("peas", [offer(chain="coles")])), status(), [], FRI)
    assert "Nothing on your watchlist" in messages[0]["body"] and not [r for r in rows if r["item_key"]]


def _code(endpoint, name="Marquez iPhone"):
    raw = json.dumps({"e": endpoint, "k": {"p256dh": "BPk", "auth": "x1"}, "n": name}).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def test_phone_codes_must_point_at_a_real_push_service():
    d = decode_code(_code("https://web.push.apple.com/QGx2"))
    assert d["name"] == "Marquez iPhone" and d["keys"] == {"p256dh": "BPk", "auth": "x1"}
    assert decode_code(_code("https://fcm.googleapis.com/fcm/send/abc"))["endpoint"].startswith("https://fcm")
    for bad in ("https://evil.example.com/x", "http://web.push.apple.com/x", "https://web.push.apple.com.evil.io/x"):
        with pytest.raises(ValueError):
            decode_code(_code(bad))
    with pytest.raises(ValueError):
        decode_code("not a code")
