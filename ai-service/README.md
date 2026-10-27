# NyaySetu model service

Three scikit-learn models behind a Flask API. Called only by the Node backend, never by a browser.

```bash
python -m venv .venv
.venv\Scripts\activate            # source .venv/bin/activate on macOS / Linux
pip install -r requirements.txt

python train.py                   # writes models/, prints the metrics
python app.py                     # http://localhost:5001
```

Production: `waitress-serve --host=0.0.0.0 --port=$PORT app:app`

---

## Why this is a separate process

scikit-learn inference is CPU-bound. Running it inside the Express event loop would stall every other request for its duration, and the two services want different scaling profiles: the API is I/O-bound and wants many small instances, this is CPU-bound and wants fewer larger ones.

It also means the API degrades instead of failing. If this service is down, evidence intake still works and the UI says screening was **skipped** rather than silently claiming an item is clean.

---

## The models

### 1 · Evidence anomaly — Isolation Forest plus a rule layer

Runs at intake, **before** anything is anchored. Features: file size, the delta between the file's own modification time and the claimed collection time, whether an mtime was reported at all, the upload delay, the hour of day, and the offset from the jurisdiction centroid.

The rule layer is the part that matters. An Isolation Forest can say "this is unusual"; it cannot say why, and "the computer flagged it" is not something anyone should act on in a criminal matter. So `src/features.py` produces reasons a person can check:

- the file was last modified *after* the recorded collection time
- uploaded days late, leaving a long unsupervised window
- coordinates outside India, or null island
- too small to be a genuine capture of its declared type
- a collection timestamp in the future

A rule finding flags on its own. The forest adds the cases no single rule names, above a score threshold, so unexplainable outliers do not drown a reviewer in noise.

| Measured on the planted-anomaly set | Recall | Precision | F1 |
|---|---|---|---|
| Forest alone | 0.59 | 0.95 | 0.72 |
| **Forest + rules (what runs)** | **1.00** | **0.97** | **0.98** |

The verdict's canonical digest is anchored on chain by `anchorAnomalyFlag`, **write-once**. A flag raised at intake cannot be quietly removed later, by anyone.

### 2 · Bail violation risk — Random Forest classifier

Shown to a judge *before* bail is granted, not after. Features: offence severity, prior convictions, age, previous bail violations, past check-in consistency, typical daily movement, employment stability.

Outputs a band and a continuous score, plus plain-language drivers so the number is not the whole answer.

Three-class test accuracy is about 0.67. Bands are cut at the 45th and 80th percentiles of the synthetic latent score, which gives roughly 45 / 35 / 20 — percentiles rather than hand-picked thresholds, because a fixed cut against a hand-written latent score tends to leave one class nearly empty and a classifier trained on that learns almost nothing about it.

### 3 · Case delay — Gradient Boosting regressor

Features: offence severity, court backlog, witness count, evidence count, adjournments so far, whether bail was granted.

Test MAE about 69 days, R² about 0.82. Reported as a **range** derived from the spread of held-out residuals, because a single confident day count would imply precision the model does not have.

---

## The synthetic data question

All three models are trained on declared synthetic distributions, and `src/datasets.py` writes every one of them out in full.

Why not real data:

- **Evidence metadata** from live investigations is protected material with no lawful route to it.
- **Bail outcomes** linked to individuals are personal data under the DPDP Act 2023 and are not published in a linkable form.
- **NJDG** publishes aggregate pendency, not the per-case feature vectors a delay regressor needs. Where a real extract is available, `load_case_delay()` can be replaced by reading it; the feature contract is documented so the swap is one function.

Every API response carries `modelVersion`, which encodes `synthetic`, and `/metadata` returns the full training provenance including the distributions used.

**What this means for the claims:** these are decision support, not evidence. The anomaly detector's value is that its verdict is anchored and therefore cannot be quietly removed. The verdict itself is a prompt for a human to look, never a finding of tampering.

