FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .
RUN mkdir -p /app/uploads \
    && useradd --create-home --uid 10001 appuser \
    && chown -R appuser /app
USER appuser

EXPOSE 3000
CMD ["python", "main.py", "--host", "0.0.0.0", "--port", "3000"]
