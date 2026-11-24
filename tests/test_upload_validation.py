"""Focused tests for upload content-signature validation."""
import pytest
from fastapi import HTTPException

from app.security.file_signatures import sniff_family, validate_upload


def test_rejects_html_disguised_as_image():
    with pytest.raises(HTTPException) as exc:
        validate_upload(b"<!doctype html><script>alert(1)</script>", "image/jpeg", "avatar.jpg")
    assert exc.value.status_code == 400


def test_rejects_pdf_disguised_as_image():
    with pytest.raises(HTTPException) as exc:
        validate_upload(b"%PDF-1.7\n", "image/jpeg", "avatar.jpg")
    assert exc.value.status_code == 400


def test_accepts_supported_png_signature():
    data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
    assert sniff_family(data) == "image"
    validate_upload(data, "image/png", "avatar.png")


def test_accepts_plain_text_attachment():
    validate_upload(b"Venteda project notes", "text/plain", "notes.txt")


def test_accepts_audio_only_webm_container():
    # EBML identifies the WebM container; the declared audio/webm MIME identifies
    # the browser's audio-only MediaRecorder output.
    data = b"\x1a\x45\xdf\xa3" + b"\x00" * 16
    validate_upload(data, "audio/webm", "voice.webm")
