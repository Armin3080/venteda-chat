# Contributing

Thanks for helping improve VENTEDA CHAT.

## Before you start

1. Open an issue for large changes so the scope can be discussed first.
2. Never include `.env`, credentials, real user data, database files, uploaded media, or private logs in a pull request.
3. Keep changes focused and preserve existing API contracts unless a breaking change is explicitly discussed.

## Development setup

```bash
python -m venv .venv
# Activate the environment, then:
pip install -r requirements-dev.txt
cp .env.example .env
```

Set a local `SECRET_KEY` in `.env`, then run:

```bash
python main.py
```

## Quality checks

```bash
python -m compileall -q app main.py
pytest -v
```

Add or update tests for behavior changes. Do not claim a test passed unless it was actually run.

## Pull requests

- Explain the problem and the approach.
- List relevant routes, models, templates, and frontend modules changed.
- Include screenshots for visual changes (real application captures, not mockups presented as captures).
- Note migration, environment, or deployment implications.
- Include test results and any checks that could not be performed.
