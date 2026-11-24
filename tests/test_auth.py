import uuid

from app.models.user import UserSession
from app.security.tokens import decode_access_token

def test_register_and_login(client):
    unique = uuid.uuid4().hex[:8]
    username = f"user_{unique}"
    password = "SecurePassword!9"

    # 1. Register
    reg_res = client.post("/api/auth/register", json={
        "username": username,
        "display_name": "Test User",
        "email": f"{username}@test.com",
        "password": password
    })
    assert reg_res.status_code == 201
    data = reg_res.json()
    assert "access_token" in data
    assert data["user"]["username"] == username

    # 2. Duplicate registration fails
    dup_res = client.post("/api/auth/register", json={
        "username": username,
        "display_name": "Duplicate",
        "password": password
    })
    assert dup_res.status_code == 400

    # 3. Login with correct credentials
    login_res = client.post("/api/auth/login", json={
        "username": username,
        "password": password
    })
    assert login_res.status_code == 200
    token = login_res.json()["access_token"]
    assert token is not None

    # 4. Login with invalid password fails
    bad_login = client.post("/api/auth/login", json={
        "username": username,
        "password": "WrongPassword!"
    })
    assert bad_login.status_code == 401

    # 5. Fetch /api/auth/me with Bearer token
    me_res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me_res.status_code == 200
    assert me_res.json()["username"] == username

    # 6. Fetch /api/auth/me without token fails with 401
    unauth_res = client.get("/api/auth/me")
    assert unauth_res.status_code == 401


def test_login_creates_persisted_session_and_logout_revokes_it(client, db_session):
    unique = uuid.uuid4().hex[:8]
    username = f"session_{unique}"
    password = "SecurePassword!9"
    registered = client.post("/api/auth/register", json={
        "username": username,
        "display_name": "Session Test",
        "password": password,
    })
    assert registered.status_code == 201
    token = registered.json()["access_token"]
    payload = decode_access_token(token)
    assert payload and payload.get("jti")

    session = db_session.query(UserSession).filter(UserSession.token_jti == payload["jti"]).first()
    assert session is not None
    assert session.is_revoked is False
    assert session.device_name

    logout = client.post("/api/auth/logout", headers={"Authorization": f"Bearer {token}"})
    assert logout.status_code == 200
    db_session.refresh(session)
    assert session.is_revoked is True

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 401
