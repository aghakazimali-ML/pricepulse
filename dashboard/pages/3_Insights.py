"""Insights: distributions, rating vs price, stock levels and best-value books."""

import plotly.express as px
import streamlit as st

import db
from components import motion_ui as ui_kit
from ui import BAD, INK, INK_2, INK_3, card, plot, require_data, setup_page

setup_page("Insights")
require_data()

df = db.latest_prices()
ui_kit.header(eyebrow="Insights", title="What the catalogue looks like",
              description="Price spread by category, how price relates to rating, and where the stock is.",
              key="insights-header")

n_cats = int(df["category"].nunique())
top_n = st.slider("Categories to compare", min_value=min(5, n_cats), max_value=max(n_cats, 5),
                  value=min(12, n_cats)) if n_cats > 5 else n_cats
top_cats = df["category"].value_counts().head(top_n).index
subset = df[df["category"].isin(top_cats)]

with card("Price spread by category", "Box shows the middle 50% of prices; the line is the median"):
    order = subset.groupby("category")["price"].median().sort_values().index.tolist()
    fig = px.box(subset, x="category", y="price", points="outliers", category_orders={"category": order},
                 color_discrete_sequence=[INK_2], labels={"price": "Price", "category": ""})
    fig.update_traces(fillcolor="rgba(250,250,250,0.06)", line=dict(width=1.5), marker=dict(size=4, color=INK_3))
    fig.update_yaxes(tickprefix="£")
    plot(fig, 380)

left, right = st.columns(2, gap="medium")
with left, card("Rating vs price", "Each dot is a product; the line is the mean price per rating"):
    fig = px.strip(df, x="rating", y="price", color="in_stock", hover_name="title",
                   color_discrete_map={True: INK_3, False: BAD},
                   labels={"rating": "Rating", "price": "Price", "in_stock": "In stock"})
    means = df.groupby("rating", as_index=False)["price"].mean()
    fig.add_scatter(x=means["rating"], y=means["price"], mode="lines+markers", name="Mean price",
                    line=dict(color=INK, width=2), marker=dict(size=7, color=INK))
    fig.update_layout(legend=dict(orientation="h", y=-0.18))
    fig.update_yaxes(tickprefix="£")
    plot(fig, 300)
with right:
    bins = (df["stock_qty"].clip(upper=25) // 5 * 5).astype(int)
    stock = (bins.value_counts().sort_index().rename_axis("bucket").reset_index(name="products"))
    stock["bucket"] = stock["bucket"].map(lambda b: f"{b}–{b + 4}" if b < 25 else "25+")
    ui_kit.bar_chart(stock, x="bucket", series=[{"key": "products", "label": "Products"}],
                     title="Stock levels", subtitle="Products by units available", height=300,
                     description="Number of products in each stock-level band", key="insights-stock")

stock_cat = (df.groupby("category", as_index=False).agg(units=("stock_qty", "sum"))
             .sort_values("units", ascending=False).head(top_n))
st.write("")
ui_kit.bar_chart(stock_cat, x="category", series=[{"key": "units", "label": "Units"}], horizontal=True,
                 title="Units in stock by category", subtitle=f"Top {top_n} categories", height=max(240, top_n * 28),
                 description="Total units in stock per category", key="insights-stockcat")

st.write("")
best = df[(df["rating"] == df["rating"].max()) & df["in_stock"]].nsmallest(15, "price")
with card("Best value", "Highest-rated books that are in stock, cheapest first"):
    st.dataframe(best[["image_url", "title", "category", "price", "rating", "stock_qty", "url"]], hide_index=True,
                 width="stretch", row_height=60,
                 column_config={"image_url": st.column_config.ImageColumn("Cover"), "title": "Title",
                                "category": "Category", "stock_qty": "Units",
                                "price": st.column_config.NumberColumn("Price", format="£%.2f"),
                                "rating": st.column_config.NumberColumn("Rating", format="%d / 5"),
                                "url": st.column_config.LinkColumn("Link", display_text="Open")})
