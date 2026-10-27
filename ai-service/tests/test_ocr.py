"""
OCR pipeline tests. They need OpenCV, Pillow and NumPy but not Tesseract: the
engine is replaced by a deterministic stand-in, so what is tested is the part
NyaySetu owns — preparation, variant selection, plate fitting and the proof.

    python -m unittest discover -s tests        (from ai-service/)
"""

from __future__ import annotations

import io
import json
import unittest

import cv2
import numpy as np
from PIL import Image

from src import ocr


class FakeEngine:
    """
    Reads `text` with a confidence that rises with how cleanly two-tone the
    image is, so a thresholded variant beats a muddy one, as with Tesseract.
    """

    name = "fake"

    def __init__(self, text: str = "SEIZURE MEMO 14/2026", plate: str | None = None):
        self.text = text
        self.plate = plate
        self.calls: list[tuple[int, str | None]] = []

    def version(self) -> str:
        return "1.0-test"

    def read(self, image: np.ndarray, *, psm: int, whitelist: str | None, lang: str) -> list[ocr.Word]:
        self.calls.append((psm, whitelist))
        extremes = float(np.mean((image < 40) | (image > 215)))
        confidence = round(40 + 55 * extremes, 2)
        source = self.plate if (whitelist and self.plate) else self.text
        return [ocr.Word(part, confidence, (1, 1, 1)) for part in source.split()]


def page(text: str = "SEIZURE MEMO 14/2026", angle: float = 0.0, shadow: bool = True) -> bytes:
    canvas = np.full((700, 1000), 235, np.uint8)
    for row, line in enumerate([text, "ITEM 1 MOBILE PHONE SEALED", "WITNESS R. PATIL"]):
        cv2.putText(canvas, line, (60, 150 + row * 120), cv2.FONT_HERSHEY_SIMPLEX, 1.6, 20, 4, cv2.LINE_AA)
    if shadow:
        gradient = np.linspace(0.55, 1.0, canvas.shape[1])[None, :]
        canvas = (canvas * gradient).astype(np.uint8)
    if angle:
        canvas = ocr.rotate(canvas, angle)
    buffer = io.BytesIO()
    Image.fromarray(canvas).save(buffer, format="PNG")
    return buffer.getvalue()


class PlateFitting(unittest.TestCase):
    def test_reads_a_clean_plate(self):
        best = ocr.plate_candidates("MH 12 AB 1234", 0.9)[0]
        self.assertEqual(best["plate"], "MH12AB1234")
        self.assertTrue(best["valid"])
        self.assertEqual(best["corrections"], 0)

    def test_corrects_letter_digit_confusions_by_position(self):
        # O for 0 in the district, 8 for B in the series, I for 1 in the number.
        best = ocr.plate_candidates("MH I2 A8 I234", 0.9)[0]
        self.assertEqual(best["plate"], "MH12AB1234")
        self.assertEqual(best["corrections"], 3)
        self.assertLess(best["confidence"], 0.9)

    def test_ignores_the_ind_strip_and_noise(self):
        best = ocr.plate_candidates("IND | MH14 EX 9081 ..", 0.8)[0]
        self.assertEqual(best["plate"], "MH14EX9081")

    def test_bharat_series(self):
        self.assertEqual(ocr.plate_candidates("22 BH 1234 AA")[0]["plate"], "22BH1234AA")

    def test_unknown_state_is_not_valid(self):
        self.assertFalse(any(c["valid"] and c["plate"].startswith("XX") for c in ocr.plate_candidates("XX12AB1234")))


class Canonical(unittest.TestCase):
    def test_matches_packages_integrity(self):
        value = {"b": 1, "a": {"y": [1, "x"], "x": None}, "c": True, "d": "न्याय \"q\"\n"}
        self.assertEqual(ocr.canonical_json(value), '{"a":{"x":null,"y":[1,"x"]},"b":1,"c":true,"d":"न्याय \\"q\\"\\n"}')

    def test_refuses_floats(self):
        with self.assertRaises(ValueError):
            ocr.canonical_json({"confidence": 0.5})

    def test_cross_language_vector(self):
        # The same vector is checked in backend/test/f22-evidence-ocr.test.ts,
        # so a digest made here is one the API can recompute.
        core = {
            "confidencePct": 87,
            "engine": {"name": "tesseract", "version": "5.4.0"},
            "inputSha256": "0x" + "ab" * 32,
            "pipeline": {"mode": "document", "psm": 3, "steps": [{"name": "deskew", "angleDeciDegrees": -35}], "variant": "otsu", "version": ocr.PIPELINE_VERSION},
            "preprocessedSha256": "0x" + "cd" * 32,
            "textSha256": "0x" + "ef" * 32,
        }
        self.assertEqual(ocr.sha256_hex(ocr.canonical_json(core).encode()), VECTOR_DIGEST)


