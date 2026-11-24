"""Content checks for uploads: the declared MIME type and extension are not trusted.

We look at the first bytes of the file (magic numbers). This is not an antivirus scan:
it blocks disguised executables, scripts and HTML, and mismatched media types.
"""
from typing import Optional

from fastapi import HTTPException, status

BLOCKED_EXTENSIONS = {
    ".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".msi", ".ps1", ".vbs", ".js", ".jse",
    ".sh", ".bin", ".jar", ".php", ".py", ".pl", ".html", ".htm", ".xhtml", ".svg", ".xml",
}


def sniff_family(head: bytes) -> Optional[str]:
    """Returns 'image', 'video', 'audio', 'pdf', 'archive', 'executable' or None if unknown."""
    if head.startswith((b"MZ", b"\x7fELF", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa")):
        return "executable"
    if head.startswith(b"#!"):
        return "executable"
    if head[:3].lower() in (b"<!d", b"<ht", b"<sv", b"<?x") or head.lstrip()[:1] == b"<":
        return "executable"  # HTML / SVG / XML can run script in the browser
    if head.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a")):
        return "image"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image"
    if head[:4] == b"\x1a\x45\xdf\xa3":          # EBML: WebM / Matroska
        return "video"
    if len(head) >= 12 and head[4:8] == b"ftyp":     # MP4 / MOV family
        return "video"
    if head.startswith(b"%PDF"):
        return "pdf"
    if head.startswith((b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xf1", b"\xff\xf9")):
        return "audio"
    if head.startswith(b"OggS"):
        return "audio"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio"
    if head.startswith((b"PK\x03\x04", b"Rar!", b"7z\xbc\xaf")):
        return "archive"
    return None


def validate_upload(head: bytes, declared_mime: str, filename: str) -> None:
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if ext in BLOCKED_EXTENSIONS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="This file type is not allowed.")
    family = sniff_family(head)
    if family == "executable":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="This file type is not allowed.")
    declared = (declared_mime or "").split(";")[0].strip().lower()
    for media in ("image", "video", "audio"):
        if declared.startswith(media + "/") and family != media:
            # WebM is an EBML container and may carry either audio-only or video.
            if not (media == "audio" and declared == "audio/webm" and family == "video" and filename.lower().endswith(".webm")):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                    detail=f"The file content does not match its type ({media}).")
    if family in ("image", "video", "audio") and declared and not declared.startswith(family + "/"):
        is_audio_webm = family == "video" and declared == "audio/webm" and filename.lower().endswith(".webm")
        if not is_audio_webm:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="The file content does not match its declared type.")
    if family == "pdf" and declared and declared not in ("application/pdf", "application/octet-stream"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="The file content does not match its declared type.")
