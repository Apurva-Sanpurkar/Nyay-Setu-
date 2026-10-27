"""
Evidence OCR: reading the text in a photograph of a document or a number plate,
tuned for the pictures officers actually take, and provable afterwards.

WHY NOT JUST CALL TESSERACT
  A phone photograph of a seizure memo, an FIR copy or a plate is not what an
  OCR engine is built for: it is tilted, shadowed by the officer's own hand,
  unevenly lit, noisy in low light, and often small. Fed straight in, Tesseract
  returns low-confidence fragments. So every image goes through a small,
  deterministic pipeline first, and several prepared variants are read; the one
  that yields the most confident text wins.

  Document:  EXIF orientation -> greyscale -> rescale -> deskew (projection
             profile) -> then four variants:
               raw        the greyscale as it is (the baseline, so optimising
                          can never do worse than not optimising)
               flattened  shadow removal (background division) + CLAHE
               otsu       flattened, then a global Otsu threshold
               adaptive   denoised, then a local (Gaussian) threshold
             each read as an automatic page layout (psm 3), and the winner read
             again as a uniform block (psm 6), keeping whichever scored higher.

  Plate:     the plate is located first (edge map, closed into blobs, filtered
             by plate-like aspect ratios and rectangularity), up to three crops
             plus the whole frame are read as one line (psm 7) and as a block
             (psm 6) with a letters-and-digits whitelist, and every read is
             fitted to the Indian registration formats with position-aware
             corrections — the same rules as frontend/src/lib/anpr.ts.

  A read is scored by confidence-weighted character mass: the sum over words of
  (confidence x length). That rewards a variant that reads more of the page and
  one that reads it more surely, and a variant that returns a single confident
  word does not beat one that returns the whole memo.

WHAT "PROOF" MEANS HERE
  OCR output is derived evidence: a court can only rely on it if anyone can see
  exactly what it was derived from and how. Every result carries a proof block:

    inputSha256          SHA-256 of the exact bytes read. For an evidence item
                         this must equal the registered file digest; the caller
                         can pass it in and the read is refused on a mismatch.
    preprocessedSha256   SHA-256 of the PNG of the winning prepared image.
    pipeline             version, steps with their parameters, the variant and
                         page-segmentation mode that won, and the plate crop box.
    engine               OCR engine and its version.
    textSha256           SHA-256 of the extracted text (UTF-8).
    confidencePct        integer 0-100.
    resultDigest         SHA-256 of the canonical JSON of all of the above.

  The canonical JSON is the same encoding as packages/integrity (sorted keys,
  no whitespace, integers only), so the Node API recomputes resultDigest itself
  and can anchor it on chain. Re-running the same image through the same
  pipeline and engine version reproduces the same digest.

  What it does not prove: that the text is correct. OCR is a reading aid. The
  officer or the court reads the image; the text is a searchable copy of it.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol

import cv2
import numpy as np
from PIL import Image, ImageOps

PIPELINE_VERSION = "nyaysetu-ocr-1.0"

# A decompression bomb is refused before it is decoded: 60 megapixels is well
# above any phone camera and far below what would exhaust the service.
MAX_PIXELS = 60_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS

PLATE_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"


class OcrError(Exception):
    """A request the service refuses, with an HTTP status for the caller."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


# ----------------------------------------------------------------- engine


@dataclass
class Word:
    text: str
    confidence: float  # 0-100
    line: tuple[int, int, int]  # (block, paragraph, line)


class OcrEngine(Protocol):
    name: str

    def version(self) -> str: ...

    def read(self, image: np.ndarray, *, psm: int, whitelist: str | None, lang: str) -> list[Word]: ...


