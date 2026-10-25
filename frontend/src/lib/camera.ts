/**
 * Camera and microphone access for live capture (2.0 · F10, F12).
 *
 * Every failure is classified, because "the camera did not start" has four
 * causes with four different remedies, and only one of them is the user's to fix.
 */

export type CameraFailure = "insecure" | "unsupported" | "denied" | "missing" | "busy" | "other";

export class CameraError extends Error {
  constructor(readonly kind: CameraFailure, message: string) {
    super(message);
    this.name = "CameraError";
  }
}

export function cameraSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

export async function startCamera(options: { facing: "environment" | "user"; audio: boolean }): Promise<MediaStream> {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    throw new CameraError("insecure", "The camera needs HTTPS.");
  }
  if (!cameraSupported()) throw new CameraError("unsupported", "This browser cannot open a camera.");

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: options.facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: options.audio,
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") throw new CameraError("denied", "Permission refused.");
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new CameraError("missing", "No camera found.");
    if (name === "NotReadableError" || name === "AbortError") throw new CameraError("busy", "The camera is in use by another application.");
    throw new CameraError("other", error instanceof Error ? error.message : String(error));
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * One still frame from the live preview, encoded once as JPEG. These bytes are
 * what is hashed and uploaded: nothing re-encodes, compresses or strips them
 * afterwards, so the digest describes exactly what the camera produced here.
 */
export async function grabFrame(video: HTMLVideoElement, quality = 0.95): Promise<Blob> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new CameraError("other", "The camera has not produced a frame yet.");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new CameraError("other", "Could not read the camera frame.");
  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new CameraError("other", "Could not encode the photograph.");
  return blob;
}

/** The best container the browser can record into, audio and video. */
export function recorderMimeType(): string {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  if (typeof MediaRecorder === "undefined") return "";
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}
