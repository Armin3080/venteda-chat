#!/usr/bin/env python3
"""
VENTEDA CHAT — Primary Application Entry Point
==============================================
Runs the complete Python-served web application including FastAPI backend,
real-time WebSockets, WebRTC signaling, Jinja2 templates, and REST APIs.

Usage:
    python main.py
    python main.py --port 3000 --host 0.0.0.0
    python main.py --bootstrap-owner --username owner --password SecretPassword123!
"""

import sys
import os

# Ensure project root is in Python module path
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

def check_dependencies():
    """Validates that all critical Python packages are installed."""
    missing = []
    required_packages = [
        ("fastapi", "fastapi"),
        ("uvicorn", "uvicorn"),
        ("sqlalchemy", "sqlalchemy"),
        ("pydantic", "pydantic"),
        ("pydantic_settings", "pydantic-settings"),
        ("jinja2", "jinja2"),
        ("multipart", "python-multipart"),
        ("email_validator", "email-validator"),
        ("bcrypt", "bcrypt"),
        ("jwt", "PyJWT"),
    ]
    for module_name, desc in required_packages:
        try:
            __import__(module_name)
        except ImportError:
            missing.append(f"  • {desc} (import name: {module_name})")

    if missing:
        print("\n" + "=" * 65)
        print("❌ VENTEDA CHAT STARTUP ERROR: Missing Python Dependencies")
        print("=" * 65)
        print("The following required packages are not yet installed:")
        for item in missing:
            print(item)
        print("\nTo install all required dependencies, run:")
        print("    pip install -r requirements.txt")
        print("=" * 65 + "\n")
        sys.exit(1)

def print_banner(host: str, port: int):
    """Prints a clean startup banner with connection URLs."""
    display_host = "localhost" if host in ["0.0.0.0", "127.0.0.1"] else host
    print("\n" + "=" * 65)
    print("  🚀 VENTEDA CHAT v2.0 — Secure Real-Time Messaging Platform")
    print("  Inspired by Telegram Web Usability · C - LIGHT GLASS Design")
    print("=" * 65)
    print(f"  ▶ Web Application:        http://{display_host}:{port}")
    print(f"  ▶ Admin Control Center:   http://{display_host}:{port}/admin")
    print(f"  ▶ OpenAPI Documentation:  http://{display_host}:{port}/api/docs")
    print(f"  ▶ WebSocket Endpoint:     ws://{display_host}:{port}/ws")
    print(f"  ▶ Server Binding:         {host}:{port}")
    print("=" * 65)
    print("  Press Ctrl+C to gracefully stop the server.\n")

def main():
    check_dependencies()

    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(
        description="Venteda Chat — Complete Python Full-Stack Messaging Application"
    )
    # Support multiple --port or --host args for container/npm script compatibility
    parser.add_argument(
        "--port", "-p",
        type=int,
        nargs="*",
        default=[int(os.environ.get("PORT", "3000"))],
        help="Port to bind server (default: 3000 or env PORT)"
    )
    parser.add_argument(
        "--host", "-H",
        type=str,
        nargs="*",
        default=[os.environ.get("HOST", "0.0.0.0")],
        help="Host address to bind server (default: 0.0.0.0)"
    )
    parser.add_argument(
        "--reload", "-r",
        action="store_true",
        default=False,
        help="Enable auto-reload on code modifications"
    )
    parser.add_argument(
        "--bootstrap-owner",
        action="store_true",
        help="Bootstrap or upgrade the platform Owner account"
    )
    parser.add_argument("--username", "-u", default="owner", help="Owner username")
    parser.add_argument("--password", help="Owner password")
    parser.add_argument("--email", "-e", default="owner@venteda.io", help="Owner email")

    args, unknown = parser.parse_known_args()

    # Pick the last specified port and host
    selected_port = args.port[-1] if isinstance(args.port, list) else args.port
    selected_host = args.host[-1] if isinstance(args.host, list) else args.host

    # Handle owner bootstrap CLI mode
    if args.bootstrap_owner:
        if not args.password:
            print("Error: --password is required when using --bootstrap-owner")
            sys.exit(1)
        from app.cli.bootstrap_owner import bootstrap_owner
        try:
            bootstrap_owner(
                username=args.username,
                password=args.password,
                email=args.email
            )
        except ValueError as exc:
            print(f"Error: {exc}")
            sys.exit(1)
        return

    print_banner(selected_host, selected_port)

    # Launch Uvicorn with the FastAPI application
    uvicorn.run(
        "app.main:app",
        host=selected_host,
        port=selected_port,
        reload=args.reload,
        log_level="info",
        access_log=True
    )

if __name__ == "__main__":
    main()
