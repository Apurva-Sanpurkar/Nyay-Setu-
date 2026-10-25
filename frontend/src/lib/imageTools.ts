/**
 * Photograph handling for Vehicle Trace and Third Eye, done on the device.
 *
 * compressImage: a phone photo is 4–12 MB and the API sits behind a 4.5 MB
 * request limit on Vercel, so every picture is re-encoded to a JPEG no wider
 * than 1600 px before it is sent. That also strips EXIF (including the GPS the
 * camera may have embedded), which the report records separately and on purpose.
 *
 * differenceHash: a 64-bit perceptual hash. Two copies of the same picture —
 * re-saved, resized, lightly cropped — land within a few bits of each other.
 * Two different photographs of the same face do not. It finds duplicates; it is
 * not, and must not be presented as, facial recognition.
 */

async function loadBitmap(source: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(source);
    } catch {
      // Fall through: some browsers refuse HEIC or large files here.
    }
  }
  const url = URL.createObjectURL(source);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function dimensions(image: ImageBitmap | HTMLImageElement) {
  return "naturalWidth" in image ? { w: image.naturalWidth, h: image.naturalHeight } : { w: image.width, h: image.height };
}

export async function compressImage(file: Blob, maxDimension = 1600, quality = 0.82): Promise<Blob> {
  const image = await loadBitmap(file);
  const { w, h } = dimensions(image);
  const scale = Math.min(1, maxDimension / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot process images.");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("Could not encode the photograph.");
  // Still too large (a very detailed scene): one more pass, smaller.
  if (blob.size > 3_300_000 && maxDimension > 900) return compressImage(file, Math.round(maxDimension * 0.7), quality - 0.1);
  return blob;
}

/** 9×8 greyscale, compare horizontal neighbours: 64 bits as 16 hex digits. */
export async function differenceHash(file: Blob): Promise<string> {
  const image = await loadBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = 9;
  canvas.height = 8;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot process images.");
  ctx.drawImage(image, 0, 0, 9, 8);
  const { data } = ctx.getImageData(0, 0, 9, 8);
  const grey = (x: number, y: number) => {
    const i = (y * 9 + x) * 4;
    return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  };
  let hex = "";
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (grey(x, y) > grey(x + 1, y) ? 1 : 0);
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** A canvas prepared for OCR: upscaled, greyscale, high contrast. */
export async function plateCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const image = await loadBitmap(file);
  const { w, h } = dimensions(image);
  const scale = Math.min(3, Math.max(1, 1200 / w));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot process images.");
  ctx.filter = "grayscale(1) contrast(1.6)";
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}
