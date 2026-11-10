import { ToolError } from '@opentabs-dev/plugin-sdk';

/**
 * In-page staging area for files too large to send in one tool call.
 *
 * The OpenTabs server caps a tool-call request body at 10 MiB, so a 25 MB
 * video cannot travel as one base64 argument. Callers split the base64 into
 * chunks, send each with `stage_upload_chunk`, then call `upload_file` with
 * `staged_upload_id`. Chunks live in this adapter's memory (the Slack tab's
 * page context) and are never sent anywhere until `upload_file` runs.
 */

interface StagedUpload {
  total: number;
  chunks: (Uint8Array | undefined)[];
  bytes: number;
  touched: number;
}

const STAGE_TTL_MS = 15 * 60 * 1000;
const MAX_STAGED_BYTES = 256 * 1024 * 1024;
export const MAX_CHUNKS = 128;
export const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const staged = new Map<string, StagedUpload>();

const purgeStale = (now: number): void => {
  for (const [id, entry] of staged) {
    if (now - entry.touched > STAGE_TTL_MS) staged.delete(id);
  }
};

const stagedBytesTotal = (): number => {
  let sum = 0;
  for (const entry of staged.values()) sum += entry.bytes;
  return sum;
};

export const decodeBase64 = (content: string): Uint8Array => {
  try {
    return Uint8Array.from(atob(content), c => c.charCodeAt(0));
  } catch {
    throw ToolError.validation('Invalid base64 content — ensure the content is properly base64-encoded');
  }
};

export const stageChunk = (
  uploadId: string,
  index: number,
  total: number,
  bytes: Uint8Array,
): { received: number; bytes: number } => {
  const now = Date.now();
  purgeStale(now);
  let entry = staged.get(uploadId);
  if (!entry) {
    entry = { total, chunks: new Array<Uint8Array | undefined>(total), bytes: 0, touched: now };
    staged.set(uploadId, entry);
  }
  if (entry.total !== total) {
    throw ToolError.validation(`Upload ${uploadId} was started with total=${entry.total}, got total=${total}`);
  }
  if (index >= total) {
    throw ToolError.validation(`Chunk index ${index} is out of range for total=${total}`);
  }
  const previous = entry.chunks[index];
  const growth = bytes.length - (previous?.length ?? 0);
  if (stagedBytesTotal() + growth > MAX_STAGED_BYTES) {
    throw ToolError.validation(`Staging limit of ${MAX_STAGED_BYTES} bytes exceeded`);
  }
  entry.chunks[index] = bytes;
  entry.bytes += growth;
  entry.touched = now;
  let received = 0;
  for (let i = 0; i < entry.total; i++) {
    if (entry.chunks[i] !== undefined) received++;
  }
  return { received, bytes: entry.bytes };
};

/** Concatenate a fully staged upload. Throws if any chunk is missing. Does not remove it. */
export const assembleStaged = (uploadId: string): Uint8Array => {
  purgeStale(Date.now());
  const entry = staged.get(uploadId);
  if (!entry) {
    throw ToolError.notFound(`No staged upload ${uploadId} (never staged, or expired after 15 minutes)`);
  }
  const missing: number[] = [];
  // A plain loop, not forEach: the chunk array starts sparse and forEach skips holes.
  for (let i = 0; i < entry.total; i++) {
    if (entry.chunks[i] === undefined) missing.push(i);
  }
  if (missing.length > 0) {
    throw ToolError.validation(`Staged upload ${uploadId} is missing chunks: ${missing.join(', ')}`);
  }
  const out = new Uint8Array(entry.bytes);
  let offset = 0;
  for (let i = 0; i < entry.total; i++) {
    const chunk = entry.chunks[i] as Uint8Array;
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export const dropStaged = (uploadId: string): void => {
  staged.delete(uploadId);
};
