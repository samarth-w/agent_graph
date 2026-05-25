"""Utilities — shared helpers used across modules."""

import re
from datetime import datetime
from typing import Optional


def validate_email(email: str) -> bool:
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return bool(re.match(pattern, email))


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text)
    return text


def format_timestamp(dt: Optional[datetime] = None) -> str:
    if dt is None:
        dt = datetime.utcnow()
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def truncate(text: str, max_length: int = 200) -> str:
    if len(text) <= max_length:
        return text
    return text[:max_length - 3] + "..."


def parse_pagination(page: int = 1, per_page: int = 20) -> tuple:
    page = max(1, page)
    per_page = min(max(1, per_page), 100)
    offset = (page - 1) * per_page
    return offset, per_page
