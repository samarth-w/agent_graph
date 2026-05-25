"""Flask API — REST endpoints for users and posts."""

from flask import Flask, request, jsonify
from db import Database
from models import UserService, UserNotFoundError
from posts import PostService
from auth import require_auth, hash_password, verify_password


app = Flask(__name__)
db = Database("app.db")
user_service = UserService(db)
post_service = PostService(db, user_service)


@app.route("/health")
def health_check():
    return jsonify({"status": "ok"})


@app.route("/users", methods=["GET"])
def list_users():
    role = request.args.get("role")
    users = user_service.list_users(role)
    return jsonify(users)


@app.route("/users", methods=["POST"])
@require_auth
def create_user():
    data = request.get_json()
    hashed = hash_password(data["password"])
    user = user_service.create_user(data["name"], data["email"])
    return jsonify(user), 201


@app.route("/users/<int:user_id>", methods=["GET"])
def get_user(user_id):
    try:
        user = user_service.get_user(user_id)
        return jsonify(user)
    except UserNotFoundError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/users/<int:user_id>", methods=["DELETE"])
@require_auth
def delete_user(user_id):
    try:
        post_service.delete_posts_by_author(user_id)
        user_service.delete_user(user_id)
        return jsonify({"deleted": True})
    except UserNotFoundError as e:
        return jsonify({"error": str(e)}), 404


@app.route("/posts", methods=["GET"])
def list_posts():
    author_id = request.args.get("author_id", type=int)
    if author_id:
        posts = post_service.list_posts(author_id)
    else:
        posts = post_service.list_posts_with_authors()
    return jsonify(posts)


@app.route("/posts", methods=["POST"])
@require_auth
def create_post():
    data = request.get_json()
    post = post_service.create_post(data["title"], data["body"], data["author_id"])
    return jsonify(post), 201


@app.route("/posts/<int:post_id>", methods=["DELETE"])
@require_auth
def delete_post(post_id):
    post_service.delete_post(post_id)
    return jsonify({"deleted": True})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
