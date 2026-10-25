"""
NyaySetu model service.

Three endpoints, one per model, all called by the Node API and never by a
browser. Inference lives out of process on purpose: scikit-learn prediction is
CPU-bound, and running it inside the API's event loop would stall every other
request for the duration.

    python train.py        # once, to produce models/
    python app.py          # development
    waitress-serve --port=5001 app:app     # production

Contract notes:
  * requests and responses are camelCase, matching backend/src/lib/ai.ts
  * a missing model artefact returns 503, never a guess
  * every response carries modelVersion, which encodes "synthetic"
"""

from __future__ import annotations

import hmac
import os
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from dotenv import load_dotenv
from flask import Flask, jsonify, request

from src.features import bail_factors, bail_vector, delay_vector, evidence_vector

load_dotenv()

MODELS = Path(__file__).parent / "models"
API_KEY = os.getenv("AI_SERVICE_KEY", "").strip()
PORT = int(os.getenv("PORT", "5001"))
HOST = os.getenv("HOST", "127.0.0.1")

# Isolation Forest calls it unusual; we only call it a flag past this score, so
# routine-but-slightly-odd intake does not drown a reviewer in noise.
ANOMALY_SCORE_THRESHOLD = float(os.getenv("ANOMALY_SCORE_THRESHOLD", "0.62"))

app = Flask(__name__)

# No CORS layer at all, deliberately.
#
# The Node API is the only caller; nothing in a browser ever talks to this
# service. Sending no Access-Control-Allow-Origin header is therefore both
# correct and stronger than sending a restrictive one: with no header, no page
# on any origin can read a response from here, whatever it manages to send.
# It also drops flask-cors, which was the only dependency here carrying an
# open advisory.

_bundles: dict[str, Any] = {}
_metadata: dict[str, Any] = {}
_load_error: str | None = None


def load_models() -> None:
    global _load_error, _metadata
    try:
        _bundles["evidence_anomaly"] = joblib.load(MODELS / "evidence_anomaly.joblib")
        _bundles["bail_risk"] = joblib.load(MODELS / "bail_risk.joblib")
        _bundles["case_delay"] = joblib.load(MODELS / "case_delay.joblib")
        metadata_path = MODELS / "metadata.json"
        if metadata_path.exists():
            import json

            _metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        _load_error = None
    except FileNotFoundError as error:
        _load_error = f"Model artefact missing: {error.filename}. Run `python train.py` first."
    except Exception as error:  # noqa: BLE001
        _load_error = f"Could not load models: {error}"


load_models()


def model_version() -> str:
    return _metadata.get("version", "unknown")


@app.before_request
def authenticate():
    """
    Shared-secret gate. Skipped for /health so an orchestrator can probe it, and
    skipped entirely when AI_SERVICE_KEY is unset, which is the local default.
    """
    if request.path == "/health" or request.method == "OPTIONS":
        return None
    if not API_KEY:
        return None

    supplied = request.headers.get("x-ai-key", "")
    # compare_digest rather than ==, so the check does not leak the key by timing.
    if not hmac.compare_digest(supplied, API_KEY):
        return jsonify({"error": "unauthorised"}), 401
    return None


def require_models():
    if _load_error:
        return jsonify({"error": _load_error}), 503
    return None


def body() -> dict[str, Any]:
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


@app.get("/health")
def health():
    return jsonify(
        {
            "status": "ok" if not _load_error else "degraded",
            "modelsLoaded": sorted(_bundles.keys()),
            "modelVersion": model_version(),
            "dataSource": _metadata.get("data_source", "unknown"),
            "error": _load_error,
        }
    ), (200 if not _load_error else 503)


@app.get("/metadata")
def metadata():
    """Full training provenance, including the declared distributions used."""
    guard = require_models()
    if guard:
        return guard
    return jsonify(_metadata)


