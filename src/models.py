"""Pydantic v2 models.

Raw* models describe what the extract layer emits (strings as found on the page).
Clean models describe a validated, typed row that is allowed into the warehouse.
"""

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator


class RawBook(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str | None = None
    category: str | None = None
    price: str | None = None
    availability: str | None = None
    rating: str | None = None
    upc: str | None = None
    description: str | None = None
    product_url: str
    image_url: str | None = None
    scraped_at: datetime


class RawQuote(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str | None = None
    author: str | None = None
    tags: list[str] = Field(default_factory=list)
    page_url: str
    scraped_at: datetime


class BookRecord(BaseModel):
    """One clean book row. Validation failures send the row to the rejected layer."""

    upc: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=500)
    category: str = Field(min_length=1, max_length=120)
    price: Decimal = Field(gt=0, max_digits=10, decimal_places=2)
    currency: str = Field(min_length=3, max_length=3)
    in_stock: bool
    stock_qty: int = Field(ge=0)
    rating: int = Field(ge=1, le=5)
    description: str | None = None
    url: HttpUrl
    image_url: HttpUrl | None = None
    scraped_at: datetime

    @field_validator("upc", "title", "category")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value.strip()


class QuoteRecord(BaseModel):
    text: str = Field(min_length=1)
    author: str = Field(min_length=1, max_length=200)
    tags: list[str] = Field(default_factory=list)
    page_url: HttpUrl
    scraped_at: datetime