class TesseractEngine:
    """pytesseract over the Tesseract binary. Both are needed; neither is bundled."""

    name = "tesseract"

    def __init__(self) -> None:
        try:
            import pytesseract  # noqa: PLC0415
        except ImportError as error:
            raise OcrError(
                503,
                "OCR_ENGINE_MISSING",
                "pytesseract is not installed. Run `pip install -r requirements.txt` in ai-service.",
            ) from error
        self._tess = pytesseract
        try:
            self._version = str(pytesseract.get_tesseract_version())
        except Exception as error:  # noqa: BLE001
            raise OcrError(
                503,
                "OCR_ENGINE_MISSING",
                "The Tesseract binary was not found. Install it (Windows: the UB Mannheim installer; "
                "Debian/Ubuntu: apt install tesseract-ocr; macOS: brew install tesseract) or set "
                "TESSERACT_CMD to its path.",
            ) from error

    def version(self) -> str:
        return self._version

    def read(self, image: np.ndarray, *, psm: int, whitelist: str | None, lang: str) -> list[Word]:
        config = f"--oem 1 --psm {psm} -c preserve_interword_spaces=1"
        if whitelist:
            config += f" -c tessedit_char_whitelist={whitelist}"
        data = self._tess.image_to_data(image, lang=lang, config=config, output_type=self._tess.Output.DICT)
        words: list[Word] = []
        for i, text in enumerate(data["text"]):
            text = (text or "").strip()
            conf = float(data["conf"][i])
            if not text or conf < 0:
                continue
            words.append(Word(text, conf, (int(data["block_num"][i]), int(data["par_num"][i]), int(data["line_num"][i]))))
        return words


_engine: OcrEngine | None = None
_engine_error: OcrError | None = None


def configure_engine(tesseract_cmd: str | None = None) -> None:
    """Loads the engine once. A failure is remembered and reported, not retried per request."""
    global _engine, _engine_error
    try:
        if tesseract_cmd:
            import pytesseract  # noqa: PLC0415

            pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        _engine = TesseractEngine()
        _engine_error = None
    except OcrError as error:
        _engine, _engine_error = None, error


def engine_status() -> dict[str, Any]:
    if _engine:
        return {"available": True, "engine": _engine.name, "version": _engine.version()}
    return {"available": False, "reason": _engine_error.message if _engine_error else "not configured"}


def require_engine(engine: OcrEngine | None = None) -> OcrEngine:
    if engine:
        return engine
    if _engine:
        return _engine
    raise _engine_error or OcrError(503, "OCR_ENGINE_MISSING", "No OCR engine is configured.")


# ----------------------------------------------------------------- proof


def sha256_hex(data: bytes) -> str:
    return "0x" + hashlib.sha256(data).hexdigest()


