#!/usr/bin/env python3
"""Tests for analyze.py. Run with: python3 -m unittest analyze_test -v

Not shipped to the ConfigMap (only analyze.py is referenced from the helm
template) — this is a dev-time/CI check that the script's logic is correct
before it goes anywhere near a live pod.
"""

from __future__ import annotations

import csv
import json
import subprocess
import sys
import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

import analyze


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    fieldnames = [
        "media_type",
        "workflow_id",
        "workflow_name",
        "callout_id",
        "callout_name",
        "message_id",
        "message_subject",
        "sent",
        "delivered",
        "opened",
        "clicked",
        "spam",
        "bounced",
        "unsubscribed",
        "orders",
        "reach",
        "delivery_rate",
        "open_rate",
        "ctr",
        "cvr",
        "revenue",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            full = {k: "" for k in fieldnames}
            full.update(row)
            writer.writerow(full)


def base_row(**overrides: str) -> dict[str, str]:
    row = {
        "media_type": "email",
        "workflow_id": "446206",
        "workflow_name": "user_birthday",
        "callout_id": "358267",
        "callout_name": "user_birthday_first_event",
        "message_id": "4500055",
        "message_subject": "Whose birthday is coming up soon?",
        "sent": "1000",
        "delivered": "990",
    }
    row.update(overrides)
    return row


class CsvSumTests(unittest.TestCase):
    def test_sums_column_with_no_filter(self) -> None:
        with TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "recent.csv"
            write_csv(csv_path, [base_row(delivered="10"), base_row(message_id="999", delivered="5")])
            self.assertEqual(analyze.csv_sum(csv_path, "delivered", {}), 15.0)

    def test_sums_column_filtered_by_message_id(self) -> None:
        with TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "recent.csv"
            write_csv(csv_path, [base_row(delivered="10"), base_row(message_id="999", delivered="5")])
            self.assertEqual(analyze.csv_sum(csv_path, "delivered", {"message_id": "999"}), 5.0)

    def test_filter_matching_nothing_sums_to_zero(self) -> None:
        with TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "recent.csv"
            write_csv(csv_path, [base_row(delivered="10")])
            self.assertEqual(analyze.csv_sum(csv_path, "delivered", {"message_id": "nope"}), 0.0)

    def test_unknown_column_raises(self) -> None:
        with TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "recent.csv"
            write_csv(csv_path, [base_row()])
            with self.assertRaises(ValueError):
                analyze.csv_sum(csv_path, "not_a_real_column", {})

    def test_missing_value_treated_as_zero(self) -> None:
        with TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "recent.csv"
            write_csv(csv_path, [base_row(delivered="")])
            self.assertEqual(analyze.csv_sum(csv_path, "delivered", {}), 0.0)


class DetectTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.config = dict(analyze.DEFAULT_CONFIG)
        self.today = date(2026, 9, 14)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_detect(self, baseline_rows, recent_rows_per_day, active_ids, config=None):
        baseline = self.dir / "baseline.csv"
        write_csv(baseline, baseline_rows)
        recent_paths = []
        for i, rows in enumerate(recent_rows_per_day):
            p = self.dir / f"recent-day{i}.csv"
            write_csv(p, rows)
            recent_paths.append(p)
        return analyze.detect(baseline, recent_paths, active_ids, config or self.config, self.today)

    def test_healthy_campaign_not_flagged(self) -> None:
        result = self.run_detect(
            [base_row(delivered=str(36 * 100))],  # 100/day baseline
            [[base_row(delivered="90")], [base_row(delivered="90")], [base_row(delivered="90")]],  # 90/day recent — well above 15% of baseline
            {446206},
        )
        self.assertEqual(result["candidates"], [])

    def test_flatlined_campaign_is_flagged(self) -> None:
        result = self.run_detect(
            [base_row(delivered=str(36 * 100))],
            [[base_row(delivered="0")], [base_row(delivered="0")], [base_row(delivered="0")]],
            {446206},
        )
        self.assertEqual(len(result["candidates"]), 1)
        c = result["candidates"][0]
        self.assertEqual(c["messageId"], "4500055")
        self.assertEqual(c["baselineDaily"], 100.0)
        self.assertEqual(c["recentDaily"], 0.0)
        self.assertEqual(c["dailyBreakdown"], [0.0, 0.0, 0.0])
        self.assertEqual(c["daysCollapsed"], 3)
        self.assertEqual(c["recentWindowDays"], 3)
        self.assertIsNone(c["cyclicalMatch"])

    def test_message_missing_entirely_from_recent_window_counts_as_zero(self) -> None:
        # This is the exact shape of a real flatline: the message simply
        # doesn't appear in the recent export at all, not a zero-valued row.
        result = self.run_detect(
            [base_row(delivered=str(36 * 100))],
            [[], [], []],
            {446206},
        )
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["recentDaily"], 0.0)

    def test_low_volume_campaign_is_skipped_not_flagged(self) -> None:
        # 36 days * 10/day = 360 total, baselineDaily = 10 < MIN_BASELINE_DAILY_DELIVERED (15)
        result = self.run_detect(
            [base_row(delivered="360")],
            [[base_row(delivered="0")], [base_row(delivered="0")], [base_row(delivered="0")]],
            {446206},
        )
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["skippedLowVolume"], ["4500055"])

    def test_inactive_workflow_never_flagged_even_if_flatlined(self) -> None:
        result = self.run_detect(
            [base_row(delivered=str(36 * 100))],
            [[base_row(delivered="0")], [base_row(delivered="0")], [base_row(delivered="0")]],
            set(),  # workflow 446206 not in the active set
        )
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["skippedLowVolume"], [])

    def test_borderline_exactly_at_threshold_is_flagged(self) -> None:
        # recent_daily == threshold * baseline_daily should still count (skill
        # says "<=", not "<"). All three days identical, so the average and
        # majority-of-days checks agree.
        baseline_daily = 100.0
        recent_daily = 0.15 * baseline_daily  # exactly at DROP_RATIO_THRESHOLD
        result = self.run_detect(
            [base_row(delivered=str(36 * baseline_daily))],
            [[base_row(delivered=str(recent_daily))]] * 3,
            {446206},
        )
        self.assertEqual(len(result["candidates"]), 1)

    def test_just_above_threshold_is_not_flagged(self) -> None:
        baseline_daily = 100.0
        recent_daily = 0.16 * baseline_daily
        result = self.run_detect(
            [base_row(delivered=str(36 * baseline_daily))],
            [[base_row(delivered=str(recent_daily))]] * 3,
            {446206},
        )
        self.assertEqual(result["candidates"], [])

    def test_duplicate_message_rows_in_baseline_are_aggregated(self) -> None:
        # Seen live: the same message_id can appear more than once in an export.
        result = self.run_detect(
            [base_row(delivered=str(36 * 60)), base_row(delivered=str(36 * 40))],
            [[base_row(delivered="0")], [base_row(delivered="0")], [base_row(delivered="0")]],
            {446206},
        )
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["baselineDaily"], 100.0)

    def test_multiple_recent_rows_for_same_message_on_the_same_day_are_summed(self) -> None:
        result = self.run_detect(
            [base_row(delivered=str(36 * 100))],
            [[base_row(delivered="1"), base_row(delivered="1")]],
            {446206},
        )
        self.assertEqual(result["candidates"][0]["recentDelivered"], 2.0)

    def test_single_bad_day_among_three_does_not_flag_a_healthy_average(self) -> None:
        # One noisy zero day out of three, but the average is nowhere near the
        # threshold and only 1 of 3 days individually collapsed (< majority of 2)
        # -- must not flag on the strength of that lone day alone.
        result = self.run_detect(
            [base_row(delivered=str(36 * 100))],  # baselineDaily = 100
            [[base_row(delivered="0")], [base_row(delivered="100")], [base_row(delivered="100")]],
            {446206},
        )
        self.assertEqual(result["candidates"], [])

    def test_majority_of_days_collapsed_flags_even_when_average_recovers(self) -> None:
        # The real order-5 shape confirmed live 2026-09-15: two full zero days
        # then one strong rebound day. The blended average (266.7/400 = 66.7%)
        # is comfortably above the 15% threshold and would be invisible to the
        # old single-number check -- but 2 of 3 days individually collapsed,
        # which is what must catch it.
        result = self.run_detect(
            [base_row(delivered=str(36 * 400))],  # baselineDaily = 400
            [[base_row(delivered="0")], [base_row(delivered="0")], [base_row(delivered="800")]],
            {446206},
        )
        self.assertEqual(len(result["candidates"]), 1)
        c = result["candidates"][0]
        self.assertEqual(c["daysCollapsed"], 2)
        self.assertEqual(c["dailyBreakdown"], [0.0, 0.0, 800.0])
        self.assertGreater(c["ratio"], 0.15)  # average alone would have looked healthy

    def test_known_cyclical_message_gets_a_verify_window_not_silent_suppression(self) -> None:
        config = dict(self.config)
        config["knownCyclicalMessages"] = {
            "4500055": {
                "workflowName": "user_birthday",
                "eventKey": "user_birthday_first_event",
                "periodDaysMax": 9,
                "confirmedBy": "test",
                "confirmedDate": "2026-09-01",
                "note": "test entry",
            }
        }
        result = self.run_detect(
            [base_row(delivered=str(36 * 100))],
            [[base_row(delivered="0")], [base_row(delivered="0")], [base_row(delivered="0")]],
            {446206},
            config=config,
        )
        self.assertEqual(len(result["candidates"]), 1)
        c = result["candidates"][0]
        # A known-cyclical match must still surface as a candidate (never silently
        # dropped) — the model still has to actively verify it, not just trust the label.
        self.assertIsNotNone(c["cyclicalMatch"])
        self.assertEqual(c["verifyWindow"], {"dateFrom": "2026-09-04", "dateTo": "2026-09-13", "days": 10})

    def test_candidates_sorted_worst_first_deterministically(self) -> None:
        result = self.run_detect(
            [
                base_row(message_id="AAA", delivered=str(36 * 100)),
                base_row(message_id="BBB", delivered=str(36 * 200)),
            ],
            [
                [base_row(message_id="AAA", delivered="10"), base_row(message_id="BBB", delivered="1")],
                [base_row(message_id="AAA", delivered="10"), base_row(message_id="BBB", delivered="1")],
                [base_row(message_id="AAA", delivered="10"), base_row(message_id="BBB", delivered="1")],
            ],
            {446206},
        )
        ids = [c["messageId"] for c in result["candidates"]]
        self.assertEqual(ids, ["BBB", "AAA"])  # worst (lowest ratio) first


