"""Post model — blog post CRUD with author relationship."""

from typing import List, Optional, Dict, Any
from db import Database
from models import UserService, UserNotFoundError


class PostService:
    """Handles post business logic."""

    def __init__(self, db: Database, user_service: UserService):
        self.db = db
        self.user_service = user_service

    def create_post(self, title: str, body: str, author_id: int) -> Dict[str, Any]:
        # Verify author exists
        self.user_service.get_user(author_id)
        self.db.execute(
            "INSERT INTO posts (title, body, author_id) VALUES (?, ?, ?)",
            (title, body, author_id),
        )
        return self.get_latest_post(author_id)

    def get_post(self, post_id: int) -> Optional[Dict[str, Any]]:
        return self.db.fetch_one("SELECT * FROM posts WHERE id = ?", (post_id,))

    def get_latest_post(self, author_id: int) -> Optional[Dict[str, Any]]:
        return self.db.fetch_one(
            "SELECT * FROM posts WHERE author_id = ? ORDER BY id DESC LIMIT 1",
            (author_id,),
        )

    def list_posts(self, author_id: Optional[int] = None) -> List[Dict[str, Any]]:
        if author_id:
            return self.db.fetch_all(
                "SELECT * FROM posts WHERE author_id = ?", (author_id,)
            )
        return self.db.fetch_all("SELECT * FROM posts ORDER BY created_at DESC")

    def list_posts_with_authors(self) -> List[Dict[str, Any]]:
        return self.db.fetch_all("""
            SELECT p.*, u.name as author_name, u.email as author_email
            FROM posts p
            JOIN users u ON p.author_id = u.id
            ORDER BY p.created_at DESC
        """)

    def delete_post(self, post_id: int) -> bool:
        self.db.execute("DELETE FROM posts WHERE id = ?", (post_id,))
        return True

    def delete_posts_by_author(self, author_id: int) -> int:
        posts = self.list_posts(author_id)
        for post in posts:
            self.delete_post(post["id"])
        return len(posts)
