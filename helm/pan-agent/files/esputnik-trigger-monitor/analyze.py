#!/usr/bin/env python3
"""Deterministic helpers for the esputnik-trigger-monitor skill.

Every subcommand below replaces a step the model used to do freehand (parse a
CSV inline, eyeball a ratio, decide by feel whether a "known cyclical" message
has really recovered). The goal is that two runs of the same daily check
against the same eSputnik data always produce the same verdict, regardless of
which person's pod ran it or how carefully the model felt like working that
day. Nothing here calls eSputnik itself — the model still makes every MCP
tool call and saves the results to files; this script only ever reads files
already on disk and writes files back (config, state, history) or prints JSON
to stdout.

Stdlib only — no pip install available/expected on the runner image.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

DEFAULT_CONFIG: dict[str, Any] = {
    "baselineWindowDays": 36,
    "recentWindowDays": 3,
    "minBaselineDailyDelivered": 15,
    "dropRatioThreshold": 0.15,
    # keyed by message_id (string) -> {workflowName, eventKey, periodDaysMax,
    # confirmedBy, confirmedDate, note}
    "knownCyclicalMessages": {},
}


def _parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def _fmt_date(d: date) -> str:
    return d.strftime("%Y-%m-%d")


# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------


def load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return dict(DEFAULT_CONFIG)
    raw = json.loads(path.read_text(encoding="utf-8"))
    merged = dict(DEFAULT_CONFIG)
    merged.update(raw)
    return merged


def ensure_config(path: Path) -> dict[str, Any]:
    """Creates the per-account config file with defaults if it doesn't exist yet. Never
    overwrites an existing one — this is the file a person's own tuning/knowledge-base
    entries live in permanently, unlike SKILL.md, which is reinstalled from the shared
    ConfigMap on every pod restart."""
    if path.exists():
        return load_config(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return dict(DEFAULT_CONFIG)


# --------------------------------------------------------------------------
# csv-sum
# --------------------------------------------------------------------------


def csv_sum(csv_path: Path, column: str, filters: dict[str, str]) -> float:
    """Sums `column` across every row matching every key/value in `filters` (e.g.
    {"message_id": "4500055"}). Replaces the ad hoc "load csv, sum a column" python
    that used to get rewritten inline every single day."""
    total = 0.0
    with csv_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if column not in (reader.fieldnames or []):
            raise ValueError(f"column {column!r} not found in {csv_path} (columns: {reader.fieldnames})")
        for filt_col in filters:
            if filt_col not in (reader.fieldnames or []):
                raise ValueError(f"filter column {filt_col!r} not found in {csv_path}")
        for row in reader:
            if all(row.get(k) == v for k, v in filters.items()):
                total += float(row[column] or 0)
    return total


# --------------------------------------------------------------------------
# detect
# --------------------------------------------------------------------------


def _read_rows(csv_path: Path) -> list[dict[str, str]]:
    with csv_path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def detect(
    baseline_csv: Path,
    recent_csv: Path,
    active_workflow_ids: set[int],
    config: dict[str, Any],
    today: date,
) -> dict[str, Any]:
    baseline_rows = _read_rows(baseline_csv)
    recent_by_message: dict[str, float] = {}
    for row in _read_rows(recent_csv):
        mid = row["message_id"]
        recent_by_message[mid] = recent_by_message.get(mid, 0.0) + float(row["delivered"] or 0)

    baseline_window_days = config["baselineWindowDays"]
    recent_window_days = config["recentWindowDays"]
    min_baseline_daily = config["minBaselineDailyDelivered"]
    drop_ratio_threshold = config["dropRatioThreshold"]
    known_cyclical: dict[str, Any] = config.get("knownCyclicalMessages", {})

    # A message can legitimately appear more than once in the baseline export
    # (seen live: pagination/report quirks) — aggregate by message_id rather
    # than assuming one row each, same principle as recent_by_message above.
    baseline_by_message: dict[str, dict[str, Any]] = {}
    for row in baseline_rows:
        mid = row["message_id"]
        try:
            workflow_id = int(row["workflow_id"])
        except (KeyError, ValueError):
            continue
        if workflow_id not in active_workflow_ids:
            continue
        entry = baseline_by_message.setdefault(
            mid,
            {
                "workflowId": workflow_id,
                "workflowName": row.get("workflow_name", ""),
                "subject": row.get("message_subject", ""),
                "delivered": 0.0,
            },
        )
        entry["delivered"] += float(row["delivered"] or 0)

    candidates: list[dict[str, Any]] = []
    skipped_low_volume: list[str] = []

    for mid, info in baseline_by_message.items():
        baseline_delivered = info["delivered"]
        baseline_daily = baseline_delivered / baseline_window_days
        if baseline_daily < min_baseline_daily:
            skipped_low_volume.append(mid)
            continue

        recent_delivered = recent_by_message.get(mid, 0.0)
        recent_daily = recent_delivered / recent_window_days
        ratio = (recent_daily / baseline_daily) if baseline_daily > 0 else 0.0

        if recent_daily > drop_ratio_threshold * baseline_daily:
            continue  # healthy, not a candidate

        candidate: dict[str, Any] = {
            "messageId": mid,
            "workflowId": info["workflowId"],
            "workflowName": info["workflowName"],
            "subject": info["subject"],
            "baselineDelivered": round(baseline_delivered, 2),
            "recentDelivered": round(recent_delivered, 2),
            "baselineDaily": round(baseline_daily, 2),
            "recentDaily": round(recent_daily, 2),
            "ratio": round(ratio, 4),
        }

        cyclical_entry = known_cyclical.get(mid)
        if cyclical_entry:
            period_days_max = int(cyclical_entry["periodDaysMax"])
            verify_days = period_days_max + 1
            verify_date_to = today - timedelta(days=1)
            verify_date_from = verify_date_to - timedelta(days=verify_days - 1)
            candidate["cyclicalMatch"] = cyclical_entry
            candidate["verifyWindow"] = {
                "dateFrom": _fmt_date(verify_date_from),
                "dateTo": _fmt_date(verify_date_to),
                "days": verify_days,
            }
        else:
            candidate["cyclicalMatch"] = None
            candidate["verifyWindow"] = None

        candidates.append(candidate)

    # Worst drops first (lowest ratio = biggest collapse), stable tie-break by
    # messageId so output is byte-identical for identical input, not dependent
    # on dict iteration order.
    candidates.sort(key=lambda c: (c["ratio"], c["messageId"]))
    skipped_low_volume.sort()

    return {
        "today": _fmt_date(today),
        "candidates": candidates,
        "skippedLowVolume": skipped_low_volume,
    }


# --------------------------------------------------------------------------
# verify-cyclical
# --------------------------------------------------------------------------


def verify_cyclical(verify_delivered: float) -> dict[str, Any]:
    """Given the sum of `delivered` over the verification window `detect` asked for
    (periodDaysMax + 1 days — longer than the longest previously-confirmed trough),
    decide whether this is still the known cyclical pattern or a genuine new failure.
    Any delivery at all inside a window longer than the known cycle means the message
    is still cycling normally; a hard zero over that window means the trough has
    outlasted every previously observed cycle and this is no longer the known pattern."""
    if verify_delivered > 0:
        return {"verdict": "suppressed_cyclical", "verifyDelivered": verify_delivered}
    return {"verdict": "escalate_cyclical_deviation", "verifyDelivered": verify_delivered}


# --------------------------------------------------------------------------
# narrow-drop-date
# --------------------------------------------------------------------------


def narrow_drop_date(
    windows: list[dict[str, Any]],
    baseline_daily: float,
    drop_ratio_threshold: float,
) -> dict[str, Any]:
    """`windows` is an unordered list of {dateFrom, dateTo, delivered} for one message,
    each an arbitrary span (a week, half a week, whatever the model fetched). Finds the
    earliest window whose daily average first crosses below threshold, walking forward
    in time, so "when did this actually start" stops being an eyeballed guess."""
    parsed = []
    for w in windows:
        d_from = _parse_date(w["dateFrom"])
        d_to = _parse_date(w["dateTo"])
        days = (d_to - d_from).days + 1
        daily = float(w["delivered"]) / days
        collapsed = daily <= drop_ratio_threshold * baseline_daily
        parsed.append({"dateFrom": d_from, "dateTo": d_to, "daily": daily, "collapsed": collapsed})
    parsed.sort(key=lambda w: w["dateFrom"])

    prev_collapsed = False
    for w in parsed:
        if w["collapsed"] and not prev_collapsed:
            drop_before_earliest = w is parsed[0]
            return {
                "dropDate": _fmt_date(w["dateFrom"]),
                "dropBeforeEarliestWindow": drop_before_earliest,
            }
        prev_collapsed = w["collapsed"]

    return {"dropDate": None, "note": "no collapsed window found in the provided data"}


# --------------------------------------------------------------------------
# reconcile
# --------------------------------------------------------------------------


def reconcile(
    previous_active_alerts: dict[str, Any],
    confirmed: list[dict[str, Any]],
    today: date,
) -> dict[str, Any]:
    """`confirmed` is this run's fully investigated anomalies (post cyclical-verification
    and root-cause lookup) — everything the model has decided IS real. Produces the next
    activeAlerts dict plus a flat list of lifecycle events for history-append, so the model
    never hand-edits the state file's add/remove logic itself."""
    today_str = _fmt_date(today)
    confirmed_by_id = {c["messageId"]: c for c in confirmed}
    new_alerts: dict[str, Any] = {}
    events: list[dict[str, Any]] = []

    for mid, c in confirmed_by_id.items():
        prior = previous_active_alerts.get(mid)
        first_detected = prior["firstDetected"] if prior else today_str
        new_alerts[mid] = {**c, "firstDetected": first_detected}
        events.append(
            {
                "date": today_str,
                "type": "new_anomaly" if prior is None else "still_active",
                "messageId": mid,
                "workflowName": c.get("workflowName"),
            }
        )

    for mid, prior in previous_active_alerts.items():
        if mid not in confirmed_by_id:
            events.append(
                {
                    "date": today_str,
                    "type": "recovered",
                    "messageId": mid,
                    "workflowName": prior.get("workflowName"),
                }
            )

    return {"activeAlerts": new_alerts, "events": events}


