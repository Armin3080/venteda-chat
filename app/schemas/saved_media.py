from pydantic import BaseModel


class SavedMediaResponse(BaseModel):
    id: str
    file_url: str
    mime_type: str
    original_name: str
