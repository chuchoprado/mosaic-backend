import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';

const R2_ACCOUNT_ID       = process.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID    = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY= process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET_NAME      = process.env.R2_BUCKET_NAME ?? 'mosaic-evidence';
const R2_ENDPOINT         = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const UPLOAD_EXPIRY_SECONDS = parseInt(process.env.R2_PRESIGNED_UPLOAD_EXPIRY ?? '900', 10);
const GET_EXPIRY_SECONDS    = parseInt(process.env.R2_PRESIGNED_GET_EXPIRY ?? '3600', 10);

export const r2Client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId:     R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Generate a presigned PUT URL for uploading evidence photos.
 * The upload goes directly from the client to R2 — the backend never proxies the file.
 *
 * @param familyId  Used to namespace files per family
 * @param submissionId  Unique per submission
 * @returns { uploadUrl, key }
 */
export async function generateUploadUrl(
  familyId: string,
  submissionId: string,
): Promise<{ uploadUrl: string; key: string }> {
  // e.g. families/abc123/submissions/def456.jpg
  const key = `families/${familyId}/submissions/${submissionId}-${uuidv4()}.jpg`;

  const command = new PutObjectCommand({
    Bucket:      R2_BUCKET_NAME,
    Key:         key,
    ContentType: 'image/jpeg',
    // Enforce max file size at the S3 policy level (10 MB)
    // R2 does not support ContentLengthRange in presigned URLs yet;
    // enforce at application layer via multipart limits
  });

  const uploadUrl = await getSignedUrl(r2Client, command, {
    expiresIn: UPLOAD_EXPIRY_SECONDS,
  });

  return { uploadUrl, key };
}

/**
 * Generate a presigned GET URL for reading an evidence photo.
 * Parents receive a short-lived URL to view the photo.
 *
 * @param key  The R2 object key (stored in task_submissions.evidence_photo_key)
 * @returns Presigned GET URL
 */
export async function generateGetUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key:    key,
  });

  return getSignedUrl(r2Client, command, {
    expiresIn: GET_EXPIRY_SECONDS,
  });
}

/**
 * Check if an object exists in R2 without downloading it.
 * Used to validate that the client actually uploaded the photo before confirming the submission.
 */
export async function objectExists(key: string): Promise<boolean> {
  try {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    await r2Client.send(new HeadObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key:    key,
    }));
    return true;
  } catch {
    return false;
  }
}
