"""Personal GIF and sticker collection.

Save from a file on this computer, or save a GIF/sticker that someone sent you
(the file is copied, so it stays available even if the original message is deleted).
Sending a saved item uses the normal attachment flow in the chat.
"""
import os
import shutil
import uuid
from typing import List

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models.attachment import Attachment
from app.models.saved_media import SavedMedia
from app.models.user import User
from app.schemas.saved_media import SavedMediaResponse
from app.services.auth_service import get_current_user
from app.services.chat_service import check_membership

router = APIRouter(prefix="/api/saved-media", tags=["saved-media"])

ALLOWED = {".gif": "image/gif", ".webp": "image/webp", ".png": "image/png", ".webm": "video/webm"}
MAX_BYTES = 5 * 1024 * 1024


def _saved_dir() -> str:
    path = os.path.join(settings.UPLOAD_DIR, "saved")
    os.makedirs(path, exist_ok=True)
    return path


def _to_response(item: SavedMedia) -> SavedMediaResponse:
    return SavedMediaResponse(id=item.id, file_url=item.file_url, mime_type=item.mime_type,
                              original_name=item.original_name)


def _store(db: Session, owner: User, source_path: str, ext: str, original_name: str) -> SavedMedia:
    name = f"saved_{uuid.uuid4().hex}{ext}"
    shutil.copyfile(source_path, os.path.join(_saved_dir(), name))
    item = SavedMedia(
        owner_id=owner.id,
        file_url=f"/media/saved/{name}",
        mime_type=ALLOWED[ext],
        original_name=(original_name or name)[:200],
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("", response_model=List[SavedMediaResponse])
def list_saved(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(SavedMedia).filter(SavedMedia.owner_id == current_user.id).order_by(
        SavedMedia.created_at.desc()).all()
    return [_to_response(r) for r in rows]


@router.post("", response_model=SavedMediaResponse, status_code=status.HTTP_201_CREATED)
async def save_from_file(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Only GIF, WebP, PNG or WebM files can be saved.")
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail="The file is too large (5MB maximum).")
    temp = os.path.join(_saved_dir(), f"tmp_{uuid.uuid4().hex}{ext}")
    with open(temp, "wb") as handle:
        handle.write(data)
    try:
        item = _store(db, current_user, temp, ext, file.filename)
    finally:
        os.remove(temp)
    return _to_response(item)


@router.post("/from-attachment/{attachment_id}", response_model=SavedMediaResponse,
             status_code=status.HTTP_201_CREATED)
def save_from_attachment(
    attachment_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    attachment = db.query(Attachment).filter(Attachment.id == attachment_id).first()
    if not attachment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found.")
    check_membership(attachment.conversation_id, current_user.id, db)
    ext = os.path.splitext(attachment.file_name or "")[1].lower()
    if ext not in ALLOWED:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Only GIF, WebP, PNG or WebM files can be saved.")
    source = os.path.join(settings.UPLOAD_DIR, attachment.file_name)
    if not os.path.isfile(source):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="The file is no longer available on the server.")
    item = _store(db, current_user, source, ext, attachment.original_name)
    return _to_response(item)


@router.delete("/{item_id}")
def delete_saved(item_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    item = db.query(SavedMedia).filter(SavedMedia.id == item_id, SavedMedia.owner_id == current_user.id).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found.")
    path = os.path.join(_saved_dir(), os.path.basename(item.file_url))
    db.delete(item)
    db.commit()
    try:
        os.remove(path)
    except OSError:
        pass
    return {"ok": True}
