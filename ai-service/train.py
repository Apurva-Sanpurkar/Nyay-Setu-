"""
Trains all three models and writes them to models/.

    python train.py

Deterministic: the same seed produces the same artefacts, so a viva can rerun
this and get the numbers printed in the report. Metrics land in
models/metadata.json alongside the declared distributions they came from.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import GradientBoostingRegressor, IsolationForest, RandomForestClassifier
from sklearn.metrics import (
    classification_report,
    mean_absolute_error,
    precision_recall_fscore_support,
    r2_score,
)
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).parent))

from src.datasets import (  # noqa: E402
    BAIL_BANDS,
    BAIL_FEATURES,
    DELAY_FEATURES,
    EVIDENCE_FEATURES,
    SEED,
    evidence_rule_flags,
    load_bail_risk,
    load_case_delay,
    load_evidence_anomaly,
    load_evidence_anomaly_eval,
)

MODELS = Path(__file__).parent / "models"
VERSION = "1.0.0-synthetic"


def banner(text: str) -> None:
    print(f"\n{'=' * 68}\n  {text}\n{'=' * 68}")


def train_evidence_anomaly() -> dict:
    banner("1/3  Evidence anomaly detection  (Isolation Forest)")

    frame = load_evidence_anomaly()
    print(f"  training rows      : {len(frame)} (all routine intake, unsupervised)")
    print(f"  features           : {', '.join(EVIDENCE_FEATURES)}")

    # Scaling matters here: upload_delay is in seconds (1e4) while mtime_missing
    # is 0 or 1, and Isolation Forest splits on raw values.
    scaler = StandardScaler().fit(frame.values)

    model = IsolationForest(
        n_estimators=400,
        # Routine intake is not perfectly clean, so allow a small share of the
        # training set to sit outside the learned envelope.
        contamination=0.05,
        max_samples=1024,
        random_state=SEED,
        n_jobs=-1,
    ).fit(scaler.transform(frame.values))

    # Calibrate the score mapping on the training scores, so the 0-1 number the
    # API returns means something stable across retrains.
    train_scores = model.decision_function(scaler.transform(frame.values))
    lo, hi = float(np.percentile(train_scores, 1)), float(np.percentile(train_scores, 99))

    eval_frame, labels = load_evidence_anomaly_eval()

    forest_flags = model.predict(scaler.transform(eval_frame.values)) == -1
    rule_flags = evidence_rule_flags(eval_frame)
    # What production actually does: a rule finding flags on its own, and the
    # forest adds the cases no rule names.
    combined = forest_flags | rule_flags

    f_precision, f_recall, f_f1, _ = precision_recall_fscore_support(
        labels, forest_flags.astype(int), average="binary", zero_division=0
    )
    c_precision, c_recall, c_f1, _ = precision_recall_fscore_support(
        labels, combined.astype(int), average="binary", zero_division=0
    )

    print(f"  forest alone       : recall {f_recall:.3f}  precision {f_precision:.3f}  f1 {f_f1:.3f}")
    print(f"  forest + rules     : recall {c_recall:.3f}  precision {c_precision:.3f}  f1 {c_f1:.3f}")
    print("  the second row is the pipeline that runs in production. The rules")
    print("  carry the explainable cases and give a reviewer something to check;")
    print("  the forest exists for combinations no single rule names.")

    joblib.dump(
        {"model": model, "scaler": scaler, "features": EVIDENCE_FEATURES, "score_lo": lo, "score_hi": hi},
        MODELS / "evidence_anomaly.joblib",
    )

    return {
        "algorithm": "IsolationForest + explainable rule layer",
        "features": EVIDENCE_FEATURES,
        "training_rows": len(frame),
        "contamination": 0.05,
        "forest_only": {
            "recall": round(float(f_recall), 4),
            "precision": round(float(f_precision), 4),
            "f1": round(float(f_f1), 4),
        },
        "forest_plus_rules": {
            "recall": round(float(c_recall), 4),
            "precision": round(float(c_precision), 4),
            "f1": round(float(c_f1), 4),
        },
        "score_calibration": {"p1": round(lo, 6), "p99": round(hi, 6)},
    }


def train_bail_risk() -> dict:
    banner("2/3  Bail violation risk  (Random Forest classifier)")

    frame, labels, (cut_low, cut_high) = load_bail_risk()
    x_train, x_test, y_train, y_test = train_test_split(
        frame.values, labels, test_size=0.2, random_state=SEED, stratify=labels
    )
    print(f"  training rows      : {len(x_train)}   test rows: {len(x_test)}")
    print(f"  features           : {', '.join(BAIL_FEATURES)}")
    print(f"  class balance      : {dict(zip(BAIL_BANDS, np.bincount(labels, minlength=3).tolist()))}")
    print(f"  band cut points    : LOW < {cut_low:.4f} <= MEDIUM < {cut_high:.4f} <= HIGH")

    model = RandomForestClassifier(
        n_estimators=400,
        max_depth=12,
        min_samples_leaf=8,
        class_weight="balanced",
        random_state=SEED,
        n_jobs=-1,
    ).fit(x_train, y_train)

    accuracy = model.score(x_test, y_test)
    print(f"  test accuracy      : {accuracy:.3f}\n")
    print(classification_report(y_test, model.predict(x_test), target_names=BAIL_BANDS, zero_division=0))

    importances = dict(
        sorted(
            zip(BAIL_FEATURES, (round(float(v), 4) for v in model.feature_importances_)),
            key=lambda kv: -kv[1],
        )
    )
    print(f"  feature importance : {importances}")

    joblib.dump(
        {"model": model, "features": BAIL_FEATURES, "bands": BAIL_BANDS},
        MODELS / "bail_risk.joblib",
    )

    return {
        "algorithm": "RandomForestClassifier",
        "features": BAIL_FEATURES,
        "bands": BAIL_BANDS,
        "band_cut_points": {"low_medium": round(cut_low, 5), "medium_high": round(cut_high, 5)},
        "band_derivation": "45th and 80th percentiles of the synthetic latent risk score",
        "training_rows": int(len(x_train)),
        "class_counts": dict(zip(BAIL_BANDS, np.bincount(labels, minlength=3).tolist())),
        "test_accuracy": round(float(accuracy), 4),
        "feature_importance": importances,
    }


def train_case_delay() -> dict:
    banner("3/3  Case delay prediction  (Gradient Boosting regressor)")

    frame, days = load_case_delay()
    x_train, x_test, y_train, y_test = train_test_split(
        frame.values, days, test_size=0.2, random_state=SEED
    )
    print(f"  training rows      : {len(x_train)}   test rows: {len(x_test)}")
    print(f"  features           : {', '.join(DELAY_FEATURES)}")
    print(f"  target range       : {days.min():.0f} to {days.max():.0f} days")

    model = GradientBoostingRegressor(
        n_estimators=400,
        learning_rate=0.05,
        max_depth=3,
        subsample=0.9,
        random_state=SEED,
    ).fit(x_train, y_train)

    predicted = model.predict(x_test)
    mae = mean_absolute_error(y_test, predicted)
    r2 = r2_score(y_test, predicted)
    # The interval the API reports comes from the spread of held-out residuals,
    # not from an assumption about the model.
    residual_std = float(np.std(y_test - predicted))

    print(f"  test MAE           : {mae:.1f} days")
    print(f"  test R2            : {r2:.3f}")
    print(f"  residual sigma     : {residual_std:.1f} days  (drives the confidence band)")

    joblib.dump(
        {"model": model, "features": DELAY_FEATURES, "residual_std": residual_std},
        MODELS / "case_delay.joblib",
    )

    return {
        "algorithm": "GradientBoostingRegressor",
        "features": DELAY_FEATURES,
        "training_rows": int(len(x_train)),
        "test_mae_days": round(float(mae), 2),
        "test_r2": round(float(r2), 4),
        "residual_std_days": round(residual_std, 2),
    }


def main() -> None:
    MODELS.mkdir(parents=True, exist_ok=True)
    started = time.time()

    metadata = {
        "version": VERSION,
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "seed": SEED,
        "data_source": "synthetic",
        "data_source_note": (
            "All three models are trained on declared synthetic distributions. Real evidence "
            "metadata, bail outcomes and per-case NJDG features are not lawfully available to "
            "this project. See src/datasets.py for every distribution. Outputs are decision "
            "support, never a finding of fact."
        ),
        "models": {
            "evidence_anomaly": train_evidence_anomaly(),
            "bail_risk": train_bail_risk(),
            "case_delay": train_case_delay(),
        },
    }

    (MODELS / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    banner(f"Done in {time.time() - started:.1f}s")
    print(f"  artefacts in {MODELS}")
    for name in sorted(os.listdir(MODELS)):
        print(f"    {name}")
    print("\n  next: python app.py\n")


if __name__ == "__main__":
    main()
