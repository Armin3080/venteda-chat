"""Safe upload handling with extension, content-signature, and size checks."""
import os
import uuid
from typing import Optional, Tuple

from fastapi import UploadFile, HTTPException, status

from app.core.config import settings
from app.security.file_signatures import sniff_family, validate_upload

ALLOWED_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".gif",
    ".pdf", ".txt", ".zip", ".json", ".doc", ".docx",
    ".mp3", ".mp4", ".webm", ".ogg", ".wav", ".m4a", ".aac",
}


def sanitize_filename(filename: str) -> str:
    """Keep a display-safe original filename; never use it as the disk filename."""
    base = os.path.basename((filename or "upload").replace("\\", "/"))
    clean = "".join(c for c in base if c.isalnum() or c in "._- ")
    return clean[:100] or "upload"


async def save_uploaded_file(
    file: UploadFile,
    *,
    expected_family: Optional[str] = None,
    max_size_bytes: Optional[int] = None,
) -> Tuple[str, str, int, str]:
    """Validate and stream an upload into UPLOAD_DIR. Returns stored name, original name, size, MIME."""
    original_name = sanitize_filename(file.filename or "upload")
    extension = os.path.splitext(original_name)[1].lower()
    if not extension or extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This file extension is not permitted.",
        )

    mime_type = (file.content_type or "application/octet-stream").split(";")[0].strip().lower()
    head = await file.read(64)
    await file.seek(0)
    validate_upload(head, mime_type, original_name)

    family = sniff_family(head)
    if expected_family:
        is_audio_webm = (
            expected_family == "audio"
            and extension == ".webm"
            and mime_type == "audio/webm"
            and family == "video"
        )
        if family != expected_family and not is_audio_webm:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Only {expected_family} files are allowed for this upload.",
            )
        if not mime_type.startswith(expected_family + "/"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"The uploaded file must declare a {expected_family} content type.",
            )

    limit = max_size_bytes or settings.MAX_UPLOAD_SIZE_BYTES
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}{extension}"
    destination = os.path.realpath(os.path.join(settings.UPLOAD_DIR, stored_name))
    root = os.path.realpath(settings.UPLOAD_DIR)
    if not destination.startswith(root + os.sep):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid file path.")

    size = 0
    try:
        with open(destination, "xb") as output:
            while chunk := await file.read(64 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"File exceeds the maximum allowed size of {limit // (1024 * 1024)} MB.",
                    )
                output.write(chunk)
    except Exception:
        try:
            os.remove(destination)
        except OSError:
            pass
        raise

    return stored_name, original_name, size, mime_type