class VerifyCyclicalTests(unittest.TestCase):
    def test_any_delivery_in_extended_window_suppresses(self) -> None:
        self.assertEqual(analyze.verify_cyclical(1.0)["verdict"], "suppressed_cyclical")

    def test_hard_zero_over_extended_window_escalates(self) -> None:
        self.assertEqual(analyze.verify_cyclical(0.0)["verdict"], "escalate_cyclical_deviation")


class NarrowDropDateTests(unittest.TestCase):
    def test_finds_first_collapsed_window_walking_forward(self) -> None:
        windows = [
            {"dateFrom": "2026-08-04", "dateTo": "2026-08-10", "delivered": "700"},  # daily 100, healthy
            {"dateFrom": "2026-08-11", "dateTo": "2026-08-17", "delivered": "0"},  # daily 0, collapsed
            {"dateFrom": "2026-08-18", "dateTo": "2026-08-24", "delivered": "0"},
        ]
        result = analyze.narrow_drop_date(windows, baseline_daily=100.0, drop_ratio_threshold=0.15)
        self.assertEqual(result["dropDate"], "2026-08-11")
        self.assertFalse(result["dropBeforeEarliestWindow"])

    def test_unordered_input_is_sorted_before_walking(self) -> None:
        windows = [
            {"dateFrom": "2026-08-18", "dateTo": "2026-08-24", "delivered": "0"},
            {"dateFrom": "2026-08-04", "dateTo": "2026-08-10", "delivered": "700"},
            {"dateFrom": "2026-08-11", "dateTo": "2026-08-17", "delivered": "0"},
        ]
        result = analyze.narrow_drop_date(windows, baseline_daily=100.0, drop_ratio_threshold=0.15)
        self.assertEqual(result["dropDate"], "2026-08-11")

    def test_drop_before_earliest_window_is_flagged_for_a_wider_search(self) -> None:
        windows = [{"dateFrom": "2026-08-11", "dateTo": "2026-08-17", "delivered": "0"}]
        result = analyze.narrow_drop_date(windows, baseline_daily=100.0, drop_ratio_threshold=0.15)
        self.assertEqual(result["dropDate"], "2026-08-11")
        self.assertTrue(result["dropBeforeEarliestWindow"])

    def test_no_collapse_anywhere_returns_none(self) -> None:
        windows = [{"dateFrom": "2026-08-11", "dateTo": "2026-08-17", "delivered": "700"}]
        result = analyze.narrow_drop_date(windows, baseline_daily=100.0, drop_ratio_threshold=0.15)
        self.assertIsNone(result["dropDate"])

    def test_recovery_after_collapse_does_not_re_trigger(self) -> None:
        # Only the FIRST transition into collapse matters, not a later window
        # that happens to also be low after a partial recovery in between.
        windows = [
            {"dateFrom": "2026-08-01", "dateTo": "2026-08-07", "delivered": "700"},
            {"dateFrom": "2026-08-08", "dateTo": "2026-08-14", "delivered": "0"},
            {"dateFrom": "2026-08-15", "dateTo": "2026-08-21", "delivered": "700"},
            {"dateFrom": "2026-08-22", "dateTo": "2026-08-28", "delivered": "0"},
        ]
        result = analyze.narrow_drop_date(windows, baseline_daily=100.0, drop_ratio_threshold=0.15)
        self.assertEqual(result["dropDate"], "2026-08-08")


