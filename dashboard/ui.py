"""Shared page chrome: config, CSS, Plotly theme and the sidebar.

The look follows the 21st.dev Layro kit used by the React components: neutral surfaces,
hairline borders, a monochrome chart scale and colour reserved for meaning
(green = good / price drop, red = bad / price rise).
"""

from contextlib import contextmanager

import plotly.graph_objects as go
import plotly.io as pio
import streamlit as st

from db import has_data, resolve_database_url

INK, INK_2, INK_3, INK_4 = "#FAFAFA", "#A3A3A3", "#525252", "#D4D4D4"
GOOD, BAD, MUTED, BORDER = "#34D399", "#F87171", "#A3A3A3", "#262626"
# Monochrome first, then restrained hues for charts that need many distinguishable series.
PALETTE = [INK, INK_2, "#60A5FA", "#F59E0B", "#C084FC", INK_3, "#2DD4BF", "#F472B6", INK_4, "#A3E635"]

pio.templates["pricepulse"] = go.layout.Template(
    layout=go.Layout(
        font=dict(family="Geist, ui-sans-serif, system-ui, sans-serif", color=MUTED, size=12),
        title=dict(font=dict(color=INK, size=14)),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        colorway=PALETTE,
        xaxis=dict(gridcolor=BORDER, linecolor=BORDER, zeroline=False, ticks=""),
        yaxis=dict(gridcolor=BORDER, linecolor=BORDER, zeroline=False, ticks=""),
        margin=dict(l=8, r=8, t=16, b=8),
        hoverlabel=dict(bgcolor="#171717", bordercolor=BORDER, font=dict(color=INK, size=12)),
        legend=dict(bgcolor="rgba(0,0,0,0)", font=dict(color=MUTED)),
    )
)
pio.templates.default = "plotly_dark+pricepulse"

_CSS = """
<style>
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono&display=swap');
html, body, [class*="st-"], .stMarkdown, button, input { font-family: 'Geist', ui-sans-serif, system-ui, sans-serif; }
code { font-family: 'Geist Mono', ui-monospace, monospace; }
.block-container { padding-top: 2.4rem; max-width: 1280px; }
[data-testid="stSidebar"] { background: #0A0A0A; border-right: 1px solid #262626; }
[data-testid="stSidebarNav"] a span { font-size: 13.5px; }
/* card() panels: match the React ChartCard surface. */
[data-testid="stVerticalBlock"]:has(> [data-testid="stElementContainer"] .pp-card),
[data-testid="stVerticalBlockBorderWrapper"]:has(.pp-card) { background: #171717;
  border-color: #262626 !important; border-radius: 18px; }
.pp-section { margin: 1.6rem 0 .5rem; }
.pp-card.pp-section { margin: 0 0 .25rem; }
.pp-section h3 { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; margin: 0; padding: 0; color: #FAFAFA; }
.pp-section p { font-size: 12px; color: #A3A3A3; margin: 2px 0 0; }
.pp-tag { display: inline-block; font-size: 11px; font-weight: 500; color: #A3A3A3; border: 1px dashed #525252;
  border-radius: 6px; padding: 1px 7px; }
.pp-brand { font-size: 15px; font-weight: 600; letter-spacing: -0.02em; color: #FAFAFA; }
.pp-muted { font-size: 12.5px; color: #A3A3A3; line-height: 1.55; }
[data-baseweb="tag"] { background: #262626 !important; border: 1px solid #333 !important; }
[data-baseweb="tag"] span, [data-baseweb="tag"] svg { color: #FAFAFA !important; fill: #FAFAFA !important; }
footer { visibility: hidden; }
</style>
"""


def setup_page(title: str) -> None:
    st.set_page_config(page_title=f"{title} · PricePulse", page_icon="▪", layout="wide")
    st.markdown(_CSS, unsafe_allow_html=True)
    _, label = resolve_database_url()
    with st.sidebar:
        st.markdown('<div class="pp-brand">PricePulse</div>'
                    '<div class="pp-muted">Price tracking pipeline</div>', unsafe_allow_html=True)
        st.divider()
        st.markdown(f'<div class="pp-muted">Source<br><span style="color:#FAFAFA">{label}</span></div>',
                    unsafe_allow_html=True)
        st.markdown('<div class="pp-muted" style="margin-top:12px"><span class="pp-tag">simulated</span> '
                    'marks demo price moves. The practice site never changes its prices.</div>',
                    unsafe_allow_html=True)
        st.write("")
        if st.button("Refresh data", width="stretch"):
            st.cache_data.clear()
            st.rerun()


def section(title: str, subtitle: str = "", _cls: str = "") -> None:
    sub = f"<p>{subtitle}</p>" if subtitle else ""
    st.markdown(f'<div class="pp-section {_cls}"><h3>{title}</h3>{sub}</div>', unsafe_allow_html=True)


@contextmanager
def card(title: str, subtitle: str = ""):
    """A bordered panel matching the 21st.dev ChartCard, for Plotly charts and tables."""
    with st.container(border=True):
        section(title, subtitle, _cls="pp-card")
        yield


def plot(fig, height: int | None = None) -> None:
    """Render a Plotly figure with our template (Streamlit's own chart theme would override it)."""
    fig.update_layout(paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
                      xaxis=dict(showgrid=False), yaxis=dict(gridcolor=BORDER))
    if height:
        fig.update_layout(height=height)
    st.plotly_chart(fig, width="stretch", theme=None, config={"displayModeBar": False})


def require_data() -> None:
    if not has_data():
        st.warning("No data yet. Run `python cli.py init-db && python cli.py run --source books --limit-pages 3`, "
                   "or `make demo-db` to build the bundled demo database.")
        st.stop()


def delta(series, periods: int = 1) -> float | None:
    """Fractional change between the last value and the one `periods` before it."""
    values = [v for v in series if v is not None]
    if len(values) <= periods or not values[-1 - periods]:
        return None
    return float(values[-1] / values[-1 - periods] - 1)
