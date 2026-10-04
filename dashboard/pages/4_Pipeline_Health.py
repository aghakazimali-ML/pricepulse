"""Pipeline health: run history, volumes, durations, data-quality results and rejected rows."""

import json

import pandas as pd
import streamlit as st

import db
from components import motion_ui as ui_kit
from ui import card, setup_page

setup_page("Pipeline Health")

runs = db.runs()
if runs.empty:
    st.warning("No pipeline runs recorded yet. Run `python cli.py run --source books --limit-pages 3`.")
    st.stop()

real = runs[~runs["is_simulated"]]
healthy = not real.empty and real["status"].iloc[-1] == "success"
ui_kit.header(eyebrow="Pipeline health", title="Runs and data quality",
              description="Every run is tracked with row counts, timings, quality checks and rejected records.",
              status={"ok": healthy, "label": "Last run succeeded" if healthy else "Last run failed"},
              key="health-header")

show_sim = st.toggle("Include simulated runs", value=False)
view = runs if show_sim else real

success = (real["status"] == "success").astype(float) * 100
ui_kit.kpi_cards([
    {"label": "Runs", "value": int(len(real)), "period": f"+{int(runs['is_simulated'].sum())} simulated"},
    {"label": "Success rate", "value": float(success.mean()) if len(real) else 0, "format": "pct",
     "trend": success.expanding().mean().tolist()},
    {"label": "Average duration", "value": float(real["duration_s"].mean() or 0), "format": "sec",
     "trend": real["duration_s"].fillna(0).tolist()},
    {"label": "Rows rejected", "value": int(real["rows_rejected"].sum()),
     "period": f"of {int(real['rows_extracted'].sum()):,} extracted"},
], key="health-kpis")

st.write("")
ui_kit.run_strip([
    {"id": int(r.run_id), "status": r.status, "source": r.source, "simulated": bool(r.is_simulated),
     "label": f"{r.started_at:%d %b %H:%M} · {int(r.rows_loaded):,} loaded"}
    for r in view.tail(80).itertuples()
])

st.write("")
left, right = st.columns(2, gap="medium")
vol = view.assign(run=view["run_id"].astype(str))
with left:
    ui_kit.bar_chart(vol, x="run", series=[{"key": "rows_loaded", "label": "Loaded"},
                                           {"key": "rows_rejected", "label": "Rejected"}],
                     stacked=True, x_format="run", title="Rows per run", subtitle="Loaded and rejected",
                     height=240, description="Rows loaded and rejected in each run", key="health-rows")
with right:
    ui_kit.bar_chart(real.assign(run=real["run_id"].astype(str)), x="run",
                     series=[{"key": "duration_s", "label": "Duration"}], format="sec", x_format="run",
                     title="Run duration", subtitle="Real runs only, all sources", height=266,
                     description="Duration in seconds of each real run", key="health-duration")

st.write("")
STATUS_STYLE = {"success": "color: #34D399", "failed": "color: #F87171", "running": "color: #A3A3A3"}
table = view.sort_values("run_id", ascending=False)[
    ["run_id", "source", "status", "is_simulated", "started_at", "duration_s", "rows_extracted",
     "rows_loaded", "rows_rejected", "error_message"]]
with card("Run history"):
    st.dataframe(table.style.map(lambda s: STATUS_STYLE.get(s, ""), subset=["status"]), hide_index=True,
                 width="stretch",
                 column_config={"run_id": "Run", "source": "Source", "status": "Status",
                                "is_simulated": st.column_config.CheckboxColumn("Simulated"),
                                "started_at": st.column_config.DatetimeColumn("Started", format="D MMM YYYY, HH:mm"),
                                "duration_s": st.column_config.NumberColumn("Duration", format="%.1f s"),
                                "rows_extracted": "Extracted", "rows_loaded": "Loaded", "rows_rejected": "Rejected",
                                "error_message": "Error"})

quality = db.quality_results()
with card("Latest data-quality checks", "Critical failures stop the load; soft checks only warn"):
    if quality.empty:
        st.caption("No quality results yet.")
    else:
        st.dataframe(quality[["source", "run_id", "check_name", "status", "severity", "details"]]
                     .style.map(lambda s: {"pass": "color: #34D399", "warn": "color: #F59E0B",
                                           "fail": "color: #F87171"}.get(s, ""), subset=["status"]),
                     hide_index=True, width="stretch",
                     column_config={"source": "Source", "run_id": "Run", "check_name": "Check", "status": "Status",
                                    "severity": "Severity", "details": "Details"})

rows = []
for r in real.sort_values("run_id").groupby("source").tail(1).itertuples():
    stats = json.loads(r.stats_json) if r.stats_json else {}
    rows.append({"Source": r.source, "Run": r.run_id, "Pages fetched": stats.get("pages_fetched"),
                 "Retries": stats.get("retries"), "Failures": stats.get("failures"),
                 "Blocked by robots.txt": stats.get("robots_blocked"),
                 "Duplicates dropped": stats.get("duplicates_dropped"),
                 "New snapshots": stats.get("snapshots_inserted")})
with card("Crawl statistics", "Latest real run per source"):
    st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")

rejected = db.rejected_sample()
with card("Rejected rows", "Most recent 50, with the validation reason"):
    if rejected.empty:
        st.caption("No rejected rows. Every scraped record passed validation.")
    else:
        st.dataframe(rejected, hide_index=True, width="stretch",
                     column_config={"run_id": "Run", "source": "Source", "record_key": "Record", "reason": "Reason",
                                    "payload": st.column_config.JsonColumn("Raw record")
                                    if hasattr(st.column_config, "JsonColumn") else "Raw record"})
