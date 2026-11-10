import { MAX_CHUNKS, UPLOAD_ID_PATTERN, decodeBase64, stageChunk } from '../upload-staging.js';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const stageUploadChunk = defineTool({
  name: 'stage_upload_chunk',
  displayName: 'Stage Upload Chunk',
  description:
    'Stage one base64 chunk of a large file in the Slack tab, for files too big for a single upload_file call ' +
    '(the OpenTabs server caps a request at 10 MiB). Split the file into chunks, base64-encode each, send them ' +
    'with the same upload_id, then call upload_file with staged_upload_id. Nothing is sent to Slack by this tool. ' +
    'Staged chunks expire after 15 minutes.',
  summary: 'Stage a chunk of a large file for upload_file',
  icon: 'upload',
  group: 'Files',
  input: z.object({
    upload_id: z
      .string()
      .regex(UPLOAD_ID_PATTERN)
      .describe('Caller-chosen ID shared by every chunk of one file (8-64 chars of A-Z, a-z, 0-9, _ or -)'),
    index: z.number().int().min(0).describe('Zero-based chunk index'),
    total: z.number().int().min(1).max(MAX_CHUNKS).describe(`Total number of chunks (max ${MAX_CHUNKS})`),
    content: z
      .string()
      .min(1)
      .max(8_000_000)
      .describe('This chunk as base64 (max 8,000,000 chars, about 6 MB of raw bytes)'),
  }),
  output: z.object({
    upload_id: z.string().describe('The upload ID'),
    received: z.number().describe('Chunks staged so far'),
    total: z.number().describe('Total chunks expected'),
    bytes: z.number().describe('Raw bytes staged so far'),
  }),
  handle: async params => {
    const { received, bytes } = stageChunk(params.upload_id, params.index, params.total, decodeBase64(params.content));
    return { upload_id: params.upload_id, received, total: params.total, bytes };
  },
});
