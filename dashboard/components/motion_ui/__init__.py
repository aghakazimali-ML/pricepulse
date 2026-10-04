"""Python wrapper for the dashboard's React component bundle.

The bundle is built on the 21st.dev "Charts & KPI Cards" kit (Layro System, by @uvain):
React + Tailwind + Recharts, with subtle Motion entrances. Its production build
(./frontend/dist) is committed, so Streamlit Community Cloud needs no Node build.

    cd dashboard/components/motion_ui/frontend && npm install && npm run build
    # live reload: npm run dev, then
    MOTION_UI_DEV_URL=http://localhost:5173 streamlit run dashboard/Home.py

If the bundle is missing, every function falls back to native Streamlit widgets.
Value formats are passed by name: int, gbp, gbp0, pct, sec.
"""

import os
from pathlib import Path
from typing import Any

import pandas as pd
import streamlit as st
import streamlit.components.v1 as components

_DIST = Path(__file__).parent / "frontend" / "dist"
_DEV_URL = os.getenv("MOTION_UI_DEV_URL")

if _DEV_URL:
    _component = components.declare_component("motion_ui", url=_DEV_URL)
elif (_DIST / "index.html").exists():
    _component = components.declare_component("motion_ui", path=str(_DIST))
else:
    _component = None

_PY_FORMATS = {"int": "{:,.0f}", "gbp": "£{:,.2f}", "gbp0": "£{:,.0f}", "pct": "{:.1f}%", "sec": "{:.1f}s"}


def available() -> bool:
    return _component is not None


def _render(kind: str, key: str, **props: Any) -> Any:
    return _component(kind=kind, props=props, key=key, default=None)


def _records(df: pd.DataFrame) -> list[dict[str, Any]]:
    out = df.copy()
    for col in out.columns:
        if pd.api.types.is_datetime64_any_dtype(out[col]):
            out[col] = out[col].dt.strftime("%Y-%m-%dT%H:%M:%S")
    return out.to_dict(orient="records")


def header(title: str, description: str = "", eyebrow: str = "", status: dict[str, Any] | None = None,
           meta: list[str] | None = None, key: str = "header") -> None:
    """Page header. `status` = {"ok": bool, "label": str} renders a small status chip."""
    if not available():
        st.title(title)
        if description:
            st.caption(description)
        return
    _render("header", key, title=title, description=description, eyebrow=eyebrow, status=status, meta=meta or [])


def kpi_cards(cards: list[dict[str, Any]], key: str = "kpis") -> None:
    """KPI cards. Each card: label, value, [format, delta (fraction), good ("up"/"down"), period, trend (list)]."""
    if not available():
        cols = st.columns(len(cards))
        for col, c in zip(cols, cards):
            value = c["value"]
            text = _PY_FORMATS.get(c.get("format", "int"), "{}").format(value) if isinstance(value, (int, float)) \
                else str(value)
            delta = f"{c['delta'] * 100:+.1f}%" if c.get("delta") is not None else None
            col.metric(c["label"], text, delta, delta_color="inverse" if c.get("good") == "down" else "normal")
        return
    _render("kpis", key, cards=cards)


def area_chart(df: pd.DataFrame, x: str, series: list[dict[str, Any]], title: str, description: str,
               subtitle: str = "", format: str = "int", x_format: str | None = None, height: int = 240,
               key: str = "area") -> None:
    """Area trend. `series` = [{"key": column, "label": text}, ...]."""
    if not available():
        st.markdown(f"**{title}**")
        st.area_chart(df, x=x, y=[s["key"] for s in series])
        return
    _render("area", key, data=_records(df[[x, *[s["key"] for s in series]]]), xKey=x, series=series,
            title=title, subtitle=subtitle, description=description, format=format, xFormat=x_format, height=height)


def bar_chart(df: pd.DataFrame, x: str, series: list[dict[str, Any]], title: str, description: str,
              subtitle: str = "", format: str = "int", x_format: str | None = None, height: int = 240,
              stacked: bool = False, horizontal: bool = False, key: str = "bar") -> None:
    """Bar comparison. `horizontal=True` draws category bars left to right."""
    if not available():
        st.markdown(f"**{title}**")
        st.bar_chart(df, x=x, y=[s["key"] for s in series], horizontal=horizontal)
        return
    _render("bar", key, data=_records(df[[x, *[s["key"] for s in series]]]), xKey=x, series=series,
            title=title, subtitle=subtitle, description=description, format=format, xFormat=x_format,
            height=height, stacked=stacked, layout="vertical" if horizontal else "horizontal")


def donut_chart(slices: list[dict[str, Any]], title: str, description: str, subtitle: str = "",
                format: str = "int", center_label: str = "Total", key: str = "donut") -> None:
    """Donut breakdown. `slices` = [{"label": text, "value": number}, ...]."""
    if not available():
        st.markdown(f"**{title}**")
        st.dataframe(pd.DataFrame(slices), hide_index=True)
        return
    _render("donut", key, data=slices, title=title, subtitle=subtitle, format=format,
            centerLabel=center_label, description=description)


def run_strip(runs: list[dict[str, Any]], title: str = "Recent runs", key: str = "runs") -> int | None:
    """One square per run; returns the run id the user clicked (or None)."""
    if not available():
        st.caption(" ".join("■" if r["status"] == "success" else "✕" for r in runs))
        return None
    return _render("runs", key, runs=runs, title=title)