# --------------------------------------------------------------------------
# history
# --------------------------------------------------------------------------


def _history_file(history_dir: Path, account: str, year_month: str) -> Path:
    return history_dir / f"esputnik-monitor-history-{account}-{year_month}.json"


def history_append(history_dir: Path, account: str, entry: dict[str, Any], today: date) -> Path:
    entry = dict(entry)
    entry.setdefault("date", _fmt_date(today))
    year_month = _fmt_date(today)[:7]
    path = _history_file(history_dir, account, year_month)
    path.parent.mkdir(parents=True, exist_ok=True)
    existing: list[dict[str, Any]] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    existing.append(entry)
    path.write_text(json.dumps(existing, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def _months_between(since: date, until: date) -> list[str]:
    months = []
    cur = date(since.year, since.month, 1)
    end = date(until.year, until.month, 1)
    while cur <= end:
        months.append(cur.strftime("%Y-%m"))
        if cur.month == 12:
            cur = date(cur.year + 1, 1, 1)
        else:
            cur = date(cur.year, cur.month + 1, 1)
    return months


def history_read(history_dir: Path, account: str, since: date, until: date) -> list[dict[str, Any]]:
    """Only opens the month files the [since, until] range can actually touch — reading
    "the last 2 weeks" never means loading two years of history to filter it client-side."""
    entries: list[dict[str, Any]] = []
    for year_month in _months_between(since, until):
        path = _history_file(history_dir, account, year_month)
        if not path.exists():
            continue
        for entry in json.loads(path.read_text(encoding="utf-8")):
            d = _parse_date(entry["date"])
            if since <= d <= until:
                entries.append(entry)
    entries.sort(key=lambda e: e["date"])
    return entries


# --------------------------------------------------------------------------
# one-time migration from the pre-rewrite state file shape
# --------------------------------------------------------------------------


def migrate_legacy_state(state_path: Path, history_dir: Path, account: str) -> dict[str, Any]:
    """The pre-rewrite state file was `{"activeAlerts": {...}, "weekLog": [...]}`, with
    weekLog cleared out after every weekly report — meaning no full history existed
    anywhere. This moves every weekLog entry into the right month's history file (keyed
    by the entry's own `date`) and returns the state stripped down to just
    `{"activeAlerts": {...}}`. Idempotent: a state file with no `weekLog` key (already
    migrated, or created fresh under the new shape) round-trips with migratedEntries=0 —
    safe to run on every boot rather than needing a separate "have I migrated yet" flag."""
    if not state_path.exists():
        return {"activeAlerts": {}, "migratedEntries": 0}
    state = json.loads(state_path.read_text(encoding="utf-8"))
    week_log = state.pop("weekLog", [])
    for entry in week_log:
        # Every real weekLog entry observed in production already carries its own
        # "date" — this fallback only guards a hypothetical older/malformed entry
        # from being silently dropped during migration.
        entry_date = _parse_date(entry["date"]) if entry.get("date") else date.fromtimestamp(state_path.stat().st_mtime)
        history_append(history_dir, account, {**entry, "date": _fmt_date(entry_date)}, entry_date)
    active_alerts = state.get("activeAlerts", {})
    state_path.write_text(json.dumps({"activeAlerts": active_alerts}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"activeAlerts": active_alerts, "migratedEntries": len(week_log)}


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _print_json(obj: Any) -> None:
    json.dump(obj, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("ensure-config", help="Create the per-account config file with defaults if missing.")
    p.add_argument("--config", required=True, type=Path)

    p = sub.add_parser("csv-sum", help="Sum a column, optionally filtered by other column values.")
    p.add_argument("--csv", required=True, type=Path)
    p.add_argument("--column", required=True)
    p.add_argument("--filter", action="append", default=[], metavar="COLUMN=VALUE")

    p = sub.add_parser("detect", help="Find flatline candidates from a baseline/recent CSV pair.")
    p.add_argument("--baseline", required=True, type=Path)
    p.add_argument("--recent", required=True, type=Path)
    p.add_argument("--active-workflows", required=True, type=Path, help="Raw list_workflows JSON response.")
    p.add_argument("--config", required=True, type=Path)
    p.add_argument("--today", required=True)

    p = sub.add_parser("verify-cyclical", help="Decide suppress vs. escalate for a known-cyclical candidate.")
    p.add_argument("--verify-delivered", required=True, type=float)

    p = sub.add_parser("narrow-drop-date", help="Estimate when a campaign's volume actually collapsed.")
    p.add_argument("--windows", required=True, type=Path, help="JSON file: [{dateFrom, dateTo, delivered}, ...]")
    p.add_argument("--baseline-daily", required=True, type=float)
    p.add_argument("--drop-ratio-threshold", required=True, type=float)

    p = sub.add_parser("reconcile", help="Merge this run's confirmed anomalies into activeAlerts.")
    p.add_argument("--state", required=True, type=Path, help="Current state file ({\"activeAlerts\": {...}}).")
    p.add_argument("--confirmed", required=True, type=Path, help="JSON file: list of confirmed anomaly objects.")
    p.add_argument("--today", required=True)

    p = sub.add_parser("history-append", help="Append one event to this month's history file.")
    p.add_argument("--history-dir", required=True, type=Path)
    p.add_argument("--account", required=True)
    p.add_argument("--entry", required=True, help="JSON object for the event.")
    p.add_argument("--today", required=True)

    p = sub.add_parser("history-read", help="Read history entries in [--since, --until], touching only those months.")
    p.add_argument("--history-dir", required=True, type=Path)
    p.add_argument("--account", required=True)
    p.add_argument("--since", required=True)
    p.add_argument("--until", required=False)

    p = sub.add_parser(
        "migrate-legacy-state",
        help="One-time (idempotent): move a pre-rewrite state file's weekLog into monthly history files.",
    )
    p.add_argument("--state", required=True, type=Path)
    p.add_argument("--history-dir", required=True, type=Path)
    p.add_argument("--account", required=True)

    args = parser.parse_args(argv)

    if args.command == "ensure-config":
        cfg = ensure_config(args.config)
        _print_json(cfg)
        return 0

    if args.command == "csv-sum":
        filters = dict(f.split("=", 1) for f in args.filter)
        total = csv_sum(args.csv, args.column, filters)
        _print_json({"sum": total})
        return 0

    if args.command == "detect":
        active_raw = json.loads(args.active_workflows.read_text(encoding="utf-8"))
        rows = active_raw.get("data", active_raw) if isinstance(active_raw, dict) else active_raw
        active_ids = {int(r["id"]) for r in rows if r.get("status") == "active"}
        config = load_config(args.config)
        result = detect(args.baseline, args.recent, active_ids, config, _parse_date(args.today))
        _print_json(result)
        return 0

    if args.command == "verify-cyclical":
        _print_json(verify_cyclical(args.verify_delivered))
        return 0

    if args.command == "narrow-drop-date":
        windows = json.loads(args.windows.read_text(encoding="utf-8"))
        result = narrow_drop_date(windows, args.baseline_daily, args.drop_ratio_threshold)
        _print_json(result)
        return 0

    if args.command == "reconcile":
        state = json.loads(args.state.read_text(encoding="utf-8")) if args.state.exists() else {"activeAlerts": {}}
        confirmed = json.loads(args.confirmed.read_text(encoding="utf-8"))
        result = reconcile(state.get("activeAlerts", {}), confirmed, _parse_date(args.today))
        _print_json(result)
        return 0

    if args.command == "history-append":
        entry = json.loads(args.entry)
        path = history_append(args.history_dir, args.account, entry, _parse_date(args.today))
        _print_json({"wrote": str(path)})
        return 0

    if args.command == "history-read":
        since = _parse_date(args.since)
        until = _parse_date(args.until) if args.until else date.today()
        entries = history_read(args.history_dir, args.account, since, until)
        _print_json({"entries": entries})
        return 0

    if args.command == "migrate-legacy-state":
        result = migrate_legacy_state(args.state, args.history_dir, args.account)
        _print_json(result)
        return 0

    parser.error(f"unknown command {args.command!r}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