---

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Which models loaded, the version, the data source. No auth. |
| GET | `/metadata` | Full training provenance and metrics. |
| POST | `/predict/evidence-anomaly` | `{ anomaly, score, reasons[], modelSaysUnusual }` |
| POST | `/predict/bail-risk` | `{ band, score, probabilities, factors[] }` |
| POST | `/predict/case-delay` | `{ predictedDays, confidenceLow, confidenceHigh }` |
| POST | `/ocr/document?lang=eng` | Image body → `{ text, confidence, variant, improvement, proof }` |
| POST | `/ocr/plate` | Image body → `{ candidates[], confidence, proof }` |

Requests and responses are camelCase, matching `backend/src/lib/ai.ts`. Set `AI_SERVICE_KEY` and the service requires it as an `X-AI-KEY` header, compared with `hmac.compare_digest` so the check does not leak the key by timing.

A missing model artefact returns **503**, never a guess.

The two `/ocr` routes take the raw image as the body (or a multipart `image` field). Send `X-Expected-SHA256` and the service refuses (409) to read bytes that are not that digest.

---

## OCR

`src/ocr.py` reads text from photographed or scanned evidence (seizure memos, FIR copies, receipts, labels) and number plates. Phone photographs are tilted, shadowed and noisy, so each image is prepared before Tesseract sees it:

- **Document:** EXIF orientation, greyscale, rescale to ~2400 px, deskew by projection profile, then four variants (raw, shadow-flattened + CLAHE, Otsu, denoised adaptive threshold) read as a page (psm 3). The best is read again as a block (psm 6). The winner is the read with the most confidence-weighted characters, so a variant that is sure of one word does not beat one that reads the whole memo. `raw` is always one of the candidates, so the prepared result is never worse than an unprepared one.
- **Plate:** the plate is found (edges closed into blobs, filtered by plate aspect ratios). Up to three crops plus the whole frame are read as one line and as a block with a letters-and-digits whitelist, and each read is fitted to Indian formats with the same rules as the web app.

**Proof.** Every result carries `inputSha256` (the bytes read), `preprocessedSha256` (the winning prepared image), the pipeline steps and parameters, the engine version, `textSha256`, and `resultDigest` over all of these in canonical JSON. The digest is the same encoding as `packages/integrity`, so the Node API recomputes it, refuses any mismatch, and anchors it on chain (`POST /api/evidence/:id/ocr`, migration 015). The same image through the same pipeline and engine version gives the same digest.

```bash
pip install -r requirements.txt
# plus the Tesseract binary:
#   Windows  UB Mannheim installer (github.com/UB-Mannheim/tesseract/wiki), or set TESSERACT_CMD
#   Ubuntu   sudo apt install tesseract-ocr tesseract-ocr-hin tesseract-ocr-mar
#   macOS    brew install tesseract tesseract-lang

python ocr_evidence.py memo.jpg                          # text, confidence, proof
python ocr_evidence.py memo.jpg --expect-sha256 0x…      # refuse unless these are the registered bytes
python ocr_evidence.py car.jpg --mode plate
python ocr_evidence.py memo.jpg --json > reading.json
python ocr_evidence.py --verify reading.json             # recompute a saved reading's digest
python ocr_evidence.py --benchmark samples/              # raw Tesseract vs the prepared pipeline

python -m unittest discover -s tests                     # pipeline tests; no Tesseract needed
```

Without Tesseract the models still serve, `/health` reports `ocr.available: false` with the reason, and the `/ocr` routes answer 503 with what to install.

---

## Retraining

```bash
python train.py
```

Deterministic: the seed is fixed in `src/datasets.py`, so the numbers above reproduce exactly. Metrics are written to `models/metadata.json` alongside the distributions they came from.

`models/*.joblib` is git-ignored. It is reproducible from source, and there is no reason to carry ten megabytes of pickled forest in version control.
