"""Story rules: who can see what, media validation, and 24-hour expiry."""
import os
import uuid
from datetime import datetime, timedelta
from typing import List

from fastapi import HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from sqlalchemy import inspect, text

from app.core.config import settings
from app.core.database import engine
from app.models.contact import UserContact
from app.models.conversation import Conversation, ConversationMember
from app.models.story import Story, StoryView
from app.security.file_signatures import sniff_family, validate_upload

STORY_TTL = timedelta(hours=24)
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_VIDEO_BYTES = 50 * 1024 * 1024


def _saved_by(db: Session, owner: str, target: str) -> bool:
    return db.query(UserContact.id).filter(
        UserContact.owner_id == owner,
        UserContact.target_id == target,
        UserContact.is_saved.is_(True),
    ).first() is not None


def direct_partner_ids(db: Session, user: str) -> List[str]:
    """Everyone the user has a one-to-one chat with."""
    conv_ids = [r[0] for r in db.query(ConversationMember.conversation_id).filter(
        ConversationMember.user_id == user).all()]
    if not conv_ids:
        return []
    direct_ids = [r[0] for r in db.query(Conversation.id).filter(
        Conversation.id.in_(conv_ids), Conversation.type == "direct").all()]
    if not direct_ids:
        return []
    rows = db.query(ConversationMember.user_id).filter(
        ConversationMember.conversation_id.in_(direct_ids),
        ConversationMember.user_id != user).all()
    return list({r[0] for r in rows})


def sees_author(db: Session, viewer: str, author: str) -> bool:
    """Visible to: the author, anyone the viewer saved, and anyone with a one-to-one chat with the author."""
    return viewer == author or _saved_by(db, viewer, author) or author in direct_partner_ids(db, viewer)


def followers_of(db: Session, author: str) -> List[str]:
    """Audience for new stories: people who saved the author plus direct-chat partners."""
    saved_by = [r[0] for r in db.query(UserContact.owner_id).filter(
        UserContact.target_id == author, UserContact.is_saved.is_(True)).all()]
    return list(set(saved_by) | set(direct_partner_ids(db, author)))


def visible_author_ids(db: Session, viewer: str) -> List[str]:
    """Authors shown in the viewer's stories bar: saved contacts plus direct-chat partners."""
    saved = [r[0] for r in db.query(UserContact.target_id).filter(
        UserContact.owner_id == viewer, UserContact.is_saved.is_(True)).all()]
    return list(set(saved) | set(direct_partner_ids(db, viewer)))


def active_query(db: Session):
    return db.query(Story).filter(Story.expires_at > datetime.utcnow())


def media_exists(media_url: str) -> bool:
    """False when the file is gone (e.g. ephemeral disk wiped on redeploy); such stories are hidden."""
    path = os.path.join(settings.UPLOAD_DIR, "stories", os.path.basename(media_url or ""))
    return os.path.isfile(path)


def remove_story_media(media_url: str) -> None:
    path = os.path.join(settings.UPLOAD_DIR, "stories", os.path.basename(media_url or ""))
    try:
        os.remove(path)
    except OSError:
        pass


def visible_stories_query(db: Session, viewer: str, author: str):
    """Active stories of author that viewer may see: all of them for contacts who saved each other,
    otherwise only the platform-wide stories published by staff."""
    query = active_query(db).filter(Story.author_id == author)
    if author == viewer or sees_author(db, viewer, author):
        return query
    return query.filter(Story.is_platform.is_(True))


def can_view_story(db: Session, viewer: str, story: Story) -> bool:
    return story.author_id == viewer or bool(story.is_platform) or sees_author(db, viewer, story.author_id)


def ensure_user_schema() -> None:
    """Adds the users.is_active column to databases created before it existed."""
    inspector = inspect(engine)
    if "users" not in inspector.get_table_names():
        return
    columns = {c["name"] for c in inspector.get_columns("users")}
    if "is_active" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE"))


def ensure_story_schema() -> None:
    """Adds columns introduced after a table was first created (create_all does not alter tables)."""
    inspector = inspect(engine)
    if "stories" not in inspector.get_table_names():
        return
    columns = {c["name"] for c in inspector.get_columns("stories")}
    if "is_platform" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE stories ADD COLUMN is_platform BOOLEAN NOT NULL DEFAULT FALSE"))


def delete_story(db: Session, story: Story) -> None:
    db.query(StoryView).filter(StoryView.story_id == story.id).delete(synchronize_session=False)
    remove_story_media(story.media_url)
    db.delete(story)
    db.commit()


def purge_expired(db: Session) -> None:
    expired = db.query(Story).filter(Story.expires_at <= datetime.utcnow()).all()
    for story in expired:
        delete_story(db, story)


async def save_story_media(file: UploadFile):
    """Validate story media by both extension and file signature before storing it."""
    ext = os.path.splitext(file.filename or "")[1].lower()
    declared = (file.content_type or "").split(";")[0].strip().lower()
    if ext in IMAGE_EXTENSIONS:
        media_type, limit = "image", MAX_IMAGE_BYTES
    elif ext in VIDEO_EXTENSIONS:
        media_type, limit = "video", MAX_VIDEO_BYTES
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only JPG, PNG, WebP, GIF, MP4, WebM, or MOV files are allowed.",
        )

    head = await file.read(64)
    await file.seek(0)
    validate_upload(head, declared, file.filename or "")
    family = sniff_family(head)
    if family != media_type:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The file content does not match the selected story media type.",
        )
    if declared and not declared.startswith(media_type + "/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The declared content type does not match the story media.",
        )

    dest_dir = os.path.join(settings.UPLOAD_DIR, "stories")
    os.makedirs(dest_dir, exist_ok=True)
    name = f"story_{uuid.uuid4().hex}{ext}"
    path = os.path.join(dest_dir, name)
    size = 0
    try:
        with open(path, "xb") as out:
            while chunk := await file.read(64 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail="The story media file is too large.",
                    )
                out.write(chunk)
    except Exception:
        try:
            os.remove(path)
        except OSError:
            pass
        raise
    return f"/media/stories/{name}", media_type
