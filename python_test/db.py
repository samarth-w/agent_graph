"""Database layer — handles connection, queries, and migrations."""

import sqlite3
from typing import List, Optional, Dict, Any


class Database:
    """SQLite wrapper with connection pooling."""

    def __init__(self, path: str):
        self.path = path
        self.conn: Optional[sqlite3.Connection] = None

    def connect(self) -> sqlite3.Connection:
        if self.conn is None:
            self.conn = sqlite3.connect(self.path)
            self.conn.row_factory = sqlite3.Row
            self._run_migrations()
        return self.conn

    def _run_migrations(self):
        cursor = self.conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                role TEXT DEFAULT 'user'
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                body TEXT,
                author_id INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        self.conn.commit()

    def query(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        conn = self.connect()
        return conn.execute(sql, params)

    def fetch_all(self, sql: str, params: tuple = ()) -> List[Dict[str, Any]]:
        cursor = self.query(sql, params)
        return [dict(row) for row in cursor.fetchall()]

    def fetch_one(self, sql: str, params: tuple = ()) -> Optional[Dict[str, Any]]:
        cursor = self.query(sql, params)
        row = cursor.fetchone()
        return dict(row) if row else None

    def close(self):
        if self.conn:
            self.conn.close()
            self.conn = None
