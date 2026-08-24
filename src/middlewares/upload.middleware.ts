import multer from "multer";
import streamifier from "streamifier";
import cloudinary from "../config/cloudinary";

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Multer instance using memory storage — we never write to local disk,
 * the buffer goes straight to Cloudinary. Use as: upload.single("photo")
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new Error("INVALID_FILE_TYPE"));
      return;
    }
    cb(null, true);
  },
});

export interface CloudinaryUploadResult {
  secure_url: string;
  public_id: string;
}

/**
 * Streams a file buffer to Cloudinary. Wrapped in a promise since the
 * Cloudinary SDK's upload_stream API is callback-based.
 */
export function uploadBufferToCloudinary(
  buffer: Buffer,
  folder = "skywardvision/employees"
): Promise<CloudinaryUploadResult> {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        // Cap stored dimensions; actual delivery sizing still handled via
        // f_auto,q_auto transforms wherever the URL is rendered.
        transformation: [{ width: 1000, height: 1000, crop: "limit" }],
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error("Cloudinary upload failed with no result"));
          return;
        }
        resolve({ secure_url: result.secure_url, public_id: result.public_id });
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

/**
 * Deletes a previously-uploaded image. Safe to call with undefined/null —
 * no-ops in that case (e.g. employee had no photo yet).
 */
export async function deleteFromCloudinary(publicId?: string | null): Promise<void> {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    // Log but don't throw — a failed cleanup of an old image shouldn't
    // block the user's create/update operation from succeeding.
    console.error(`Failed to delete Cloudinary asset ${publicId}:`, err);
  }
}