def canonical_json(value: Any) -> str:
    """packages/integrity canonicalJson: sorted keys, no whitespace, integers only."""

    def check(v: Any, path: str) -> None:
        if isinstance(v, bool) or v is None or isinstance(v, str):
            return
        if isinstance(v, int):
            if abs(v) > 2**53 - 1:
                raise ValueError(f"unsafe integer at {path}")
            return
        if isinstance(v, float):
            raise ValueError(f"floats are not canonical (at {path}); scale to an integer")
        if isinstance(v, (list, tuple)):
            for i, item in enumerate(v):
                check(item, f"{path}[{i}]")
            return
        if isinstance(v, dict):
            for k, item in v.items():
                if not isinstance(k, str):
                    raise ValueError(f"non-string key at {path}")
                check(item, f"{path}.{k}" if path else k)
            return
        raise ValueError(f"unsupported type {type(v).__name__} at {path}")

    check(value, "")
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def png_bytes(image: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".png", image, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise OcrError(500, "ENCODE_FAILED", "Could not encode the prepared image.")
    return encoded.tobytes()


def build_proof(
    *,
    input_sha256: str,
    prepared: np.ndarray,
    pipeline: dict[str, Any],
    engine: OcrEngine,
    text: str,
    confidence_pct: int,
) -> dict[str, Any]:
    core = {
        "confidencePct": int(confidence_pct),
        "engine": {"name": engine.name, "version": engine.version()},
        "inputSha256": input_sha256,
        "pipeline": pipeline,
        "preprocessedSha256": sha256_hex(png_bytes(prepared)),
        "textSha256": sha256_hex(text.encode("utf-8")),
    }
    return {**core, "resultDigest": sha256_hex(canonical_json(core).encode("utf-8"))}


# ----------------------------------------------------------------- image prep


def decode(data: bytes) -> np.ndarray:
    """Bytes to a greyscale array, upright by EXIF. Refuses what is not an image."""
    if not data:
        raise OcrError(400, "EMPTY", "No image was sent.")
    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.width * img.height > MAX_PIXELS:
                raise OcrError(413, "TOO_LARGE", "The image is larger than 60 megapixels.")
            img = ImageOps.exif_transpose(img)
            grey = np.asarray(img.convert("L"), dtype=np.uint8)
    except OcrError:
        raise
    except Image.DecompressionBombError as error:
        raise OcrError(413, "TOO_LARGE", "The image is larger than 60 megapixels.") from error
    except Exception as error:  # noqa: BLE001
        raise OcrError(415, "NOT_AN_IMAGE", "The file is not an image this service can read (JPEG, PNG, WebP, TIFF, BMP).") from error
    if grey.shape[0] < 16 or grey.shape[1] < 16:
        raise OcrError(422, "TOO_SMALL", "The image is too small to read.")
    return grey


def rescale(grey: np.ndarray, long_side: int, max_factor: float = 3.0) -> tuple[np.ndarray, float]:
    """Brings the long side to `long_side`: Tesseract reads best at roughly 300 dpi text height."""
    h, w = grey.shape[:2]
    factor = min(max_factor, long_side / max(h, w))
    if abs(factor - 1) < 0.05:
        return grey, 1.0
    interpolation = cv2.INTER_CUBIC if factor > 1 else cv2.INTER_AREA
    return cv2.resize(grey, (round(w * factor), round(h * factor)), interpolation=interpolation), factor


def estimate_skew(grey: np.ndarray, limit: float = 10.0) -> float:
    """
    Skew angle in degrees by projection profile: rotate a small binarised copy
    and keep the angle at which the row sums are most uneven, which is when the
    text lines are horizontal. Coarse 0.5 degree search, then 0.1 around it.
    """
    h, w = grey.shape[:2]
    scale = 800 / max(h, w) if max(h, w) > 800 else 1.0
    small = cv2.resize(grey, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    _, ink = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    if np.count_nonzero(ink) < 50:
        return 0.0
    centre = (ink.shape[1] / 2, ink.shape[0] / 2)

    def sharpness(angle: float) -> float:
        matrix = cv2.getRotationMatrix2D(centre, angle, 1.0)
        rotated = cv2.warpAffine(ink, matrix, (ink.shape[1], ink.shape[0]), flags=cv2.INTER_NEAREST, borderValue=0)
        return float(np.var(rotated.sum(axis=1, dtype=np.float64)))

    coarse = max(np.arange(-limit, limit + 0.01, 0.5), key=sharpness)
    fine = max(np.arange(coarse - 0.5, coarse + 0.51, 0.1), key=sharpness)
    return round(float(fine), 1)


def rotate(grey: np.ndarray, angle: float) -> np.ndarray:
    if abs(angle) < 0.2:
        return grey
    h, w = grey.shape[:2]
    matrix = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    cos, sin = abs(matrix[0, 0]), abs(matrix[0, 1])
    new_w, new_h = int(h * sin + w * cos), int(h * cos + w * sin)
    matrix[0, 2] += new_w / 2 - w / 2
    matrix[1, 2] += new_h / 2 - h / 2
    return cv2.warpAffine(grey, matrix, (new_w, new_h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def flatten(grey: np.ndarray) -> np.ndarray:
    """Divides out the background (shadows, a gradient from a window) and stretches contrast."""
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    background = cv2.medianBlur(cv2.dilate(grey, kernel), 21)
    flat = cv2.divide(grey, background, scale=255)
    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(flat)


def otsu(grey: np.ndarray) -> np.ndarray:
    _, binary = cv2.threshold(grey, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    return binary


def adaptive(grey: np.ndarray) -> np.ndarray:
    denoised = cv2.fastNlMeansDenoising(grey, None, h=10, templateWindowSize=7, searchWindowSize=21)
    return cv2.adaptiveThreshold(denoised, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 15)


def pad(image: np.ndarray, border: int = 12) -> np.ndarray:
    """Tesseract misses glyphs that touch the edge of the image."""
    return cv2.copyMakeBorder(image, border, border, border, border, cv2.BORDER_CONSTANT, value=255)


def ensure_dark_text(binary: np.ndarray) -> np.ndarray:
    """Tesseract wants dark text on light. A white-on-black plate is inverted."""
    return cv2.bitwise_not(binary) if np.mean(binary) < 110 else binary


# ----------------------------------------------------------------- reading


@dataclass
class Attempt:
    variant: str
    psm: int
    words: list[Word]
    image: np.ndarray = field(repr=False)
    crop: tuple[int, int, int, int] | None = None

    @property
    def chars(self) -> int:
        return sum(len(w.text) for w in self.words)

    @property
    def mass(self) -> float:
        return sum(w.confidence * len(w.text) for w in self.words)

    @property
    def confidence(self) -> float:
        """Character-weighted mean confidence, 0-100."""
        return self.mass / self.chars if self.chars else 0.0

    def text(self) -> str:
        lines: dict[tuple[int, int, int], list[str]] = {}
        for word in self.words:
            lines.setdefault(word.line, []).append(word.text)
        return "\n".join(" ".join(parts) for _, parts in sorted(lines.items()))

    def summary(self) -> dict[str, Any]:
        return {
            "variant": self.variant,
            "psm": self.psm,
            "confidence": round(self.confidence / 100, 4),
            "chars": self.chars,
            "score": round(self.mass / 100, 2),
        }


def _read(engine: OcrEngine, image: np.ndarray, variant: str, psm: int, *, whitelist: str | None, lang: str, crop=None) -> Attempt:
    return Attempt(variant, psm, engine.read(image, psm=psm, whitelist=whitelist, lang=lang), image, crop)


def read_document(data: bytes, *, engine: OcrEngine | None = None, lang: str = "eng", expected_sha256: str | None = None) -> dict[str, Any]:
    started = time.perf_counter()
    engine = require_engine(engine)
    input_sha = check_digest(data, expected_sha256)

    grey = decode(data)
    grey, factor = rescale(grey, 2400)
    angle = estimate_skew(grey)
    grey = rotate(grey, angle)
    flat = flatten(grey)

    variants: list[tuple[str, Callable[[], np.ndarray]]] = [
        ("raw", lambda: pad(grey)),
        ("flattened", lambda: pad(flat)),
        ("otsu", lambda: pad(otsu(flat))),
        ("adaptive", lambda: pad(adaptive(grey))),
    ]
    attempts = [_read(engine, make(), name, 3, whitelist=None, lang=lang) for name, make in variants]
    best = max(attempts, key=lambda a: a.mass)
    block = _read(engine, best.image, best.variant, 6, whitelist=None, lang=lang)
    attempts.append(block)
    if block.mass > best.mass:
        best = block

    raw = attempts[0]
    text = best.text()
    pipeline = {
        "version": PIPELINE_VERSION,
        "mode": "document",
        "lang": lang,
        "steps": [
            {"name": "exif_transpose"},
            {"name": "greyscale"},
            {"name": "rescale", "longSide": 2400, "factorPermille": round(factor * 1000)},
            {"name": "deskew", "angleDeciDegrees": round(angle * 10)},
            *VARIANT_STEPS[best.variant],
            {"name": "pad", "border": 12},
        ],
        "variant": best.variant,
        "psm": best.psm,
    }
    confidence_pct = round(best.confidence)
    return {
        "mode": "document",
        "text": text,
        "lines": text.split("\n") if text else [],
        "words": len(best.words),
        "confidence": round(best.confidence / 100, 4),
        "variant": best.variant,
        "psm": best.psm,
        "deskewDegrees": angle,
        "attempts": [a.summary() for a in attempts],
        "improvement": {
            "rawConfidence": round(raw.confidence / 100, 4),
            "rawChars": raw.chars,
            "bestConfidence": round(best.confidence / 100, 4),
            "bestChars": best.chars,
        },
        "proof": build_proof(input_sha256=input_sha, prepared=best.image, pipeline=pipeline, engine=engine, text=text, confidence_pct=confidence_pct),
        "durationMs": round((time.perf_counter() - started) * 1000),
    }


VARIANT_STEPS: dict[str, list[dict[str, Any]]] = {
    "raw": [],
    "flattened": [{"name": "background_divide", "kernel": 7, "median": 21}, {"name": "clahe", "clipTenths": 20, "tile": 8}],
    "otsu": [
        {"name": "background_divide", "kernel": 7, "median": 21},
        {"name": "clahe", "clipTenths": 20, "tile": 8},
        {"name": "otsu_threshold"},
    ],
    "adaptive": [{"name": "nl_means_denoise", "h": 10}, {"name": "adaptive_gaussian_threshold", "block": 31, "c": 15}],
    "plate_otsu": [{"name": "bilateral", "d": 9}, {"name": "otsu_threshold"}, {"name": "dark_text"}],
    "plate_clahe": [{"name": "clahe", "clipTenths": 30, "tile": 4}],
    "plate_adaptive": [{"name": "adaptive_gaussian_threshold", "block": 25, "c": 9}, {"name": "dark_text"}],
}


# ----------------------------------------------------------------- plates

STATE_CODES = {
    "AN", "AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "DN", "GA", "GJ", "HP", "HR", "JH", "JK", "KA", "KL",
    "LA", "LD", "MH", "ML", "MN", "MP", "MZ", "NL", "OD", "OR", "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "UK",
    "UP", "WB",
}
STANDARD = re.compile(r"^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$")
BHARAT = re.compile(r"^(\d{2})BH(\d{4})([A-Z]{1,2})$")
TO_DIGIT = {"O": "0", "D": "0", "Q": "0", "U": "0", "I": "1", "L": "1", "J": "1", "Z": "2", "S": "5", "B": "8", "G": "6", "T": "7", "A": "4"}
TO_LETTER = {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G", "7": "T", "4": "A"}
TEMPLATES = ["LLDDLLDDDD", "LLDDLDDDD", "LLDDLLLDDDD", "LLDLLDDDD", "LLDLLLDDDD", "LLDDDDDD", "LLDDDDDDD", "DDLLDDDDLL", "DDLLDDDDL"]


def normalise_plate(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", value.upper())


def is_valid_plate(plate: str) -> bool:
    m = STANDARD.match(plate)
    if m:
        return m.group(1) in STATE_CODES
    return bool(BHARAT.match(plate))


def _coerce(window: str, template: str) -> tuple[str, int] | None:
    out, corrections = [], 0
    for c, kind in zip(window, template):
        want_digit = kind == "D"
        if want_digit == c.isdigit():
            out.append(c)
            continue
        swapped = (TO_DIGIT if want_digit else TO_LETTER).get(c)
        if not swapped:
            return None
        out.append(swapped)
        corrections += 1
    return "".join(out), corrections


def plate_candidates(raw: str, ocr_confidence: float = 0.7) -> list[dict[str, Any]]:
    """Fits raw OCR text to Indian plate formats, best first. Mirrors plateCandidatesFromText."""
    clean = normalise_plate(raw.replace("IND", " "))
    found: dict[str, dict[str, Any]] = {}
    for template in TEMPLATES:
        for start in range(0, len(clean) - len(template) + 1):
            fitted = _coerce(clean[start : start + len(template)], template)
            if not fitted or not is_valid_plate(fitted[0]):
                continue
            plate, corrections = fitted
            # Characters the read contained but this format leaves unused count
            # against it, so a shorter format that needs fewer corrections
            # ("MH12A8123" out of "MHI2A8I234") does not beat the reading that
            # accounts for the whole plate.
            unused = min(3, len(clean) - len(template))
            confidence = max(0.0, min(1.0, ocr_confidence - corrections * 0.08 - unused * 0.1))
            prior = found.get(plate)
            if not prior or prior["confidence"] < confidence:
                found[plate] = {"plate": plate, "confidence": round(confidence, 4), "valid": True, "corrections": corrections}
    out = sorted(found.values(), key=lambda c: (-c["confidence"], c["corrections"]))
    if not out and len(clean) >= 4:
        out.append({"plate": clean[:12], "confidence": round(ocr_confidence * 0.4, 4), "valid": False, "corrections": 0})
    return out[:5]


def locate_plates(grey: np.ndarray, limit: int = 3) -> list[tuple[int, int, int, int]]:
    """Plate-shaped regions, most plate-like first, as (x, y, w, h)."""
    h, w = grey.shape[:2]
    smooth = cv2.bilateralFilter(grey, 11, 17, 17)
    edges = cv2.Canny(smooth, 30, 200)
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (17, 5)))
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    area = float(h * w)
    scored: list[tuple[float, tuple[int, int, int, int]]] = []
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        if ch == 0:
            continue
        aspect = cw / ch
        share = (cw * ch) / area
        # Single-line plates are about 4.5:1, two-line ones about 1.7:1.
        if not (1.3 <= aspect <= 6.5 and 0.002 <= share <= 0.4):
            continue
        rectangularity = cv2.contourArea(contour) / float(cw * ch)
        shape = 1.0 - min(abs(aspect - 4.5), abs(aspect - 1.8)) / 4.5
        scored.append((rectangularity * 0.6 + shape * 0.4 + min(share * 4, 0.3), (x, y, cw, ch)))
    scored.sort(key=lambda s: -s[0])
    boxes: list[tuple[int, int, int, int]] = []
    for _, (x, y, cw, ch) in scored:
        # A margin, so the outer characters are not cut by a tight contour.
        mx, my = round(cw * 0.06), round(ch * 0.15)
        box = (max(0, x - mx), max(0, y - my), min(w - max(0, x - mx), cw + 2 * mx), min(h - max(0, y - my), ch + 2 * my))
        if all(_overlap(box, other) < 0.5 for other in boxes):
            boxes.append(box)
        if len(boxes) >= limit:
            break
    return boxes


def _overlap(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    return inter / float(min(aw * ah, bw * bh) or 1)


def _plate_variants(crop: np.ndarray) -> Iterable[tuple[str, np.ndarray]]:
    # Plate characters read best at 60-100 px tall; a crop is brought to ~140 px.
    target = 140 / crop.shape[0]
    if target > 1:
        crop = cv2.resize(crop, None, fx=min(target, 6), fy=min(target, 6), interpolation=cv2.INTER_CUBIC)
    yield "plate_otsu", pad(ensure_dark_text(otsu(cv2.bilateralFilter(crop, 9, 50, 50))))
    yield "plate_clahe", pad(cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4)).apply(crop))
    yield "plate_adaptive", pad(ensure_dark_text(cv2.adaptiveThreshold(crop, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 25, 9)))


def read_plate(data: bytes, *, engine: OcrEngine | None = None, expected_sha256: str | None = None) -> dict[str, Any]:
    started = time.perf_counter()
    engine = require_engine(engine)
    input_sha = check_digest(data, expected_sha256)

    grey = decode(data)
    grey, factor = rescale(grey, 1600, max_factor=2.0)
    h, w = grey.shape[:2]
    regions: list[tuple[int, int, int, int] | None] = [*locate_plates(grey), None]

    attempts: list[Attempt] = []
    best: tuple[dict[str, Any], Attempt] | None = None
    for region in regions:
        crop = grey if region is None else grey[region[1] : region[1] + region[3], region[0] : region[0] + region[2]]
        for variant, image in _plate_variants(crop):
            for psm in (7, 6):
                attempt = _read(engine, image, variant, psm, whitelist=PLATE_WHITELIST, lang="eng", crop=region)
                attempts.append(attempt)
                for candidate in plate_candidates(attempt.text().replace("\n", " "), attempt.confidence / 100):
                    rank = (candidate["valid"], candidate["confidence"])
                    if not best or rank > (best[0]["valid"], best[0]["confidence"]):
                        best = (candidate, attempt)
                # A confidently read, well-formed plate ends the search.
                if best and best[0]["valid"] and best[0]["confidence"] >= 0.85:
                    break
            if best and best[0]["valid"] and best[0]["confidence"] >= 0.85:
                break
        if best and best[0]["valid"] and best[0]["confidence"] >= 0.85:
            break

    winner = best[1] if best else max(attempts, key=lambda a: a.mass)
    # Every distinct plate any attempt produced, best first, for the officer to choose from.
    pool: dict[str, dict[str, Any]] = {}
    for attempt in attempts:
        for candidate in plate_candidates(attempt.text().replace("\n", " "), attempt.confidence / 100):
            prior = pool.get(candidate["plate"])
            if not prior or (candidate["valid"], candidate["confidence"]) > (prior["valid"], prior["confidence"]):
                pool[candidate["plate"]] = candidate
    candidates = sorted(pool.values(), key=lambda c: (not c["valid"], -c["confidence"], c["corrections"]))[:5]
    text = candidates[0]["plate"] if candidates else ""

    crop = winner.crop
    pipeline = {
        "version": PIPELINE_VERSION,
        "mode": "plate",
        "lang": "eng",
        "steps": [
            {"name": "exif_transpose"},
            {"name": "greyscale"},
            {"name": "rescale", "longSide": 1600, "factorPermille": round(factor * 1000)},
            {"name": "locate_plate", "found": len(regions) - 1},
            *VARIANT_STEPS[winner.variant],
            {"name": "pad", "border": 12},
        ],
        "variant": winner.variant,
        "psm": winner.psm,
        "whitelist": PLATE_WHITELIST,
        "crop": {"x": crop[0], "y": crop[1], "w": crop[2], "h": crop[3]} if crop else {"x": 0, "y": 0, "w": w, "h": h},
    }
    confidence = candidates[0]["confidence"] if candidates else 0.0
    return {
        "mode": "plate",
        "text": text,
        "candidates": candidates,
        "confidence": round(confidence, 4),
        "variant": winner.variant,
        "psm": winner.psm,
        "regionsFound": len(regions) - 1,
        "attempts": [a.summary() for a in attempts],
        "proof": build_proof(input_sha256=input_sha, prepared=winner.image, pipeline=pipeline, engine=engine, text=text, confidence_pct=round(confidence * 100)),
        "durationMs": round((time.perf_counter() - started) * 1000),
    }


# ----------------------------------------------------------------- helpers


HASH32 = re.compile(r"^0x[0-9a-f]{64}$")


def check_digest(data: bytes, expected: str | None) -> str:
    """The digest of what is about to be read, refused if it is not the evidence the caller named."""
    actual = sha256_hex(data)
    if expected:
        expected = expected.strip().lower()
        if not HASH32.match(expected):
            raise OcrError(400, "BAD_DIGEST", "The expected digest must be 0x followed by 64 hex characters.")
        if expected != actual:
            raise OcrError(
                409,
                "DIGEST_MISMATCH",
                f"These bytes hash to {actual}, not the registered {expected}. Nothing was read.",
            )
    return actual


def verify_proof(proof: dict[str, Any]) -> bool:
    """Recomputes resultDigest from the rest of the proof block."""
    core = {k: v for k, v in proof.items() if k != "resultDigest"}
    return sha256_hex(canonical_json(core).encode("utf-8")) == proof.get("resultDigest")


__all__ = [
    "OcrEngine",
    "OcrError",
    "PIPELINE_VERSION",
    "Word",
    "canonical_json",
    "configure_engine",
    "engine_status",
    "estimate_skew",
    "plate_candidates",
    "read_document",
    "read_plate",
    "verify_proof",
]
