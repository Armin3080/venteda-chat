import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import text
from app.core.database import get_db
from app.core.config import settings
from app.websocket.manager import manager

router = APIRouter(prefix="/api/health", tags=["health"])
logger = logging.getLogger("venteda.health")

@router.get("")
def health_check(db: Session = Depends(get_db)):
    db_status = "ok"
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        logger.exception("Health check database probe failed")
        db_status = "unhealthy"

    return {
        "status": "healthy" if db_status == "ok" else "degraded",
        "app_name": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "database": db_status,
        "active_ws_users": len(manager.active_users)
    }
