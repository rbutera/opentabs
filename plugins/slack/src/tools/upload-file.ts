import { slackApi } from '../slack-api.js';
import { UPLOAD_ID_PATTERN, assembleStaged, decodeBase64, dropStaged } from '../upload-staging.js';
import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import type { ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

const BLOCKED_EXTENSIONS = new Set(['exe', 'sh', 'bat', 'cmd', 'com', 'app', 'dmg', 'msi', 'bin']);

const MAGIC_BYTES: Record<string, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47],
  jpg: [0xff, 0xd8, 0xff],
  jpeg: [0xff, 0xd8, 0xff],
  pdf: [0x25, 0x50, 0x44, 0x46],
  gif: [0x47, 0x49, 0x46],
};

/** Time allowed for the raw byte upload to Slack's upload URL. */
const UPLOAD_TIMEOUT_MS = 240_000;
/** The extension kills a tool after 25 s without a progress report, so report at least this often. */
const HEARTBEAT_MS = 5_000;

interface SlackFileShare {
  ts?: string;
}

interface SlackFileInfo {
  id?: string;
  title?: string;
  permalink?: string;
  shares?: {
    public?: Record<string, SlackFileShare[]>;
    private?: Record<string, SlackFileShare[]>;
  };
}

/**
 * POST the bytes to the pre-signed upload URL from files.getUploadURLExternal.
 * Uses XHR rather than fetch so upload progress can keep the dispatch alive.
 * The URL carries its own authorization, so no Slack token or cookie is sent.
 */
