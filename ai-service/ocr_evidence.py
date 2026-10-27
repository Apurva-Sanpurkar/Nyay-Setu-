"""
Optimised OCR for NyaySetu evidence, from the command line.

    python ocr_evidence.py memo.jpg
    python ocr_evidence.py memo.jpg --expect-sha256 0x3f…   refuse unless these are the registered bytes
    python ocr_evidence.py car.jpg --mode plate
    python ocr_evidence.py memo.jpg --json > result.json     the full result, proof included
    python ocr_evidence.py memo.jpg --save-prepared prepared.png
    python ocr_evidence.py --verify result.json              recompute a saved result's digest
    python ocr_evidence.py --benchmark samples/              raw Tesseract vs the optimised pipeline

It runs the same pipeline as the service's /ocr routes (src/ocr.py), so a result
produced here has the same resultDigest as one produced through the API for the
same file. That is the point: anyone holding the evidence file can reproduce the
OCR and its proof without trusting the server that produced it first.

Needs the Tesseract binary (see README) and `pip install -r requirements.txt`.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2

from src import ocr

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"}


def run_one(args: argparse.Namespace) -> int:
    data = Path(args.file).read_bytes()
    reader = ocr.read_plate if args.mode == "plate" else ocr.read_document
    kwargs = {"expected_sha256": args.expect_sha256}
    if args.mode == "document":
        kwargs["lang"] = args.lang
    result = reader(data, **kwargs)

    if args.save_prepared:
        # preprocessedSha256 is the digest of exactly this PNG, so saving it lets
        # anyone check that part of the proof by hashing the file.
        _save_prepared(data, args)

    if args.json:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return 0

    proof = result["proof"]
    print(f"\n  mode        {result['mode']}")
    print(f"  confidence  {result['confidence']:.0%}   (variant {result['variant']}, psm {result['psm']}, {result['durationMs']} ms)")
    if result["mode"] == "document":
        gain = result["improvement"]
        print(f"  raw read    {gain['rawConfidence']:.0%} over {gain['rawChars']} chars -> optimised {gain['bestConfidence']:.0%} over {gain['bestChars']} chars")
        print(f"  deskew      {result['deskewDegrees']}°")
    else:
        for c in result["candidates"]:
            print(f"  plate       {c['plate']:<12} {c['confidence']:.0%}  {'valid' if c['valid'] else 'not a valid format'}  corrections {c['corrections']}")
    print("\n  proof")
    print(f"    input           {proof['inputSha256']}")
    print(f"    prepared image  {proof['preprocessedSha256']}")
    print(f"    text            {proof['textSha256']}")
    print(f"    result digest   {proof['resultDigest']}")
    if result["mode"] == "document":
        print("\n  ---- text ----")
        print(result["text"] or "(no text found)")
    print()
    return 0


def _save_prepared(data: bytes, args: argparse.Namespace) -> None:
    # Re-run with a capturing engine wrapper so the exact winning image is kept.
    engine = ocr.require_engine()
    images: dict[tuple[str, int], object] = {}

    class Capture:
        name = engine.name

        def version(self) -> str:
            return engine.version()

        def read(self, image, *, psm, whitelist, lang):  # noqa: ANN001
            images[(len(images), psm)] = image
            return engine.read(image, psm=psm, whitelist=whitelist, lang=lang)

    if args.mode == "plate":
        again = ocr.read_plate(data, engine=Capture())
    else:
        again = ocr.read_document(data, engine=Capture(), lang=args.lang)
    wanted = again["proof"]["preprocessedSha256"]
    for image in images.values():
        if ocr.sha256_hex(ocr.png_bytes(image)) == wanted:
            Path(args.save_prepared).write_bytes(ocr.png_bytes(image))
            print(f"  prepared image saved to {args.save_prepared}", file=sys.stderr)
            return
    print("  could not isolate the prepared image", file=sys.stderr)


def run_verify(path: str) -> int:
    result = json.loads(Path(path).read_text(encoding="utf-8"))
    proof = result.get("proof", result)
    ok = ocr.verify_proof(proof)
    text_ok = "text" not in result or ocr.sha256_hex(result["text"].encode("utf-8")) == proof.get("textSha256")
    print(f"  resultDigest {'matches' if ok else 'DOES NOT MATCH'} the proof fields")
    print(f"  text {'matches' if text_ok else 'DOES NOT MATCH'} textSha256")
    return 0 if ok and text_ok else 1


def run_benchmark(folder: str, mode: str, lang: str) -> int:
    """Raw Tesseract (greyscale, psm 3 or 7) against the optimised pipeline, per image."""
    engine = ocr.require_engine()
    files = sorted(p for p in Path(folder).iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)
    if not files:
        print(f"No images in {folder}")
        return 1
    print(f"\n  {'file':<32} {'raw conf':>9} {'raw chars':>10} {'opt conf':>9} {'opt chars':>10} {'variant':>15} {'ms':>6}")
    gains = []
    for path in files:
        data = path.read_bytes()
        try:
            grey = ocr.decode(data)
            started = time.perf_counter()
            raw = ocr._read(engine, ocr.pad(grey), "raw", 7 if mode == "plate" else 3, whitelist=ocr.PLATE_WHITELIST if mode == "plate" else None, lang=lang)
            result = ocr.read_plate(data) if mode == "plate" else ocr.read_document(data, lang=lang)
            elapsed = round((time.perf_counter() - started) * 1000)
        except ocr.OcrError as error:
            print(f"  {path.name[:32]:<32} skipped: {error.message}")
            continue
        opt_chars = len(result["text"].replace("\n", ""))
        gains.append(result["confidence"] - raw.confidence / 100)
        print(
            f"  {path.name[:32]:<32} {raw.confidence / 100:>9.0%} {raw.chars:>10} {result['confidence']:>9.0%} {opt_chars:>10} {result['variant']:>15} {elapsed:>6}"
        )
    if gains:
        print(f"\n  mean confidence gain: {sum(gains) / len(gains):+.1%} over {len(gains)} images\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Optimised, provable OCR for NyaySetu evidence images.")
    parser.add_argument("file", nargs="?", help="the image to read")
    parser.add_argument("--mode", choices=["document", "plate"], default="document")
    parser.add_argument("--lang", default="eng", help="Tesseract languages, e.g. eng+hin+mar (document mode)")
    parser.add_argument("--expect-sha256", help="the registered digest; the read is refused if the file differs")
    parser.add_argument("--json", action="store_true", help="print the full result as JSON")
    parser.add_argument("--save-prepared", metavar="PNG", help="save the prepared image the proof refers to")
    parser.add_argument("--verify", metavar="RESULT_JSON", help="recompute the digest of a saved result")
    parser.add_argument("--benchmark", metavar="FOLDER", help="compare raw and optimised OCR over a folder")
    parser.add_argument("--tesseract", metavar="PATH", help="path to the tesseract executable")
    args = parser.parse_args()

    if args.verify:
        return run_verify(args.verify)

    ocr.configure_engine(args.tesseract)
    try:
        if args.benchmark:
            return run_benchmark(args.benchmark, args.mode, args.lang)
        if not args.file:
            parser.error("give an image file, --benchmark FOLDER or --verify RESULT_JSON")
        return run_one(args)
    except ocr.OcrError as error:
        print(f"  {error.code}: {error.message}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    cv2.setNumThreads(max(1, cv2.getNumberOfCPUs() // 2))
    sys.exit(main())
