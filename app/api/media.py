"""Media gateway: the only way files under UPLOAD_DIR are served.

Public folders (avatars, group photos) are served without login, as they appear in the
member lists. Everything else is authorised per file:
  stories/<name>  -> visible viewers of the story (same rule as the story feed)
  saved/<name>    -> the owner of the saved GIF or sticker
  <name>          -> attachments and voice notes: members of the conversation only
Unknown or unauthorised files return 404 so that existence is not revealed.
"""
import os

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models.attachment import Attachment
from app.models.conversation import ConversationMember
from app.models.saved_media import SavedMedia
from app.models.story import Story
from app.services.auth_service import user_from_cookie
from app.services.story_service import can_view_story

router = APIRouter(tags=["media"])
PUBLIC_FOLDERS = {"avatars", "groups"}
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    "Cache-Control": "private, max-age=3600",
}


def _not_found():
    from fastapi import HTTPException, status
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found.")


@router.get("/media/{path:path}", include_in_schema=False)
def serve_media(path: str, request: Request, db: Session = Depends(get_db)):
    parts = [p for p in path.split("/") if p]
    if not parts or any(p in (".", "..") for p in parts) or "\\" in path:
        raise _not_found()
    root = os.path.realpath(settings.UPLOAD_DIR)
    full = os.path.realpath(os.path.join(root, *parts))
    if not full.startswith(root + os.sep) or not os.path.isfile(full):
        raise _not_found()

    folder = parts[0] if len(parts) > 1 else ""
    name = parts[-1]
    if folder in PUBLIC_FOLDERS:
        return FileResponse(full, headers=SECURITY_HEADERS)

    viewer = user_from_cookie(request, db)
    if viewer is None:
        raise _not_found()

    allowed = False
    if folder == "stories":
        story = db.query(Story).filter(Story.media_url.like(f"%/stories/{name}")).first()
        allowed = story is not None and can_view_story(db, viewer.id, story)
    elif folder == "saved":
        item = db.query(SavedMedia).filter(SavedMedia.file_url.like(f"%/saved/{name}")).first()
        allowed = item is not None and item.owner_id == viewer.id
    elif not folder:
        attachment = db.query(Attachment).filter(Attachment.file_name == name).first()
        if attachment is not None:
            allowed = db.query(ConversationMember.id).filter(
                ConversationMember.conversation_id == attachment.conversation_id,
                ConversationMember.user_id == viewer.id,
            ).first() is not None

    if not allowed:
        raise _not_found()
    return FileResponse(full, headers=SECURITY_HEADERS)


@router.get("/uploads/{path:path}", include_in_schema=False)
def legacy_uploads_redirect(path: str):
    """Old links saved in the database keep working: they are redirected to the gateway."""
    return RedirectResponse(url=f"/media/{path}", status_code=307)
