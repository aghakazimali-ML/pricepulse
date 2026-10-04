"""Price history: price over time per product and the biggest movers."""

import plotly.express as px
import streamlit as st

import db
from components import motion_ui as ui_kit
from ui import BAD, GOOD, INK_2, PALETTE, card, plot, require_data, setup_page

setup_page("Price History")
require_data()

latest = db.latest_prices()
changes = db.price_changes()
index = db.price_index()

ui_kit.header(eyebrow="Price history", title="Price movements",
              description="Every change in price, with old and new values. Simulated runs are marked.",
              meta=[f"{len(changes):,} changes recorded"], key="history-header")

if changes.empty:
    st.info("No price changes recorded yet. Prices on books.toscrape.com never change, so run "
            "`python cli.py simulate-price-changes --runs 3` to create clearly labelled demo moves.")
else:
    drops, rises = changes[changes["pct_change"] < 0], changes[changes["pct_change"] > 0]
    ui_kit.kpi_cards([
        {"label": "Price drops", "value": int(len(drops))},
        {"label": "Price increases", "value": int(len(rises))},
        {"label": "Average drop", "value": float(drops["pct_change"].mean()) if len(drops) else 0, "format": "pct"},
        {"label": "Average increase", "value": float(rises["pct_change"].mean()) if len(rises) else 0, "format": "pct"},
        {"label": "Simulated", "value": int(changes["is_simulated"].sum()), "period": "demo changes"},
    ], key="history-kpis")
    st.write("")
    ui_kit.area_chart(index, x="captured_at", series=[{"key": "avg_price", "label": "Average price"}],
                      title="Average catalogue price", subtitle="All products, at each capture", format="gbp",
                      x_format="date", height=200, description="Average price over time", key="history-avg")

movers = (changes.assign(abs_pct=changes["pct_change"].abs()).sort_values("abs_pct", ascending=False)
          ["product_id"].drop_duplicates().head(4).tolist()) if len(changes) else latest["product_id"].head(3).tolist()
titles = latest.set_index("product_id")["title"].to_dict()

st.write("")
with card("Price over time", "Pick up to 10 products. The biggest movers are selected by default."):
    selected = st.multiselect("Products", options=list(titles), default=movers, format_func=lambda pid: titles[pid],
                              max_selections=10, placeholder="Pick products", label_visibility="collapsed")
    history = db.price_history(selected)
    if history.empty:
        st.caption("Select one or more products above.")
    else:
        fig = px.line(history, x="captured_at", y="price", color="title", line_shape="hv", markers=True,
                      color_discrete_sequence=PALETTE,
                      hover_data={"stock_qty": True, "in_stock": True, "run_id": True, "is_simulated": True},
                      labels={"captured_at": "", "price": "Price", "title": ""})
        fig.update_traces(line=dict(width=2), marker=dict(size=6))
        sim = history[history["is_simulated"]]
        if len(sim):
            fig.add_scatter(x=sim["captured_at"], y=sim["price"], mode="markers", name="Simulated",
                            marker=dict(symbol="circle-open", size=12, color=INK_2, line=dict(width=1.5)))
        fig.update_layout(height=420, legend=dict(orientation="h", y=-0.12))
        fig.update_yaxes(tickprefix="£")
        plot(fig)

if len(changes):
    fmt = {
        "title": st.column_config.TextColumn("Title", width="medium"), "category": "Category",
        "old_price": st.column_config.NumberColumn("Old", format="£%.2f"),
        "new_price": st.column_config.NumberColumn("New", format="£%.2f"),
        "pct_change": st.column_config.NumberColumn("Change", format="%+.1f%%"),
        "changed_at": st.column_config.DatetimeColumn("When", format="D MMM, HH:mm"),
        "is_simulated": st.column_config.CheckboxColumn("Simulated"),
    }
    show = ["title", "category", "old_price", "new_price", "pct_change", "changed_at", "is_simulated"]
    left, right = st.columns(2, gap="medium")
    with left, card("Biggest drops"):
        st.dataframe(changes.nsmallest(15, "pct_change")[show], hide_index=True, width="stretch", column_config=fmt)
    with right, card("Biggest increases"):
        st.dataframe(changes.nlargest(15, "pct_change")[show], hide_index=True, width="stretch", column_config=fmt)

    with card("Size of price moves", "Green is a drop, red is an increase"):
        fig = px.histogram(changes, x="pct_change", nbins=40, color=changes["pct_change"] > 0,
                           color_discrete_map={True: BAD, False: GOOD}, labels={"pct_change": "Change (%)"})
        fig.update_layout(showlegend=False, bargap=0.08)
        plot(fig, 260)