const postBytes = (
  uploadUrl: string,
  bytes: Uint8Array,
  filename: string,
  report: (sent: number, message: string) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = e => report(e.loaded, 'Uploading bytes');
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(ToolError.internal(`Upload URL returned HTTP ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
      }
    };
    xhr.onerror = () =>
      reject(
        new ToolError('upload-file: network error posting bytes to the upload URL', 'network_error', {
          category: 'internal',
          retryable: true,
        }),
      );
    xhr.ontimeout = () => reject(ToolError.timeout(`upload-file: byte upload timed out after ${UPLOAD_TIMEOUT_MS}ms`));
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart]), filename);
    xhr.send(form);
  });

const findShareTs = (file: SlackFileInfo, channel: string): string | undefined =>
  file.shares?.private?.[channel]?.[0]?.ts ?? file.shares?.public?.[channel]?.[0]?.ts;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const uploadFile = defineTool({
  name: 'upload_file',
  displayName: 'Upload File',
  description:
    'Upload a file to a Slack channel or thread (files.getUploadURLExternal + files.completeUploadExternal). ' +
    'Pass the file as `content` in one call, or, for files over about 7 MB (the OpenTabs server caps a request ' +
    'at 10 MiB), stage it with stage_upload_chunk and pass `staged_upload_id`.',
  summary: 'Upload a file to a channel or thread',
  icon: 'upload',
  group: 'Files',
  input: z.object({
    channel: z.string().min(1).describe('Channel ID to share the file to (e.g., C01234567)'),
    content: z
      .string()
      .min(1)
      .max(40_000_000)
      .optional()
      .describe(
        'File content as a UTF-8 string (text files) or base64-encoded string (binary files). ' +
          'Omit when using staged_upload_id. One request is capped at 10 MiB by the OpenTabs server.',
      ),
    is_base64: z
      .boolean()
      .optional()
      .describe(
        'Set to true when content is base64-encoded (e.g., binary files like images or PDFs). Defaults to false (UTF-8 text).',
      ),
    staged_upload_id: z
      .string()
      .regex(UPLOAD_ID_PATTERN)
      .optional()
      .describe('Upload ID of a file staged with stage_upload_chunk. Use instead of content.'),
    filename: z.string().min(1).describe('Name of the file including extension (e.g., report.txt, image.png)'),
    title: z.string().optional().describe('Title for the file displayed in Slack'),
    initial_comment: z.string().optional().describe('Message text to include with the file upload'),
    thread_ts: z.string().optional().describe('Timestamp of a parent message, to upload the file into that thread'),
    filetype: z
      .string()
      .optional()
      .describe('Ignored by the current Slack upload API (type is detected from the file); kept for compatibility'),
  }),
  output: z.object({
    file: z
      .object({
        id: z.string().describe('File ID'),
        title: z.string().describe('File title'),
        permalink: z.string().optional().describe('File permalink'),
      })
      .describe('Uploaded file metadata'),
    channel: z.string().describe('Channel the file was shared to'),
    ts: z.string().optional().describe('Timestamp of the message that shares the file, when Slack reports it in time'),
    message_permalink: z.string().optional().describe('Permalink of that message'),
  }),
  handle: async (params, context?: ToolHandlerContext) => {
    const ext = params.filename.includes('.') ? params.filename.split('.').pop()?.toLowerCase() || '' : '';
    if (BLOCKED_EXTENSIONS.has(ext)) {
      throw ToolError.validation(`File extension .${ext} is not allowed`);
    }
    if ((params.content === undefined) === (params.staged_upload_id === undefined)) {
      throw ToolError.validation('Pass exactly one of content or staged_upload_id');
    }

    let contentBytes: Uint8Array;
    let binary: boolean;
    if (params.staged_upload_id !== undefined) {
      contentBytes = assembleStaged(params.staged_upload_id);
      binary = true;
    } else {
      const content = params.content as string;
      binary = params.is_base64 === true;
      contentBytes = binary ? decodeBase64(content) : new TextEncoder().encode(content);
    }
    if (contentBytes.length === 0) {
      throw ToolError.validation('File is empty');
    }

    if (binary) {
      const expectedMagic = MAGIC_BYTES[ext];
      if (expectedMagic && !expectedMagic.every((byte, i) => contentBytes[i] === byte)) {
        throw ToolError.validation(`File content does not match expected .${ext} format (magic bytes mismatch)`);
      }
    }

    const total = contentBytes.length;
    let lastSent = 0;
    let lastMessage = 'Starting upload';
    const report = (sent: number, message: string) => {
      lastSent = sent;
      lastMessage = message;
      context?.reportProgress({ progress: sent, total, message });
    };
    // Keep the dispatch alive while waiting on Slack, even when no bytes move.
    const heartbeat = setInterval(() => report(lastSent, lastMessage), HEARTBEAT_MS);

    try {
      report(0, 'Requesting upload URL');
      const urlData = await slackApi<{ upload_url?: string; file_id?: string }>('files.getUploadURLExternal', {
        filename: params.filename,
        length: total,
      });
      const uploadUrl = urlData.upload_url;
      const fileId = urlData.file_id;
      if (typeof uploadUrl !== 'string' || !uploadUrl.startsWith('https://') || typeof fileId !== 'string') {
        throw ToolError.internal('files.getUploadURLExternal returned no usable upload_url/file_id');
      }

      await postBytes(uploadUrl, contentBytes, params.filename, report);

      report(total, 'Sharing file');
      const title = params.title ?? params.filename;
      const done = await slackApi<{ files?: SlackFileInfo[] }>('files.completeUploadExternal', {
        files: [{ id: fileId, title }],
        channel_id: params.channel,
        thread_ts: params.thread_ts,
        initial_comment: params.initial_comment,
      });
      const completed = done.files?.[0];

      if (params.staged_upload_id !== undefined) dropStaged(params.staged_upload_id);

      // Sharing is asynchronous: the message ts shows up in files.info shortly after.
      let ts: string | undefined;
      let permalink = completed?.permalink;
      for (let attempt = 0; attempt < 8 && ts === undefined; attempt++) {
        if (attempt > 0) await sleep(750);
        try {
          const info = await slackApi<{ file?: SlackFileInfo }>('files.info', { file: fileId });
          if (info.file) {
            ts = findShareTs(info.file, params.channel);
            permalink = permalink ?? info.file.permalink;
          }
        } catch {
          // files.info is best effort; the upload already succeeded.
        }
      }

      let messagePermalink: string | undefined;
      if (ts !== undefined) {
        try {
          const link = await slackApi<{ permalink?: string }>('chat.getPermalink', {
            channel: params.channel,
            message_ts: ts,
          });
          messagePermalink = link.permalink;
        } catch {
          // best effort
        }
      }

      return {
        file: { id: fileId, title, ...(permalink ? { permalink } : {}) },
        channel: params.channel,
        ...(ts !== undefined ? { ts } : {}),
        ...(messagePermalink !== undefined ? { message_permalink: messagePermalink } : {}),
      };
    } finally {
      clearInterval(heartbeat);
    }
  },
});
