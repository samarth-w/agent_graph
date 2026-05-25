"""Authentication helpers — password hashing and token verification."""

import hashlib
import hmac
import secrets
from functools import wraps


SECRET_KEY = secrets.token_hex(32)


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    hashed = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
    return f"{salt}${hashed.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt, hashed = stored.split("$")
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
    return hmac.compare_digest(check.hex(), hashed)


def generate_token(user_id: int) -> str:
    payload = f"{user_id}:{secrets.token_hex(16)}"
    signature = hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{signature}"


def validate_token(token: str) -> int:
    parts = token.split(":")
    if len(parts) != 3:
        raise ValueError("Invalid token format")
    user_id, nonce, signature = parts
    expected = hmac.new(
        SECRET_KEY.encode(), f"{user_id}:{nonce}".encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise ValueError("Invalid token signature")
    return int(user_id)


def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        from flask import request, jsonify
        token = request.headers.get("Authorization", "").replace("Bearer ", "")
        if not token:
            return jsonify({"error": "Missing token"}), 401
        try:
            user_id = validate_token(token)
            kwargs["current_user_id"] = user_id
        except ValueError:
            return jsonify({"error": "Invalid token"}), 401
        return f(*args, **kwargs)
    return decorated