VECTOR_DIGEST = "0xb07a02985e889745a63cecded029f8489041a9cd7f45e51281c770d830fa28ab"


class Preparation(unittest.TestCase):
    def test_deskew_recovers_a_tilted_page(self):
        tilted = ocr.decode(page(angle=4.0, shadow=False))
        self.assertAlmostEqual(ocr.estimate_skew(tilted), -4.0, delta=0.6)

    def test_straight_page_is_left_alone(self):
        self.assertAlmostEqual(ocr.estimate_skew(ocr.decode(page(shadow=False))), 0.0, delta=0.3)

    def test_flatten_removes_a_shadow_gradient(self):
        grey = ocr.decode(page())
        left, right = grey[:, :100].mean(), grey[:, -100:].mean()
        flat = ocr.flatten(grey)
        self.assertLess(abs(flat[:, :100].mean() - flat[:, -100:].mean()), abs(left - right))

    def test_refuses_what_is_not_an_image(self):
        with self.assertRaises(ocr.OcrError) as caught:
            ocr.decode(b"%PDF-1.7 not an image")
        self.assertEqual(caught.exception.status, 415)

    def test_applies_exif_orientation(self):
        image = Image.fromarray(np.zeros((40, 100), np.uint8))
        exif = Image.Exif()
        exif[0x0112] = 6  # rotate 90 on display
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", exif=exif)
        self.assertEqual(ocr.decode(buffer.getvalue()).shape, (100, 40))


class Document(unittest.TestCase):
    def test_optimised_beats_raw_and_says_so(self):
        result = ocr.read_document(page(angle=3.0), engine=FakeEngine())
        self.assertNotEqual(result["variant"], "raw")
        self.assertGreater(result["improvement"]["bestConfidence"], result["improvement"]["rawConfidence"])
        self.assertEqual(result["text"], "SEIZURE MEMO 14/2026")
        self.assertEqual(len(result["attempts"]), 5)

    def test_proof_binds_input_text_and_pipeline(self):
        data = page()
        result = ocr.read_document(data, engine=FakeEngine())
        proof = result["proof"]
        self.assertEqual(proof["inputSha256"], ocr.sha256_hex(data))
        self.assertEqual(proof["textSha256"], ocr.sha256_hex(result["text"].encode()))
        self.assertTrue(ocr.verify_proof(proof))
        tampered = json.loads(json.dumps(proof))
        tampered["textSha256"] = "0x" + "00" * 32
        self.assertFalse(ocr.verify_proof(tampered))

    def test_same_image_same_digest(self):
        data = page(angle=2.0)
        first = ocr.read_document(data, engine=FakeEngine())["proof"]["resultDigest"]
        second = ocr.read_document(data, engine=FakeEngine())["proof"]["resultDigest"]
        self.assertEqual(first, second)

    def test_refuses_bytes_that_are_not_the_registered_evidence(self):
        with self.assertRaises(ocr.OcrError) as caught:
            ocr.read_document(page(), engine=FakeEngine(), expected_sha256="0x" + "11" * 32)
        self.assertEqual(caught.exception.code, "DIGEST_MISMATCH")

    def test_accepts_the_registered_digest(self):
        data = page()
        result = ocr.read_document(data, engine=FakeEngine(), expected_sha256=ocr.sha256_hex(data).upper().replace("0X", "0x"))
        self.assertEqual(result["proof"]["inputSha256"], ocr.sha256_hex(data))


class Plate(unittest.TestCase):
    def car(self) -> bytes:
        canvas = np.full((600, 900), 90, np.uint8)
        cv2.rectangle(canvas, (300, 380), (620, 450), 250, -1)
        cv2.rectangle(canvas, (300, 380), (620, 450), 10, 3)
        cv2.putText(canvas, "MH12AB1234", (315, 432), cv2.FONT_HERSHEY_SIMPLEX, 1.25, 10, 3, cv2.LINE_AA)
        buffer = io.BytesIO()
        Image.fromarray(canvas).save(buffer, format="PNG")
        return buffer.getvalue()

    def test_locates_the_plate(self):
        boxes = ocr.locate_plates(ocr.decode(self.car()))
        self.assertTrue(any(x <= 310 and x + w >= 610 and y <= 390 and y + h >= 440 for x, y, w, h in boxes), boxes)

    def test_reads_with_the_whitelist_and_fits_the_format(self):
        engine = FakeEngine(plate="MH I2 A8 1234")
        result = ocr.read_plate(self.car(), engine=engine)
        self.assertEqual(result["text"], "MH12AB1234")
        self.assertTrue(result["candidates"][0]["valid"])
        self.assertTrue(all(whitelist == ocr.PLATE_WHITELIST for _, whitelist in engine.calls))
        self.assertTrue(ocr.verify_proof(result["proof"]))
        self.assertGreater(result["proof"]["pipeline"]["crop"]["w"], 0)


if __name__ == "__main__":
    unittest.main()
