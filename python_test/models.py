"""User model — CRUD operations for the users table."""

from typing import List, Optional, Dict, Any
from db import Database


class UserNotFoundError(Exception):
    pass


class UserService:
    """Handles user business logic."""

    def __init__(self, db: Database):
        self.db = db

    def create_user(self, name: str, email: str, role: str = "user") -> Dict[str, Any]:
        self.db.query(            "INSERT INTO users (name, email, role) VALUES (?, ?, ?)",
            (name, email, role),
        )
        return self.get_user_by_email(email)

    def get_user(self, user_id: int) -> Dict[str, Any]:
        user = self.db.fetch_one("SELECT * FROM users WHERE id = ?", (user_id,))
        if not user:
            raise UserNotFoundError(f"User {user_id} not found")
        return user

    def get_user_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        return self.db.fetch_one("SELECT * FROM users WHERE email = ?", (email,))

    def list_users(self, role: Optional[str] = None) -> List[Dict[str, Any]]:
        if role:
            return self.db.fetch_all("SELECT * FROM users WHERE role = ?", (role,))
        return self.db.fetch_all("SELECT * FROM users")

    def update_user(self, user_id: int, **kwargs) -> Dict[str, Any]:
        fields = ", ".join(f"{k} = ?" for k in kwargs)
        values = tuple(kwargs.values()) + (user_id,)
        self.db.query(f"UPDATE users SET {fields} WHERE id = ?", values)
        return self.get_user(user_id)

    def delete_user(self, user_id: int) -> bool:
        self.get_user(user_id)  # raises if not found
        self.db.query("DELETE FROM users WHERE id = ?", (user_id,))
        return True

    def count_users(self) -> int:
        result = self.db.fetch_one("SELECT COUNT(*) as cnt FROM users")
        return result["cnt"] if result else 0