class ReconcileTests(unittest.TestCase):
    def test_new_candidate_becomes_new_anomaly(self) -> None:
        result = analyze.reconcile(
            previous_active_alerts={},
            confirmed=[{"messageId": "4500055", "workflowName": "user_birthday"}],
            today=date(2026, 9, 14),
        )
        self.assertEqual(result["activeAlerts"]["4500055"]["firstDetected"], "2026-09-14")
        self.assertEqual(result["events"], [{"date": "2026-09-14", "type": "new_anomaly", "messageId": "4500055", "workflowName": "user_birthday"}])

    def test_still_active_keeps_original_first_detected(self) -> None:
        result = analyze.reconcile(
            previous_active_alerts={"4500055": {"firstDetected": "2026-09-07", "workflowName": "user_birthday"}},
            confirmed=[{"messageId": "4500055", "workflowName": "user_birthday"}],
            today=date(2026, 9, 14),
        )
        self.assertEqual(result["activeAlerts"]["4500055"]["firstDetected"], "2026-09-07")
        self.assertEqual(result["events"][0]["type"], "still_active")

    def test_alert_not_reconfirmed_this_run_is_recovered(self) -> None:
        result = analyze.reconcile(
            previous_active_alerts={"4500055": {"firstDetected": "2026-09-07", "workflowName": "user_birthday"}},
            confirmed=[],
            today=date(2026, 9, 14),
        )
        self.assertEqual(result["activeAlerts"], {})
        self.assertEqual(result["events"], [{"date": "2026-09-14", "type": "recovered", "messageId": "4500055", "workflowName": "user_birthday"}])

    def test_mixed_run_produces_all_three_event_types(self) -> None:
        result = analyze.reconcile(
            previous_active_alerts={
                "still-here": {"firstDetected": "2026-09-01", "workflowName": "A"},
                "gone-now": {"firstDetected": "2026-09-01", "workflowName": "B"},
            },
            confirmed=[
                {"messageId": "still-here", "workflowName": "A"},
                {"messageId": "brand-new", "workflowName": "C"},
            ],
            today=date(2026, 9, 14),
        )
        types = {e["messageId"]: e["type"] for e in result["events"]}
        self.assertEqual(types, {"still-here": "still_active", "brand-new": "new_anomaly", "gone-now": "recovered"})


class HistoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_append_creates_month_file(self) -> None:
        path = analyze.history_append(self.dir, "acc", {"type": "new_anomaly"}, date(2026, 9, 14))
        self.assertEqual(path.name, "esputnik-monitor-history-acc-2026-09.json")
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data, [{"type": "new_anomaly", "date": "2026-09-14"}])

    def test_append_twice_appends_not_overwrites(self) -> None:
        analyze.history_append(self.dir, "acc", {"type": "new_anomaly"}, date(2026, 9, 14))
        analyze.history_append(self.dir, "acc", {"type": "recovered"}, date(2026, 9, 15))
        path = self.dir / "esputnik-monitor-history-acc-2026-09.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(len(data), 2)

    def test_different_months_go_to_different_files(self) -> None:
        analyze.history_append(self.dir, "acc", {"type": "a"}, date(2026, 8, 31))
        analyze.history_append(self.dir, "acc", {"type": "b"}, date(2026, 9, 1))
        self.assertTrue((self.dir / "esputnik-monitor-history-acc-2026-08.json").exists())
        self.assertTrue((self.dir / "esputnik-monitor-history-acc-2026-09.json").exists())

    def test_read_only_touches_months_in_range(self) -> None:
        analyze.history_append(self.dir, "acc", {"type": "too-old"}, date(2026, 6, 1))
        analyze.history_append(self.dir, "acc", {"type": "in-range"}, date(2026, 9, 5))
        entries = analyze.history_read(self.dir, "acc", since=date(2026, 9, 1), until=date(2026, 9, 30))
        self.assertEqual([e["type"] for e in entries], ["in-range"])

    def test_read_with_no_history_files_returns_empty_not_error(self) -> None:
        entries = analyze.history_read(self.dir, "acc", since=date(2026, 9, 1), until=date(2026, 9, 30))
        self.assertEqual(entries, [])

    def test_read_across_a_month_boundary(self) -> None:
        analyze.history_append(self.dir, "acc", {"type": "aug"}, date(2026, 8, 30))
        analyze.history_append(self.dir, "acc", {"type": "sep"}, date(2026, 9, 2))
        entries = analyze.history_read(self.dir, "acc", since=date(2026, 8, 25), until=date(2026, 9, 5))
        self.assertEqual([e["type"] for e in entries], ["aug", "sep"])

    def test_read_results_sorted_chronologically_regardless_of_append_order(self) -> None:
        analyze.history_append(self.dir, "acc", {"type": "second"}, date(2026, 9, 10))
        analyze.history_append(self.dir, "acc", {"type": "first"}, date(2026, 9, 2))
        entries = analyze.history_read(self.dir, "acc", since=date(2026, 9, 1), until=date(2026, 9, 30))
        self.assertEqual([e["type"] for e in entries], ["first", "second"])

    def test_two_accounts_never_share_a_history_file(self) -> None:
        analyze.history_append(self.dir, "acc-a", {"type": "a"}, date(2026, 9, 1))
        analyze.history_append(self.dir, "acc-b", {"type": "b"}, date(2026, 9, 1))
        a_entries = analyze.history_read(self.dir, "acc-a", since=date(2026, 9, 1), until=date(2026, 9, 30))
        b_entries = analyze.history_read(self.dir, "acc-b", since=date(2026, 9, 1), until=date(2026, 9, 30))
        self.assertEqual([e["type"] for e in a_entries], ["a"])
        self.assertEqual([e["type"] for e in b_entries], ["b"])


class DailyVolumeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def append_day(self, account: str, entry_date: date, rows: list[dict[str, str]]) -> Path:
        csv_path = self.dir / f"day-{account}-{entry_date.isoformat()}.csv"
        write_csv(csv_path, rows)
        return analyze.daily_append(self.dir, account, csv_path, entry_date)

    def test_append_creates_month_file_keyed_by_date(self) -> None:
        path = self.append_day("acc", date(2026, 9, 14), [base_row(delivered="20")])
        self.assertEqual(path.name, "esputnik-monitor-daily-acc-2026-09.json")
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data, {"2026-09-14": {"4500055": 20.0}})

    def test_duplicate_rows_for_same_message_are_summed(self) -> None:
        path = self.append_day("acc", date(2026, 9, 14), [base_row(delivered="20"), base_row(delivered="5")])
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["2026-09-14"]["4500055"], 25.0)

    def test_re_appending_same_date_replaces_not_accumulates(self) -> None:
        # A retried daily check re-fetching the same day must overwrite, not double-count.
        self.append_day("acc", date(2026, 9, 14), [base_row(delivered="20")])
        path = self.append_day("acc", date(2026, 9, 14), [base_row(delivered="99")])
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["2026-09-14"]["4500055"], 99.0)

    def test_different_dates_coexist_in_the_same_month_file(self) -> None:
        self.append_day("acc", date(2026, 9, 13), [base_row(delivered="10")])
        path = self.append_day("acc", date(2026, 9, 14), [base_row(delivered="20")])
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(set(data.keys()), {"2026-09-13", "2026-09-14"})

    def test_dates_spanning_a_month_boundary_land_in_their_own_files(self) -> None:
        self.append_day("acc", date(2026, 8, 31), [base_row(delivered="10")])
        self.append_day("acc", date(2026, 9, 1), [base_row(delivered="20")])
        self.assertTrue((self.dir / "esputnik-monitor-daily-acc-2026-08.json").exists())
        self.assertTrue((self.dir / "esputnik-monitor-daily-acc-2026-09.json").exists())

    def test_two_accounts_never_share_a_daily_file(self) -> None:
        self.append_day("acc-a", date(2026, 9, 14), [base_row(delivered="10")])
        self.append_day("acc-b", date(2026, 9, 14), [base_row(delivered="99")])
        a = analyze.daily_series(self.dir, "acc-a", "4500055", until=date(2026, 9, 14), days=5)
        b = analyze.daily_series(self.dir, "acc-b", "4500055", until=date(2026, 9, 14), days=5)
        self.assertEqual([p["delivered"] for p in a["series"]], [10.0])
        self.assertEqual([p["delivered"] for p in b["series"]], [99.0])

    def test_series_returns_compact_date_delivered_pairs_sorted_chronologically(self) -> None:
        self.append_day("acc", date(2026, 9, 14), [base_row(delivered="30")])
        self.append_day("acc", date(2026, 9, 12), [base_row(delivered="10")])
        result = analyze.daily_series(self.dir, "acc", "4500055", until=date(2026, 9, 14), days=21)
        self.assertEqual(
            result["series"],
            [
                {"date": "2026-09-12", "delivered": 10.0},
                {"date": "2026-09-14", "delivered": 30.0},
            ],
        )

    def test_series_only_covers_the_requested_window(self) -> None:
        self.append_day("acc", date(2026, 8, 1), [base_row(delivered="999")])  # outside a 5-day window
        self.append_day("acc", date(2026, 9, 14), [base_row(delivered="30")])
        result = analyze.daily_series(self.dir, "acc", "4500055", until=date(2026, 9, 14), days=5)
        self.assertEqual(result["since"], "2026-09-10")
        self.assertEqual(len(result["series"]), 1)

    def test_missing_day_is_absent_from_the_series_not_zero(self) -> None:
        # Pod was down 2026-09-12 -- daily-append never ran that day. It must be
        # absent from the series entirely, not silently shown as a 0 that would
        # misread as part of a real cyclical gap.
        self.append_day("acc", date(2026, 9, 11), [base_row(delivered="40")])
        self.append_day("acc", date(2026, 9, 13), [base_row(delivered="40")])
        result = analyze.daily_series(self.dir, "acc", "4500055", until=date(2026, 9, 13), days=5)
        dates = [p["date"] for p in result["series"]]
        self.assertEqual(dates, ["2026-09-11", "2026-09-13"])

    def test_message_absent_from_a_present_day_counts_as_zero(self) -> None:
        # The day itself WAS checked (an entry exists) but this specific message
        # sent nothing -- eSputnik's own export omits zero-volume rows, so
        # absence-within-a-present-day is a real zero, not missing data.
        self.append_day("acc", date(2026, 9, 14), [base_row(message_id="other-message", delivered="40")])
        result = analyze.daily_series(self.dir, "acc", "4500055", until=date(2026, 9, 14), days=5)
        self.assertEqual(result["series"], [{"date": "2026-09-14", "delivered": 0.0}])

    def test_series_rejects_a_window_wider_than_the_cap(self) -> None:
        with self.assertRaises(ValueError):
            analyze.daily_series(self.dir, "acc", "4500055", until=date(2026, 9, 14), days=analyze.MAX_DAILY_SERIES_DAYS + 1)

    def test_series_accepts_exactly_the_cap(self) -> None:
        result = analyze.daily_series(self.dir, "acc", "4500055", until=date(2026, 9, 14), days=analyze.MAX_DAILY_SERIES_DAYS)
        self.assertEqual(result["series"], [])  # no data yet, but no error


class MigrateLegacyStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.state_path = self.dir / "esputnik-monitor-state-ksisters_spzo.json"
        self.history_dir = self.dir / "history"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write_state(self, state: dict) -> None:
        self.state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")

    def test_migrates_real_production_weeklog_shape(self) -> None:
        # This is tania's actual esputnik-monitor-state-ksisters_spzo.json weekLog
        # as of 2026-09-14, pulled live off her pod — real shape, real entries,
        # including the false_positive_dismissed note for the "order 5" cyclical
        # false positive this whole rewrite was motivated by.
        self.write_state(
            {
                "activeAlerts": {
                    "4516390": {"firstDetected": "2026-09-12", "workflowName": "user_birthday"},
                    "3357808": {"firstDetected": "2026-09-14", "workflowName": "notify_me_in_stock_reminded - лист №5"},
                },
                "weekLog": [
                    {
                        "type": "new_anomaly",
                        "messageId": 3351537,
                        "workflowName": "Уведомление о наличии (1 notify sku in stock)",
                        "date": "2026-09-13",
                    },
                    {
                        "type": "new_anomaly",
                        "messageId": 3350250,
                        "workflowName": "заказ Доставляется (order 5)",
                        "date": "2026-09-14",
                    },
                    {
                        "type": "false_positive_dismissed",
                        "messageId": 3350250,
                        "workflowName": "заказ Доставляется (order 5)",
                        "date": "2026-09-14",
                        "note": (
                            "BY_EVENT trigger but orderIS_DELIVERED has a strong natural weekly cycle "
                            "(troughs near-zero every ~7-9 days, confirmed by person via monthly chart) "
                            "-- not a real break, dismissed on person confirmation"
                        ),
                    },
                ],
            }
        )

        result = analyze.migrate_legacy_state(self.state_path, self.history_dir, "ksisters_spzo")

        self.assertEqual(result["migratedEntries"], 3)
        self.assertEqual(result["activeAlerts"], {
            "4516390": {"firstDetected": "2026-09-12", "workflowName": "user_birthday"},
            "3357808": {"firstDetected": "2026-09-14", "workflowName": "notify_me_in_stock_reminded - лист №5"},
        })

        # activeAlerts is untouched, weekLog is gone entirely from the on-disk file.
        on_disk = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertNotIn("weekLog", on_disk)
        self.assertEqual(on_disk["activeAlerts"], result["activeAlerts"])

        # All three entries landed in the September history file, in their original
        # order, with the false-positive note preserved verbatim (nothing summarized
        # away — this note is exactly the kind of context the rewrite exists to keep).
        history = analyze.history_read(self.history_dir, "ksisters_spzo", since=date(2026, 9, 1), until=date(2026, 9, 30))
        self.assertEqual(len(history), 3)
        self.assertEqual(history[-1]["note"], (
            "BY_EVENT trigger but orderIS_DELIVERED has a strong natural weekly cycle "
            "(troughs near-zero every ~7-9 days, confirmed by person via monthly chart) "
            "-- not a real break, dismissed on person confirmation"
        ))

    def test_entries_spanning_a_month_boundary_land_in_their_own_month_files(self) -> None:
        self.write_state(
            {
                "activeAlerts": {},
                "weekLog": [
                    {"type": "new_anomaly", "messageId": "a", "date": "2026-08-30"},
                    {"type": "recovered", "messageId": "a", "date": "2026-09-02"},
                ],
            }
        )
        analyze.migrate_legacy_state(self.state_path, self.history_dir, "acc")
        self.assertTrue((self.history_dir / "esputnik-monitor-history-acc-2026-08.json").exists())
        self.assertTrue((self.history_dir / "esputnik-monitor-history-acc-2026-09.json").exists())

    def test_idempotent_on_an_already_migrated_state_file(self) -> None:
        self.write_state({"activeAlerts": {"x": {"firstDetected": "2026-09-01"}}})
        result = analyze.migrate_legacy_state(self.state_path, self.history_dir, "acc")
        self.assertEqual(result["migratedEntries"], 0)
        self.assertEqual(result["activeAlerts"], {"x": {"firstDetected": "2026-09-01"}})

    def test_empty_weeklog_migrates_cleanly_with_zero_entries(self) -> None:
        self.write_state({"activeAlerts": {}, "weekLog": []})
        result = analyze.migrate_legacy_state(self.state_path, self.history_dir, "acc")
        self.assertEqual(result["migratedEntries"], 0)
        self.assertFalse(self.history_dir.exists() and any(self.history_dir.iterdir()))

    def test_missing_state_file_returns_empty_without_raising(self) -> None:
        result = analyze.migrate_legacy_state(self.dir / "does-not-exist.json", self.history_dir, "acc")
        self.assertEqual(result, {"activeAlerts": {}, "migratedEntries": 0})

    def test_running_twice_does_not_duplicate_history_entries(self) -> None:
        self.write_state({"activeAlerts": {}, "weekLog": [{"type": "new_anomaly", "messageId": "a", "date": "2026-09-05"}]})
        analyze.migrate_legacy_state(self.state_path, self.history_dir, "acc")
        analyze.migrate_legacy_state(self.state_path, self.history_dir, "acc")  # weekLog is already gone now
        history = analyze.history_read(self.history_dir, "acc", since=date(2026, 9, 1), until=date(2026, 9, 30))
        self.assertEqual(len(history), 1)


