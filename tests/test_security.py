import io
import uuid
from app.security.tokens import create_access_token
from datetime import timedelta

def create_user(client, prefix="sec_user"):
    unique = uuid.uuid4().hex[:8]
    username = f"{prefix}_{unique}"
    password = "SecurePassword123!"
    res = client.post("/api/auth/register", json={
        "username": username,
        "display_name": f"Security User {unique}",
        "password": password
    })
    data = res.json()
    return data["user"], data["access_token"]

def test_expired_token_rejection(client):
    u, token = create_user(client, "expired")
    # Generate token that is already expired
    expired_token = create_access_token({"sub": u["id"]}, expires_delta=timedelta(seconds=-10))

    res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {expired_token}"})
    assert res.status_code == 401
    assert "Invalid or expired" in res.json()["detail"]

def test_file_upload_and_download_permissions(client):
    u1, token1 = create_user(client, "alice_file")
    u2, token2 = create_user(client, "bob_file")
    u3, token3 = create_user(client, "eve_file")

    h1 = {"Authorization": f"Bearer {token1}"}
    h2 = {"Authorization": f"Bearer {token2}"}
    h3 = {"Authorization": f"Bearer {token3}"}

    # Alice creates conversation with Bob
    conv = client.post("/api/conversations", json={
        "type": "direct",
        "recipient_id": u2["id"]
    }, headers=h1).json()
    conv_id = conv["id"]

    # Alice uploads a test text file
    file_content = b"Venteda encrypted architectural specs"
    upload_res = client.post(
        f"/api/conversations/{conv_id}/attachments",
        files={"file": ("specs.txt", io.BytesIO(file_content), "text/plain")},
        data={"caption": "Security specs"},
        headers=h1
    )
    assert upload_res.status_code == 201
    msg_data = upload_res.json()
    assert len(msg_data["attachments"]) == 1
    attachment_id = msg_data["attachments"][0]["id"]

    # Bob (member of conversation) can download the file
    bob_dl = client.get(f"/api/attachments/{attachment_id}/download", headers=h2)
    assert bob_dl.status_code == 200
    assert bob_dl.content == file_content

    # Eve (unauthorized outsider) is blocked with 403 Forbidden
    eve_dl = client.get(f"/api/attachments/{attachment_id}/download", headers=h3)
    assert eve_dl.status_code == 403

def test_health_check_endpoint(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] in ["healthy", "degraded"]
    assert data["database"] == "ok"
