"""
Synthetic training data for the three NyaySetu models.

WHY SYNTHETIC
-------------
Real case data cannot be used, and pretending otherwise would be the single
most dishonest thing this project could do:

  * Evidence metadata from live investigations is protected material, and this
    project has no lawful route to it.
  * Bail outcome data linked to individuals is personal data under the DPDP Act
    2023 and is not published in a linkable form.
  * The National Judicial Data Grid publishes aggregate pendency, not the
    per-case feature vectors a delay regressor needs. Where a real NJDG extract
    is available, load_case_delay() can be replaced by reading it; the feature
    contract is documented so the swap is a single function.

So every generator below is a declared distribution, chosen to be realistic in
shape rather than accurate in fact. The distributions are written out in full so
a reviewer can judge what the models learned, and every API response carries
model_version, which encodes "synthetic".

WHAT THIS MEANS FOR THE CLAIMS
------------------------------
These models are decision support, not evidence. The anomaly detector's value
is that its verdict is anchored and therefore cannot be quietly removed; the
verdict itself is a prompt for a human to look, never a finding of tampering.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

SEED = 20260926

# Offence categories with a severity weight, used by two of the three models.
OFFENCE_SEVERITY = {
    "traffic": 0.1,
    "public nuisance": 0.15,
    "theft": 0.35,
    "burglary": 0.5,
    "cheating": 0.45,
    "cyber fraud": 0.5,
    "forgery": 0.45,
    "assault": 0.6,
    "aggravated burglary": 0.65,
    "narcotics": 0.75,
    "robbery": 0.8,
    "kidnapping": 0.85,
    "culpable homicide": 0.9,
    "murder": 1.0,
}


def severity_of(offence_type: str) -> float:
    """Maps free text to a severity weight, falling back to the middle."""
    if not offence_type:
        return 0.5
    key = offence_type.strip().lower()
    if key in OFFENCE_SEVERITY:
        return OFFENCE_SEVERITY[key]
    # Substring match, so "aggravated burglary with assault" still lands well.
    for name, weight in sorted(OFFENCE_SEVERITY.items(), key=lambda kv: -len(kv[0])):
        if name in key:
            return weight
    return 0.5


# ===========================================================================
# 1. Evidence anomaly detection  (unsupervised, Isolation Forest)
# ===========================================================================

EVIDENCE_FEATURES = [
    "log_size",            # ln(1 + bytes). Size spans photos to bodycam video.
    "mtime_delta_seconds", # claimed collection time minus the file's own mtime
    "mtime_missing",       # 1 when the device reported no mtime at all
    "upload_delay_seconds",# collection to upload. Long delays invite editing.
    "hour_of_day",         # 0-23, for the "3 a.m. upload" pattern
    "lat_offset",          # degrees from the Maharashtra centroid
    "lng_offset",
]


def load_evidence_anomaly(n: int = 6000) -> pd.DataFrame:
    """
    Normal evidence intake, for an unsupervised detector.

    Isolation Forest learns the shape of routine intake and calls everything far
    from it unusual, so the training set is deliberately clean. Declared
    distributions:

      size            log-normal, median ~1.5 MB, from phone photos to video
      mtime delta     0 to 600 s: a file is written at, or just before, the
                      moment the officer records as collection
      upload delay    exponential, mean 45 min, capped at 12 h: field officers
                      upload when they regain signal
      hour of day     bimodal, heavier in daylight and the early evening
      location        normal around Maharashtra, sigma ~1.2 degrees
    """
    rng = np.random.default_rng(SEED)

    log_size = rng.normal(np.log(1_500_000), 1.1, n)
    mtime_delta = rng.uniform(0, 600, n)
    mtime_missing = rng.binomial(1, 0.06, n).astype(float)
    # A missing mtime carries no delta, so zero it rather than leaving noise.
    mtime_delta = np.where(mtime_missing == 1, 0.0, mtime_delta)

    upload_delay = np.minimum(rng.exponential(2700, n), 43_200)

    daylight = rng.normal(13, 3.2, int(n * 0.7))
    evening = rng.normal(20, 1.8, n - int(n * 0.7))
    hour = np.clip(np.concatenate([daylight, evening]), 0, 23)
    rng.shuffle(hour)

    lat_offset = rng.normal(0, 1.2, n)
    lng_offset = rng.normal(0, 1.2, n)

    return pd.DataFrame(
        {
            "log_size": log_size,
            "mtime_delta_seconds": mtime_delta,
            "mtime_missing": mtime_missing,
            "upload_delay_seconds": upload_delay,
            "hour_of_day": hour,
            "lat_offset": lat_offset,
            "lng_offset": lng_offset,
        }
    )[EVIDENCE_FEATURES]


def load_evidence_anomaly_eval(n: int = 600) -> tuple[pd.DataFrame, np.ndarray]:
    """
    A labelled evaluation set: half routine, half with a planted problem.

    Used only to report recall at train time. The model never sees the labels,
    because it is unsupervised.
    """
    rng = np.random.default_rng(SEED + 1)
    normal = load_evidence_anomaly(n // 2)

    m = n - n // 2
    # Each anomalous row gets one of four plausible tampering signatures.
    kind = rng.integers(0, 4, m)

    log_size = rng.normal(np.log(1_500_000), 1.1, m)
    mtime_delta = rng.uniform(0, 600, m)
    mtime_missing = np.zeros(m)
    upload_delay = np.minimum(rng.exponential(2700, m), 43_200)
    hour = np.clip(rng.normal(13, 3.2, m), 0, 23)
    lat_offset = rng.normal(0, 1.2, m)
    lng_offset = rng.normal(0, 1.2, m)

    # 0: file modified well after the claimed collection time
    mtime_delta = np.where(kind == 0, rng.uniform(-86_400 * 14, -3600, m), mtime_delta)
    # 1: uploaded days later, leaving a long unsupervised window
    upload_delay = np.where(kind == 1, rng.uniform(86_400 * 4, 86_400 * 30, m), upload_delay)
    # 2: coordinates nowhere near the jurisdiction
    lat_offset = np.where(kind == 2, rng.uniform(15, 45, m) * rng.choice([-1, 1], m), lat_offset)
    lng_offset = np.where(kind == 2, rng.uniform(15, 45, m) * rng.choice([-1, 1], m), lng_offset)
    # 3: implausibly tiny file for a photo or video
    log_size = np.where(kind == 3, rng.normal(np.log(900), 0.4, m), log_size)

    anomalous = pd.DataFrame(
        {
            "log_size": log_size,
            "mtime_delta_seconds": mtime_delta,
            "mtime_missing": mtime_missing,
            "upload_delay_seconds": upload_delay,
            "hour_of_day": hour,
            "lat_offset": lat_offset,
            "lng_offset": lng_offset,
        }
    )[EVIDENCE_FEATURES]

    frame = pd.concat([normal, anomalous], ignore_index=True)
    labels = np.concatenate([np.zeros(len(normal)), np.ones(len(anomalous))])
    return frame, labels


# ===========================================================================
# 2. Bail violation risk  (supervised, Random Forest classifier)
# ===========================================================================

BAIL_FEATURES = [
    "offence_severity",
    "prior_convictions",
    "age_years",
    "previous_bail_violations",
    "check_in_consistency",   # 0-1, share of past check-ins filed on time
    "movement_radius_km",     # typical daily movement
    "employment_stable",      # 0 or 1
]

BAIL_BANDS = ["LOW", "MEDIUM", "HIGH"]


def load_bail_risk(n: int = 9000) -> tuple[pd.DataFrame, np.ndarray, tuple[float, float]]:
    """
    Labelled bail risk.

    The label comes from a declared latent score plus noise, so the model is
    learning a relationship we wrote down rather than one discovered in data.
    That is stated plainly because it bounds what the output can be used for.

    Latent score:
        0.30 * offence severity
      + 0.20 * prior convictions          (saturating at 4)
      + 0.25 * previous bail violations   (saturating at 3)
      + 0.15 * check-in INconsistency     (1 - consistency)
      + 0.10 * movement radius            (saturating at 50 km)
      - 0.08 * stable employment
      - 0.06 * age above 35               (older cohorts violate less here)
      + N(0, 0.07) noise

    Banded at the 45th and 80th percentiles of that distribution, giving roughly
    45% LOW / 35% MEDIUM / 20% HIGH. Percentiles rather than fixed cut points on
    purpose: a hand-picked threshold against a hand-written latent score tends to
    leave one class nearly empty, and a classifier trained on that learns almost
    nothing about it. The two cut points are returned in the metadata so a
    reviewer can see exactly where the bands fall.
    """
    rng = np.random.default_rng(SEED + 2)

    offences = list(OFFENCE_SEVERITY.values())
    severity = rng.choice(offences, n)
    priors = rng.poisson(0.8, n).clip(0, 12)
    age = rng.normal(32, 9, n).clip(18, 75)
    violations = rng.poisson(0.35, n).clip(0, 8)
    consistency = rng.beta(6, 2, n)
    radius = rng.gamma(2.0, 6.0, n).clip(0, 400)
    employed = rng.binomial(1, 0.62, n)

    latent = (
        0.30 * severity
        + 0.20 * np.minimum(priors, 4) / 4
        + 0.25 * np.minimum(violations, 3) / 3
        + 0.15 * (1.0 - consistency)
        + 0.10 * np.minimum(radius, 50) / 50
        - 0.08 * employed
        - 0.06 * np.clip((age - 35) / 40, 0, 1)
        + rng.normal(0, 0.07, n)
    )

    cut_low, cut_high = np.percentile(latent, [45, 80])
    labels = np.digitize(latent, [cut_low, cut_high])

    frame = pd.DataFrame(
        {
            "offence_severity": severity,
            "prior_convictions": priors,
            "age_years": age,
            "previous_bail_violations": violations,
            "check_in_consistency": consistency,
            "movement_radius_km": radius,
            "employment_stable": employed,
        }
    )[BAIL_FEATURES]

    return frame, labels, (float(cut_low), float(cut_high))


# ===========================================================================
# 3. Case delay  (supervised, Gradient Boosting regressor)
# ===========================================================================

DELAY_FEATURES = [
    "offence_severity",
    "court_backlog",
    "witness_count",
    "evidence_count",
    "adjournments_so_far",
    "bail_granted",
]


def load_case_delay(n: int = 9000) -> tuple[pd.DataFrame, np.ndarray]:
    """
    Days from registration to disposal.

    NJDG publishes pendency in aggregate, not per-case features, so this is a
    declared model of the relationship rather than a fit to published data. The
    baseline and the coefficients are chosen to land in the range NJDG aggregate
    pendency implies for district criminal matters, roughly one to four years.

        days = 180
              + 420 * severity
              + 0.055 * backlog
              + 22 * witnesses
              + 6 * evidence items
              + 48 * adjournments
              + 90 if bail was granted     (no custody pressure to list early)
              + N(0, 85)

    To use a real extract instead, return the same columns from it; nothing
    downstream depends on how this frame was produced.
    """
    rng = np.random.default_rng(SEED + 3)

    severity = rng.choice(list(OFFENCE_SEVERITY.values()), n)
    backlog = rng.gamma(4.0, 900.0, n).clip(50, 40_000)
    witnesses = rng.poisson(4.5, n).clip(0, 60)
    evidence = rng.poisson(9.0, n).clip(0, 300)
    adjournments = rng.poisson(3.0, n).clip(0, 60)
    bail = rng.binomial(1, 0.55, n)

    days = (
        180
        + 420 * severity
        + 0.055 * backlog
        + 22 * witnesses
        + 6 * evidence
        + 48 * adjournments
        + 90 * bail
        + rng.normal(0, 85, n)
    ).clip(30, 4000)

    frame = pd.DataFrame(
        {
            "offence_severity": severity,
            "court_backlog": backlog,
            "witness_count": witnesses,
            "evidence_count": evidence,
            "adjournments_so_far": adjournments,
            "bail_granted": bail,
        }
    )[DELAY_FEATURES]

    return frame, days


def evidence_rule_flags(frame: pd.DataFrame) -> np.ndarray:
    """
    The rule layer of src/features.py, expressed over the feature frame.

    Kept here so train.py can report the recall of the pipeline that actually
    runs in production, rather than of the forest alone. The thresholds mirror
    features.py exactly; if one changes, both must.
    """
    modified_after = frame["mtime_delta_seconds"].to_numpy() < -60
    stale = frame["mtime_delta_seconds"].to_numpy() > 30 * 86_400
    slow_upload = frame["upload_delay_seconds"].to_numpy() > 72 * 3600
    # features.py rejects anything outside India; from the Maharashtra centroid
    # that is roughly 14 degrees of latitude or 8 of longitude.
    off_map = (np.abs(frame["lat_offset"].to_numpy()) > 14.0) | (
        np.abs(frame["lng_offset"].to_numpy()) > 8.0
    )
    tiny = frame["log_size"].to_numpy() < np.log1p(8_000)

    return modified_after | stale | slow_upload | off_map | tiny
