from datetime import datetime, timezone

from family_specials.watch_export import item_unit_cents, max_weight_kg, special_status, usual_price

# Wednesday 15 Oct 2026, midnight in Sydney (daylight saving: UTC+11).
CYCLE = datetime(2026, 10, 14, 13, 0, tzinfo=timezone.utc)


def test_special_is_new_when_we_saw_it_at_normal_price_last_week():
    rows = [("2026-10-11T22:00:00Z", 270, False, None), ("2026-10-15T22:00:00Z", 200, True, None)]
    assert special_status(rows, CYCLE) == ("2026-10-15T22:00:00Z", True)


def test_special_that_started_last_cycle_is_not_new():
    rows = [("2026-10-05T03:00:00Z", 375, True, 650), ("2026-10-15T22:00:00Z", 375, True, 650)]
    assert special_status(rows, CYCLE) == ("2026-10-05T03:00:00Z", False)


def test_a_different_special_price_counts_as_new():
    rows = [("2026-10-11T22:00:00Z", 900, True, None), ("2026-10-15T22:00:00Z", 720, True, None)]
    assert special_status(rows, CYCLE)[1] is True


def test_cant_tell_if_new_without_a_read_in_the_week_before():
    first_time = [("2026-10-15T22:00:00Z", 520, True, None)]
    assert special_status(first_time, CYCLE) == ("2026-10-15T22:00:00Z", None)
    gap = [("2026-09-28T22:00:00Z", 690, False, None), ("2026-10-15T22:00:00Z", 520, True, None)]
    assert special_status(gap, CYCLE)[1] is None


def test_not_on_special_has_no_status():
    assert special_status([("2026-10-15T22:00:00Z", 690, False, None)], CYCLE) == (None, None)


def test_usual_price_is_the_latest_normal_price_and_its_weeks():
    rows = [("2026-09-28T03:00:00Z", 650, False), ("2026-10-05T03:00:00Z", 690, False),
            ("2026-10-11T22:00:00Z", 690, False), ("2026-10-12T22:00:00Z", 690, False),
            ("2026-10-15T22:00:00Z", 520, True)]
    # Sydney weeks: 5 Oct, then 12 Oct (twice: 11 Oct 22:00 UTC is Monday morning in Sydney).
    assert usual_price(rows) == (690, 2)
    assert usual_price([("2026-10-15T22:00:00Z", 520, True)]) == (None, 0)


def test_weighed_items_use_the_top_of_the_weight_range():
    assert max_weight_kg("Pork Rashers 350g - 800g") == 0.8
    assert item_unit_cents(1520, "each", None, "kg", "Pork Rashers 350g - 800g") == 1900
    assert item_unit_cents(1520, "each", None, "kg", "Pork Rashers") is None   # never guessed
