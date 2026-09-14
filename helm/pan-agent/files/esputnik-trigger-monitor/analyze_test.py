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

    def run_detect(self, baseline_rows, recent_rows, active_ids, config=None):
        baseline = self.dir / "baseline.csv"
        recent = self.dir / "recent.csv"
        write_csv(baseline, baseline_rows)
        write_csv(recent, recent_rows)
        return analyze.detect(baseline, recent, active_ids, config or self.config, self.today)

    def test_healthy_campaign_not_flagged(self) -> None:
        result = self.run_detect(
            [base_row(delivered=str(36 * 100))],  # 100/day baseline
            [base_row(delivered=str(3 * 90))],  # 90/day recent — well above 15% of baseline
            {446206},
        )
        self.assertEqual(result["candidates"], [])

    def test_flatlined_campaign_is_flagged(self) -> None:
        result = self.run_detect(
            [base_row(delivered=str(36 * 100))],
            [base_row(delivered="0")],
            {446206},
        )
        self.assertEqual(len(result["candidates"]), 1)
        c = result["candidates"][0]
        self.assertEqual(c["messageId"], "4500055")
        self.assertEqual(c["baselineDaily"], 100.0)
        self.assertEqual(c["recentDaily"], 0.0)
        self.assertIsNone(c["cyclicalMatch"])

    def test_message_missing_entirely_from_recent_window_counts_as_zero(self) -> None:
        # This is the exact shape of a real flatline: the message simply
        # doesn't appear in the recent export at all, not a zero-valued row.
        result = self.run_detect(
            [base_row(delivered=str(36 * 100))],
            [],
            {446206},
        )
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["recentDaily"], 0.0)

    def test_low_volume_campaign_is_skipped_not_flagged(self) -> None:
        # 36 days * 10/day = 360 total, baselineDaily = 10 < MIN_BASELINE_DAILY_DELIVERED (15)
        result = self.run_detect(
            [base_row(delivered="360")],
            [base_row(delivered="0")],
            {446206},
        )
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["skippedLowVolume"], ["4500055"])

    def test_inactive_workflow_never_flagged_even_if_flatlined(self) -> None:
        result = self.run_detect(
            [base_row(delivered=str(36 * 100))],
            [base_row(delivered="0")],
            set(),  # workflow 446206 not in the active set
        )
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["skippedLowVolume"], [])

    def test_borderline_exactly_at_threshold_is_flagged(self) -> None:
        # recent_daily == threshold * baseline_daily should still count (skill
        # says "<=", not "<").
        baseline_daily = 100.0
        recent_daily = 0.15 * baseline_daily  # exactly at DROP_RATIO_THRESHOLD
        result = self.run_detect(
            [base_row(delivered=str(36 * baseline_daily))],
            [base_row(delivered=str(3 * recent_daily))],
            {446206},
        )
        self.assertEqual(len(result["candidates"]), 1)

    def test_just_above_threshold_is_not_flagged(self) -> None:
        baseline_daily = 100.0
        recent_daily = 0.16 * baseline_daily
        result = self.run_detect(
            [base_row(delivered=str(36 * baseline_daily))],
            [base_row(delivered=str(3 * recent_daily))],
            {446206},
        )
        self.assertEqual(result["candidates"], [])

    def test_duplicate_message_rows_in_baseline_are_aggregated(self) -> None:
        # Seen live: the same message_id can appear more than once in an export.
        result = self.run_detect(
            [base_row(delivered=str(36 * 60)), base_row(delivered=str(36 * 40))],
            [base_row(delivered="0")],
            {446206},
        )
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["baselineDaily"], 100.0)

    def test_multiple_recent_rows_for_same_message_are_summed(self) -> None:
        result = self.run_detect(
            [base_row(delivered=str(36 * 100))],
            [base_row(delivered="1"), base_row(delivered="1")],
            {446206},
        )
        self.assertEqual(result["candidates"][0]["recentDelivered"], 2.0)

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
            [base_row(delivered="0")],
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
                base_row(message_id="AAA", delivered=str(3 * 10)),  # ratio 0.10
                base_row(message_id="BBB", delivered=str(3 * 1)),  # ratio 0.005
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
