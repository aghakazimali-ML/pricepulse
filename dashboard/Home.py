"""PricePulse dashboard — home: pipeline status, KPIs and category overview."""

import streamlit as st

import db
from components import motion_ui as ui_kit
from ui import card, delta, require_data, setup_page

setup_page("Overview")
require_data()

latest = db.latest_prices()
cats = db.category_summary()
runs = db.runs()
changes = db.price_changes()
index = db.price_index()

real_runs = runs[~runs["is_simulated"]]
last_ok = real_runs[real_runs["status"] == "success"].tail(1)
healthy = not real_runs.empty and real_runs["status"].iloc[-1] == "success"

ui_kit.header(
    eyebrow="Overview",
    title="Catalogue price tracking",
    description="Daily scrape of books.toscrape.com, validated and stored as price history in a SQL star schema.",
    status={"ok": healthy, "label": "Pipeline healthy" if healthy else "Last run failed"},
    meta=[f"Last successful run {last_ok['finished_at'].iloc[0]:%d %b %Y, %H:%M} UTC" if not last_ok.empty
          else "No successful run yet", f"{len(real_runs)} runs recorded"],
)

ui_kit.kpi_cards([
    {"label": "Products tracked", "value": int(len(latest)), "trend": index["products"].tolist(),
     "delta": delta(index["products"]), "period": "vs last capture"},
    {"label": "Categories", "value": int(len(cats))},
    {"label": "Average price", "value": float(latest["price"].mean()), "format": "gbp",
     "trend": index["avg_price"].tolist(), "delta": delta(index["avg_price"]), "good": "down", "period": "vs last capture"},
    {"label": "In stock", "value": float(latest["in_stock"].mean() * 100), "format": "pct",
     "trend": index["pct_in_stock"].tolist(), "delta": delta(index["pct_in_stock"]), "period": "vs last capture"},
    {"label": "Price changes", "value": int(len(changes)),
     "period": f"{int(changes['is_simulated'].sum())} simulated" if len(changes) else "none yet"},
])

st.write("")
left, right = st.columns([3, 2], gap="medium")
with left:
    ui_kit.area_chart(
        index, x="captured_at", series=[{"key": "avg_price", "label": "Average price"}],
        title="Average catalogue price", subtitle="Last known price of every product, at each capture",
        description="Average price across all tracked products over time", format="gbp", x_format="date",
        height=250, key="home-avg",
    )
with right:
    rating = latest["rating"].value_counts().sort_index(ascending=False)
    ui_kit.donut_chart(
        [{"label": f"{int(r)} star{'s' if r != 1 else ''}", "value": int(n)} for r, n in rating.items()],
        title="Rating mix", subtitle="Products by star rating", center_label="Products",
        description="Number of products at each star rating", key="home-rating",
    )

st.write("")
left, right = st.columns([3, 2], gap="medium")
with left:
    top = cats.head(15)
    ui_kit.bar_chart(
        top, x="category", series=[{"key": "products", "label": "Products"}], horizontal=True,
        title="Largest categories", subtitle="Top 15 by product count", height=430,
        description="Product count for the 15 largest categories", key="home-cats",
    )
with right, card("Category summary", "Latest prices, all categories"):
    st.dataframe(cats[["category", "products", "avg_price", "avg_rating", "pct_in_stock"]], hide_index=True,
                 width="stretch", height=388,
                 column_config={"category": "Category", "products": "Products",
                                "avg_price": st.column_config.NumberColumn("Avg price", format="£%.2f"),
                                "avg_rating": st.column_config.NumberColumn("Rating", format="%.1f"),
                                "pct_in_stock": st.column_config.NumberColumn("In stock", format="%.0f%%")})