@app.post("/predict/evidence-anomaly")
def predict_evidence_anomaly():
    guard = require_models()
    if guard:
        return guard

    payload = body()
    bundle = _bundles["evidence_anomaly"]
    vector, reasons = evidence_vector(payload)

    scaled = bundle["scaler"].transform(np.asarray([vector], dtype=float))
    raw = float(bundle["model"].decision_function(scaled)[0])

    # decision_function is higher for "normal". Invert and squash into 0-1 using
    # the percentiles captured at train time, so the number is comparable
    # between retrains.
    lo, hi = bundle["score_lo"], bundle["score_hi"]
    span = (hi - lo) or 1.0
    score = float(np.clip((hi - raw) / span, 0.0, 1.0))

    model_says_unusual = bool(bundle["model"].predict(scaled)[0] == -1)

    # A rule fired means a human can see exactly what is wrong, so it flags on
    # its own. The model alone flags only above the threshold, which keeps the
    # unexplainable cases from becoming noise.
    anomaly = bool(reasons) or (model_says_unusual and score >= ANOMALY_SCORE_THRESHOLD)

    if model_says_unusual and not reasons:
        reasons = [
            "The combination of size, timing and location is unlike routine intake, "
            "though no single field is individually implausible."
        ]
    if not anomaly and not reasons:
        reasons = ["Consistent with routine evidence intake."]

    return jsonify(
        {
            "anomaly": anomaly,
            "score": round(score, 5),
            "reasons": reasons,
            "modelSaysUnusual": model_says_unusual,
            "modelVersion": model_version(),
        }
    )


@app.post("/predict/bail-risk")
def predict_bail_risk():
    guard = require_models()
    if guard:
        return guard

    payload = body()
    bundle = _bundles["bail_risk"]
    vector = np.asarray([bail_vector(payload)], dtype=float)

    probabilities = bundle["model"].predict_proba(vector)[0]
    bands: list[str] = bundle["bands"]
    index = int(np.argmax(probabilities))

    # A single continuous risk number, so it can be sorted and thresholded:
    # full weight on HIGH, half on MEDIUM.
    score = float(probabilities[2] + 0.5 * probabilities[1]) if len(probabilities) == 3 else float(probabilities[index])

    return jsonify(
        {
            "band": bands[index],
            "score": round(min(max(score, 0.0), 1.0), 5),
            "probabilities": {band: round(float(p), 5) for band, p in zip(bands, probabilities)},
            "factors": bail_factors(payload),
            "modelVersion": model_version(),
        }
    )


@app.post("/predict/case-delay")
def predict_case_delay():
    guard = require_models()
    if guard:
        return guard

    payload = body()
    bundle = _bundles["case_delay"]
    vector = np.asarray([delay_vector(payload)], dtype=float)

    predicted = float(bundle["model"].predict(vector)[0])
    sigma = float(bundle["residual_std"])

    # Roughly a 95% band from the held-out residual spread. Reported as a range
    # because a single day count would imply precision the model does not have.
    low = max(0.0, predicted - 1.96 * sigma)
    high = predicted + 1.96 * sigma

    return jsonify(
        {
            "predictedDays": round(predicted, 1),
            "confidenceLow": round(low, 1),
            "confidenceHigh": round(high, 1),
            "residualStdDays": round(sigma, 1),
            "modelVersion": model_version(),
        }
    )


@app.errorhandler(400)
def bad_request(error):  # noqa: ANN001
    return jsonify({"error": "malformed request", "detail": str(error)}), 400


@app.errorhandler(500)
def server_error(error):  # noqa: ANN001
    app.logger.exception("Unhandled error")
    return jsonify({"error": "internal error"}), 500


if __name__ == "__main__":
    if _load_error:
        print(f"\n  WARNING: {_load_error}\n")
    print(f"  NyaySetu AI service on http://{HOST}:{PORT}")
    print(f"  model version: {model_version()}  |  auth: {'on' if API_KEY else 'off (local)'}\n")
    app.run(host=HOST, port=PORT, debug=False)
