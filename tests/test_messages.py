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

def test_message_lifecycle_and_security(client):
    u1, token1 = create_user(client, "alice")
    u2, token2 = create_user(client, "bob")
    u3, token3 = create_user(client, "eve")

    h1 = {"Authorization": f"Bearer {token1}"}
    h2 = {"Authorization": f"Bearer {token2}"}
    h3 = {"Authorization": f"Bearer {token3}"}

    # Alice creates conversation with Bob
    conv = client.post("/api/conversations", json={
        "type": "direct",
        "recipient_id": u2["id"]
    }, headers=h1).json()
    conv_id = conv["id"]

    # 1. Alice sends message
    client_msg_id = f"req_{uuid.uuid4().hex}"
    send_res = client.post(f"/api/conversations/{conv_id}/messages", json={
        "conversation_id": conv_id,
        "text": "Hello Bob! This is message #1",
        "client_msg_id": client_msg_id
    }, headers=h1)
    assert send_res.status_code == 201
    msg = send_res.json()
    msg_id = msg["id"]
    assert msg["text"] == "Hello Bob! This is message #1"

    # 2. Duplicate send prevention with same client_msg_id
    dup_res = client.post(f"/api/conversations/{conv_id}/messages", json={
        "conversation_id": conv_id,
        "text": "Hello Bob! This is message #1",
        "client_msg_id": client_msg_id
    }, headers=h1)
    assert dup_res.status_code == 201
    assert dup_res.json()["id"] == msg_id

    # 3. Bob can read messages
    get_res = client.get(f"/api/conversations/{conv_id}/messages", headers=h2)
    assert get_res.status_code == 200
    messages = get_res.json()
    assert len(messages) >= 1

    # 4. Eve (unauthorized) cannot read messages or send
    unauth_read = client.get(f"/api/conversations/{conv_id}/messages", headers=h3)
    assert unauth_read.status_code == 403

    unauth_send = client.post(f"/api/conversations/{conv_id}/messages", json={
        "conversation_id": conv_id,
        "text": "Intrusion attempt"
    }, headers=h3)
    assert unauth_send.status_code == 403

    # 5. Bob replies to Alice's message
    reply_res = client.post(f"/api/conversations/{conv_id}/messages", json={
        "conversation_id": conv_id,
        "text": "Hey Alice, I got your message!",
        "reply_to_id": msg_id
    }, headers=h2)
    assert reply_res.status_code == 201
    assert reply_res.json()["reply_to_id"] == msg_id

    # 6. Alice edits her message
    edit_res = client.put(f"/api/messages/{msg_id}", json={
        "text": "Hello Bob! This is edited message #1"
    }, headers=h1)
    assert edit_res.status_code == 200
    assert edit_res.json()["is_edited"] is True

    # 7. Bob cannot edit Alice's message (forbidden)
    bad_edit = client.put(f"/api/messages/{msg_id}", json={
        "text": "Bob trying to edit Alice message"
    }, headers=h2)
    assert bad_edit.status_code == 403

    # 8. Bob reacts with emoji
    react_res = client.post(f"/api/messages/{msg_id}/reactions", json={
        "emoji": "👍"
    }, headers=h2)
    assert react_res.status_code == 200
    assert any(r["emoji"] == "👍" for r in react_res.json()["reactions"])

    # 9. Read receipt
    read_res = client.post(f"/api/conversations/{conv_id}/read", headers=h2)
    assert read_res.status_code == 200
