"""Products: filterable catalogue with images and CSV export."""

import streamlit as st

import db
from components import motion_ui as ui_kit
from ui import card, require_data, setup_page

setup_page("Products")
require_data()

df = db.latest_prices()

with st.sidebar:
    st.divider()
    st.markdown("**Filters**")
    categories = st.multiselect("Category", sorted(df["category"].unique()), placeholder="All categories")
    lo, hi = float(int(df["price"].min())), float(int(df["price"].max()) + 1)
    price_range = st.slider("Price (£)", min_value=lo, max_value=hi, value=(lo, hi), step=1.0)
    min_rating = st.select_slider("Minimum rating", options=[1, 2, 3, 4, 5], value=1,
                                  format_func=lambda r: f"{r}+ stars" if r < 5 else "5 stars")
    stock_filter = st.segmented_control("Availability", ["All", "In stock", "Out of stock"], default="All")
    search = st.text_input("Title contains", placeholder="Search titles")

mask = df["price"].between(*price_range) & (df["rating"] >= min_rating)
if categories:
    mask &= df["category"].isin(categories)
if stock_filter and stock_filter != "All":
    mask &= df["in_stock"] == (stock_filter == "In stock")
if search:
    mask &= df["title"].str.contains(search, case=False, regex=False)
filtered = df[mask].sort_values("title")

ui_kit.header(eyebrow="Products", title="Catalogue",
              description="Latest known price, rating and stock for every tracked product.",
              meta=[f"{len(df):,} products tracked"], key="products-header")
ui_kit.kpi_cards([
    {"label": "Matching products", "value": int(len(filtered)), "period": f"of {len(df):,}"},
    {"label": "Average price", "value": float(filtered["price"].mean()) if len(filtered) else 0, "format": "gbp"},
    {"label": "Average rating", "value": f"{filtered['rating'].mean():.2f}" if len(filtered) else "–"},
    {"label": "Units in stock", "value": int(filtered["stock_qty"].sum())},
], key="product-kpis")

st.write("")
view = filtered[["image_url", "title", "category", "price", "rating", "in_stock", "stock_qty", "url", "captured_at"]]
with card(f"{len(filtered):,} products", "Use the filters in the sidebar to narrow the list"):
    st.dataframe(
        view, hide_index=True, width="stretch", height=620, row_height=64,
        column_config={
            "image_url": st.column_config.ImageColumn("Cover", width="small"),
            "title": st.column_config.TextColumn("Title", width="large"),
            "category": "Category",
            "price": st.column_config.NumberColumn("Price", format="£%.2f"),
            "rating": st.column_config.NumberColumn("Rating", format="%d / 5"),
            "in_stock": st.column_config.CheckboxColumn("In stock"),
            "stock_qty": st.column_config.NumberColumn("Units"),
            "url": st.column_config.LinkColumn("Link", display_text="Open"),
            "captured_at": st.column_config.DatetimeColumn("Price seen", format="D MMM YYYY, HH:mm"),
        },
    )
st.download_button("Download CSV", filtered.drop(columns=["image_url"]).to_csv(index=False).encode("utf-8"),
                   file_name="pricepulse_products.csv", mime="text/csv")