class ConfigTests(unittest.TestCase):
    def test_ensure_config_creates_defaults_when_missing(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            cfg = analyze.ensure_config(path)
            self.assertTrue(path.exists())
            self.assertEqual(cfg["dropRatioThreshold"], 0.15)

    def test_ensure_config_never_overwrites_existing_tuning(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps({**analyze.DEFAULT_CONFIG, "dropRatioThreshold": 0.5}), encoding="utf-8")
            cfg = analyze.ensure_config(path)
            self.assertEqual(cfg["dropRatioThreshold"], 0.5)

    def test_load_config_merges_partial_overrides_with_defaults(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps({"dropRatioThreshold": 0.2}), encoding="utf-8")
            cfg = analyze.load_config(path)
            self.assertEqual(cfg["dropRatioThreshold"], 0.2)
            self.assertEqual(cfg["baselineWindowDays"], 36)  # untouched default survives


class CliEndToEndTests(unittest.TestCase):
    """A handful of real subprocess invocations so the argparse wiring itself
    (not just the pure functions) is verified end to end."""

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.script = Path(__file__).resolve().parent / "analyze.py"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_cli(self, *args: str) -> dict:
        result = subprocess.run(
            [sys.executable, str(self.script), *args],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)

    def test_ensure_config_via_cli(self) -> None:
        config_path = self.dir / "config.json"
        out = self.run_cli("ensure-config", "--config", str(config_path))
        self.assertEqual(out["dropRatioThreshold"], 0.15)
        self.assertTrue(config_path.exists())

    def test_detect_via_cli_end_to_end(self) -> None:
        baseline = self.dir / "baseline.csv"
        recent = self.dir / "recent.csv"
        workflows = self.dir / "workflows.json"
        config = self.dir / "config.json"
        write_csv(baseline, [base_row(delivered=str(36 * 100))])
        write_csv(recent, [base_row(delivered="0")])
        workflows.write_text(json.dumps({"data": [{"id": 446206, "name": "user_birthday", "status": "active"}]}))
        config.write_text(json.dumps(analyze.DEFAULT_CONFIG))

        out = self.run_cli(
            "detect",
            "--baseline",
            str(baseline),
            "--recent",
            str(recent),
            "--active-workflows",
            str(workflows),
            "--config",
            str(config),
            "--today",
            "2026-09-14",
        )
        self.assertEqual(len(out["candidates"]), 1)
        self.assertEqual(out["candidates"][0]["messageId"], "4500055")

    def test_detect_via_cli_with_multiple_daily_recent_csvs(self) -> None:
        baseline = self.dir / "baseline.csv"
        recent1 = self.dir / "recent1.csv"
        recent2 = self.dir / "recent2.csv"
        recent3 = self.dir / "recent3.csv"
        workflows = self.dir / "workflows.json"
        config = self.dir / "config.json"
        write_csv(baseline, [base_row(delivered=str(36 * 100))])
        write_csv(recent1, [base_row(delivered="0")])
        write_csv(recent2, [base_row(delivered="0")])
        write_csv(recent3, [base_row(delivered="0")])
        workflows.write_text(json.dumps({"data": [{"id": 446206, "name": "user_birthday", "status": "active"}]}))
        config.write_text(json.dumps(analyze.DEFAULT_CONFIG))

        out = self.run_cli(
            "detect",
            "--baseline",
            str(baseline),
            "--recent",
            str(recent1),
            str(recent2),
            str(recent3),
            "--active-workflows",
            str(workflows),
            "--config",
            str(config),
            "--today",
            "2026-09-14",
        )
        self.assertEqual(len(out["candidates"]), 1)
        self.assertEqual(out["candidates"][0]["recentWindowDays"], 3)
        self.assertEqual(out["candidates"][0]["daysCollapsed"], 3)

    def test_daily_append_then_series_via_cli(self) -> None:
        history_dir = self.dir / "history"
        day1 = self.dir / "day1.csv"
        day2 = self.dir / "day2.csv"
        write_csv(day1, [base_row(delivered="20")])
        write_csv(day2, [base_row(delivered="30")])
        self.run_cli(
            "daily-append", "--history-dir", str(history_dir), "--account", "acc",
            "--csv", str(day1), "--date", "2026-09-13",
        )
        self.run_cli(
            "daily-append", "--history-dir", str(history_dir), "--account", "acc",
            "--csv", str(day2), "--date", "2026-09-14",
        )
        series = self.run_cli(
            "daily-series", "--history-dir", str(history_dir), "--account", "acc",
            "--message-id", "4500055", "--until", "2026-09-14", "--days", "21",
        )
        self.assertEqual(
            series["series"],
            [
                {"date": "2026-09-13", "delivered": 20.0},
                {"date": "2026-09-14", "delivered": 30.0},
            ],
        )

    def test_narrow_drop_date_via_cli(self) -> None:
        windows_path = self.dir / "windows.json"
        windows_path.write_text(
            json.dumps(
                [
                    {"dateFrom": "2026-08-04", "dateTo": "2026-08-10", "delivered": "700"},
                    {"dateFrom": "2026-08-11", "dateTo": "2026-08-17", "delivered": "0"},
                ]
            )
        )
        out = self.run_cli(
            "narrow-drop-date",
            "--windows",
            str(windows_path),
            "--baseline-daily",
            "100",
            "--drop-ratio-threshold",
            "0.15",
        )
        self.assertEqual(out["dropDate"], "2026-08-11")

    def test_history_append_then_read_via_cli(self) -> None:
        history_dir = self.dir / "history"
        self.run_cli(
            "history-append",
            "--history-dir",
            str(history_dir),
            "--account",
            "ksisters_sro",
            "--entry",
            json.dumps({"type": "new_anomaly", "messageId": "4500055"}),
            "--today",
            "2026-09-14",
        )
        out = self.run_cli(
            "history-read",
            "--history-dir",
            str(history_dir),
            "--account",
            "ksisters_sro",
            "--since",
            "2026-09-01",
            "--until",
            "2026-09-30",
        )
        self.assertEqual(len(out["entries"]), 1)
        self.assertEqual(out["entries"][0]["messageId"], "4500055")

    def test_migrate_legacy_state_via_cli(self) -> None:
        state_path = self.dir / "esputnik-monitor-state-acc.json"
        state_path.write_text(
            json.dumps(
                {
                    "activeAlerts": {"x": {"firstDetected": "2026-09-01"}},
                    "weekLog": [{"type": "new_anomaly", "messageId": "x", "date": "2026-09-05"}],
                }
            )
        )
        history_dir = self.dir / "history"
        out = self.run_cli(
            "migrate-legacy-state",
            "--state",
            str(state_path),
            "--history-dir",
            str(history_dir),
            "--account",
            "acc",
        )
        self.assertEqual(out["migratedEntries"], 1)
        on_disk = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertNotIn("weekLog", on_disk)


if __name__ == "__main__":
    unittest.main()
