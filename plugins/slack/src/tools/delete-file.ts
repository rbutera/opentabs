import { slackApi } from '../slack-api.js';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const deleteFile = defineTool({
  name: 'delete_file',
  displayName: 'Delete File',
  description: 'Delete a Slack file by ID. The caller must own the file (or be a workspace admin).',
  summary: 'Delete a file',
  icon: 'trash-2',
  group: 'Files',
  input: z.object({
    file: z.string().min(1).describe('File ID to delete (e.g., F01234567)'),
  }),
  output: z.object({
    file: z.string().describe('ID of the deleted file'),
  }),
  handle: async params => {
    await slackApi('files.delete', { file: params.file });
    return { file: params.file };
  },
});
