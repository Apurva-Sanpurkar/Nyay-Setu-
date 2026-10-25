"""
Production entry point for the model service.

    python serve.py

WHY NOT `python app.py`
    That path calls Flask's development server, which says so on stderr every time
    it starts and is single-threaded. Two concurrent evidence uploads would queue
    behind each other for no reason.

WHY WAITRESS AND NOT GUNICORN
    Waitress is pure Python and runs on Windows as well as Linux, so the command
    that starts this service is the same on a developer's laptop and in a container.
    Gunicorn is fine on Linux and absent on Windows, which would mean two
    documented ways to start one service.

WHY ONE PROCESS AND FOUR THREADS
    The models are held in memory and total nearly forty megabytes. A second
    process would be a second copy, and a free container has 512MB. Threads share
    them, and scikit-learn's predict releases the GIL for the numeric work, so
    threads are where the concurrency actually comes from here.
"""

from __future__ import annotations

import os
import sys

from waitress import serve

from app import app, model_version, _load_error  # noqa: F401

# 0.0.0.0 rather than the 127.0.0.1 default: a container's port is published from
# outside it, and a service bound to loopback is unreachable however correct the
# platform's routing is. Locally this stays on loopback via HOST.
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "5001"))
THREADS = int(os.getenv("WEB_THREADS", "4"))


def main() -> None:
    if _load_error:
        # Not fatal, and deliberately not silent. The service still answers /health
        # so a platform can route to it, and every prediction route reports itself
        # unavailable — which is the honest answer and the one the API expects.
        print(f"\n  WARNING: models did not load: {_load_error}", file=sys.stderr)
        print("  Predictions will report themselves unavailable.\n", file=sys.stderr)

    print(f"  NyaySetu model service on http://{HOST}:{PORT}")
    print(f"  models: {model_version()}")
    print(f"  auth  : {'shared secret required' if os.getenv('AI_SERVICE_KEY', '').strip() else 'open (no AI_SERVICE_KEY set)'}")
    print(f"  serving with waitress, {THREADS} threads\n", flush=True)

    serve(app, host=HOST, port=PORT, threads=THREADS, ident="NyaySetu")


if __name__ == "__main__":
    main()
