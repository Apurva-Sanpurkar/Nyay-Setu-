"""
Turns the API request shapes into the exact feature vectors each model was
trained on, and produces the human-readable reasons that accompany a verdict.

The rule layer matters as much as the model. An Isolation Forest can say "this
is unusual"; it cannot say why, and "the computer flagged it" is not something
anyone should act on in a criminal matter. So every flag carries reasons a
person can check, and the reasons are part of the payload that gets hashed and
anchored on chain.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

from .datasets import BAIL_FEATURES, DELAY_FEATURES, EVIDENCE_FEATURES, severity_of

# Centroid of Maharashtra, the jurisdiction this deployment serves.
HOME_LAT = 19.75
HOME_LNG = 75.71

# India's bounding box, used for the "not in the country" rule.
INDIA_LAT = (6.0, 37.6)
INDIA_LNG = (68.0, 97.5)

# Smallest believable payload per media class, in bytes.
MIN_PLAUSIBLE_BYTES = {
    "image": 8_000,
    "video": 100_000,
    "audio": 8_000,
    "application": 512,
    "text": 32,
}


def _parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        text = str(value).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def evidence_vector(payload: dict[str, Any]) -> tuple[list[float], list[str]]:
    """
    Builds the Isolation Forest input and the rule-based reasons together, so
    the two can never describe different inputs.
    """
    size = float(payload.get("fileSizeBytes") or 0)
    mime = str(payload.get("mimeType") or "application/octet-stream")
    collected = _parse_time(payload.get("claimedCollectedAt"))
    mtime = _parse_time(payload.get("deviceReportedMtime"))
    lat = float(payload.get("gpsLat") or 0.0)
    lng = float(payload.get("gpsLng") or 0.0)
    upload_delay = float(payload.get("uploadDelaySeconds") or 0)

    now = datetime.now(timezone.utc)
    reasons: list[str] = []

    # --- mtime delta -------------------------------------------------------
    # Positive means the file was written before the recorded collection time,
    # which is normal. Negative means it changed afterwards, which is not.
    if mtime is None or collected is None:
        mtime_delta = 0.0
        mtime_missing = 1.0
        if collected is not None:
            reasons.append("The device reported no last-modified time for this file.")
    else:
        mtime_delta = (collected - mtime).total_seconds()
        mtime_missing = 0.0

        if mtime_delta < -60:
            hours = abs(mtime_delta) / 3600
            reasons.append(
                f"The file was last modified {hours:.1f} h AFTER the recorded collection time."
            )
        elif mtime_delta > 30 * 86_400:
            days = mtime_delta / 86_400
            reasons.append(
                f"The file predates the recorded collection time by {days:.0f} days."
            )

    # --- upload delay ------------------------------------------------------
    if upload_delay > 72 * 3600:
        reasons.append(
            f"Uploaded {upload_delay / 86_400:.1f} days after collection, "
            "leaving a long unsupervised window."
        )

    # --- timestamps --------------------------------------------------------
    if collected is None:
        reasons.append("The collection timestamp could not be read.")
        hour = 12.0
    else:
        hour = float(collected.hour)
        if collected > now:
            reasons.append("The collection timestamp is in the future.")

    # --- location ----------------------------------------------------------
    if lat == 0.0 and lng == 0.0:
        reasons.append("Coordinates are null island (0, 0): the GPS fix probably failed.")
    elif not (INDIA_LAT[0] <= lat <= INDIA_LAT[1] and INDIA_LNG[0] <= lng <= INDIA_LNG[1]):
        reasons.append(f"Coordinates ({lat:.4f}, {lng:.4f}) fall outside India.")

    # --- size --------------------------------------------------------------
    media_class = mime.split("/")[0].lower()
    floor = MIN_PLAUSIBLE_BYTES.get(media_class)
    if floor is not None and 0 < size < floor:
        reasons.append(
            f"At {int(size)} bytes the file is too small to be a genuine {media_class} capture."
        )
    if size == 0:
        reasons.append("The file is empty.")

    vector = [
        math.log1p(max(size, 0.0)),
        mtime_delta,
        mtime_missing,
        upload_delay,
        hour,
        lat - HOME_LAT,
        lng - HOME_LNG,
    ]
    assert len(vector) == len(EVIDENCE_FEATURES)
    return vector, reasons


def bail_vector(payload: dict[str, Any]) -> list[float]:
    vector = [
        severity_of(str(payload.get("offenceType") or "")),
        float(payload.get("priorConvictions") or 0),
        float(payload.get("ageYears") or 30),
        float(payload.get("previousBailViolations") or 0),
        float(payload.get("checkInConsistency") if payload.get("checkInConsistency") is not None else 1.0),
        float(payload.get("movementRadiusKm") or 0),
        1.0 if payload.get("employmentStable") else 0.0,
    ]
    assert len(vector) == len(BAIL_FEATURES)
    return vector


def bail_factors(payload: dict[str, Any]) -> list[str]:
    """
    Plain-language drivers, so a judge sees what moved the score rather than
    only the number. Thresholds are the cohort medians from the training
    distribution in datasets.py.
    """
    factors: list[str] = []

    severity = severity_of(str(payload.get("offenceType") or ""))
    priors = float(payload.get("priorConvictions") or 0)
    violations = float(payload.get("previousBailViolations") or 0)
    consistency = float(
        payload.get("checkInConsistency") if payload.get("checkInConsistency") is not None else 1.0
    )
    radius = float(payload.get("movementRadiusKm") or 0)
    employed = bool(payload.get("employmentStable"))
    age = float(payload.get("ageYears") or 30)

    if severity >= 0.75:
        factors.append("Offence category carries high severity weight.")
    elif severity <= 0.3:
        factors.append("Offence category carries low severity weight.")

    if violations >= 1:
        factors.append(f"{int(violations)} previous bail violation(s) on record.")
    if priors >= 2:
        factors.append(f"{int(priors)} prior conviction(s).")
    if consistency < 0.7:
        factors.append(f"Past check-in consistency is {consistency:.0%}.")
    elif consistency >= 0.95:
        factors.append("Past check-in record is near perfect.")
    if radius > 50:
        factors.append(f"Typical daily movement of {radius:.0f} km is wide for a geo-fence.")
    if employed:
        factors.append("Stable employment is a stabilising factor.")
    if age >= 45:
        factors.append("Age cohort is associated with lower violation rates in the training data.")

    if not factors:
        factors.append("No individual factor stands out; the score reflects the combination.")
    return factors


def delay_vector(payload: dict[str, Any]) -> list[float]:
    vector = [
        severity_of(str(payload.get("offenceType") or "")),
        float(payload.get("courtBacklog") or 0),
        float(payload.get("witnessCount") or 0),
        float(payload.get("evidenceCount") or 0),
        float(payload.get("adjournmentsSoFar") or 0),
        1.0 if payload.get("isBailGranted") else 0.0,
    ]
    assert len(vector) == len(DELAY_FEATURES)
    return vector
