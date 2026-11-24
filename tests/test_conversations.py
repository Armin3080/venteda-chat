import uuid

def create_user(client, prefix="user"):
    unique = uuid.uuid4().hex[:8]
    username = f"{prefix}_{unique}"
    password = "Password123!"
    res = client.post("/api/auth/register", json={
        "username": username,
        "display_name": f"Name {unique}",
        "password": password
    })
    data = res.json()
    return data["user"], data["access_token"]

def test_direct_conversation_authorization(client):
    u1, token1 = create_user(client, "user_a")
    u2, token2 = create_user(client, "user_b")
    u3, token3 = create_user(client, "user_c")

    headers1 = {"Authorization": f"Bearer {token1}"}
    headers2 = {"Authorization": f"Bearer {token2}"}
    headers3 = {"Authorization": f"Bearer {token3}"}

    # User 1 creates direct conversation with User 2
    create_res = client.post("/api/conversations", json={
        "type": "direct",
        "recipient_id": u2["id"]
    }, headers=headers1)
    assert create_res.status_code == 201
    conv = create_res.json()
    conv_id = conv["id"]

    # User 2 can view the conversation
    view_res = client.get(f"/api/conversations/{conv_id}", headers=headers2)
    assert view_res.status_code == 200

    # User 3 (unauthorized outsider) cannot view conversation
    unauth_view = client.get(f"/api/conversations/{conv_id}", headers=headers3)
    assert unauth_view.status_code == 403

def test_group_conversation_creation_and_membership(client):
    owner, owner_token = create_user(client, "owner")
    member, member_token = create_user(client, "member")
    outsider, outsider_token = create_user(client, "outsider")

    owner_h = {"Authorization": f"Bearer {owner_token}"}
    member_h = {"Authorization": f"Bearer {member_token}"}
    outsider_h = {"Authorization": f"Bearer {outsider_token}"}

    # Create group with member
    create_res = client.post("/api/conversations", json={
        "type": "group",
        "title": "Engineering Chat",
        "member_ids": [member["id"]]
    }, headers=owner_h)
    assert create_res.status_code == 201
    conv_id = create_res.json()["id"]

    # Member can view
    res = client.get(f"/api/conversations/{conv_id}", headers=member_h)
    assert res.status_code == 200

    # Outsider cannot view
    res = client.get(f"/api/conversations/{conv_id}", headers=outsider_h)
    assert res.status_code == 403

def test_saved_messages_conversation_isolation(client):
    u1, token1 = create_user(client, "user_saved1")
    u2, token2 = create_user(client, "user_saved2")

    h1 = {"Authorization": f"Bearer {token1}"}
    h2 = {"Authorization": f"Bearer {token2}"}

    # Fetch/create saved messages for user 1
    res1 = client.get("/api/conversations/saved", headers=h1)
    assert res1.status_code == 200
    saved1 = res1.json()
    assert saved1["type"] == "saved"
    assert saved1["title"] == "Saved Messages"

    # Fetch again, must be idempotent
    res1_again = client.get("/api/conversations/saved", headers=h1)
    assert res1_again.status_code == 200
    assert res1_again.json()["id"] == saved1["id"]

    # Post a message to saved messages
    msg_res = client.post(f"/api/conversations/{saved1['id']}/messages", json={
        "conversation_id": saved1["id"],
        "text": "My private saved notes and links"
    }, headers=h1)
    assert msg_res.status_code == 201

    # User 2 cannot access user 1's saved messages
    unauth = client.get(f"/api/conversations/{saved1['id']}", headers=h2)
    assert unauth.status_code == 403

