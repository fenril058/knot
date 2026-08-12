import { normalizeLines, parseExportFile } from '../core/cosense.ts';
import { ulid } from '../core/id.ts';
import { titleLc } from '../core/title.ts';
import {
  importAttachments,
  type AttachmentImportContext,
  type AttachmentImportOptions,
  type AttachmentImportSummary,
} from './importAttachments.ts';
import { removeAttachmentIfUnreferenced } from './attachmentFiles.ts';
import { validateImportLines } from './importValidation.ts';
import type { ImportLine, Storage } from './types.ts';

export const IMPORTER_USER_NAME = 'knot-import';

export type ImportOptions = {
  projectName: string;
  onConflict?: 'skip' | 'overwrite';
  now?: number;
  attachments?: AttachmentImportOptions;
};

export type ImportSummary = {
  created: number;
  overwritten: number;
  skipped: number;
  users: number;
  attachments?: AttachmentImportSummary;
};

export async function importCosense(storage: Storage, data: unknown, options: ImportOptions): Promise<ImportSummary> {
  const exp = parseExportFile(data);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const onConflict = options.onConflict ?? 'skip';
  const project = await storage.ensureProject(options.projectName, now);
  if (exp.displayName !== undefined && exp.displayName !== '') {
    await storage.setProjectDisplayName(project.id, exp.displayName, now);
  }

  const users = exp.users ?? [];
  const effectiveUserId = new Map<string, string>();
  for (const user of users) {
    const effective = await storage.upsertDisplayUser(
      { id: user.id, name: user.name, displayName: user.displayName ?? user.name },
      now,
    );
    effectiveUserId.set(user.id, effective);
  }
  const importerId = await storage.upsertDisplayUser(
    { id: ulid(now * 1000), name: IMPORTER_USER_NAME, displayName: IMPORTER_USER_NAME },
    now,
  );

  const summary: ImportSummary = { created: 0, overwritten: 0, skipped: 0, users: users.length };
  let attachmentContext: AttachmentImportContext | undefined;
  if (options.attachments !== undefined) {
    summary.attachments = { created: 0, reused: 0, failed: 0 };
    attachmentContext = {
      storage,
      projectId: project.id,
      userId: importerId,
      now,
      options: options.attachments,
      cache: new Map(),
      pageCreatedAttachmentIds: new Set(),
      summary: summary.attachments,
    };
  }
  for (const page of exp.pages) {
    let lines: ImportLine[] = normalizeLines(page).map((line) => ({
      id: line.id ?? ulid(now * 1000),
      text: line.text,
      created: line.created ?? now,
      updated: line.updated ?? now,
      userId: line.userId !== null ? (effectiveUserId.get(line.userId) ?? line.userId) : importerId,
    }));
    validateImportLines(page.title, lines);
    if (onConflict === 'skip' && await storage.getPageByTitle(project.id, titleLc(page.title)) !== null) {
      summary.skipped++;
      continue;
    }
    const attachmentSummaryBeforePage = summary.attachments === undefined ? undefined : { ...summary.attachments };
    attachmentContext?.pageCreatedAttachmentIds.clear();
    let result;
    try {
      if (attachmentContext !== undefined) lines = await importAttachments(lines, attachmentContext);
      result = await storage.importPage({
        projectId: project.id,
        page: {
          id: page.id ?? ulid(now * 1000),
          title: page.title,
          created: page.created ?? now,
          updated: page.updated ?? now,
        },
        lines,
        userId: importerId,
        now,
        onConflict,
      });
    } catch (error) {
      if (attachmentContext !== undefined) await cleanupPageAttachments(attachmentContext);
      throw error;
    }
    if (result.kind === 'skipped' && attachmentContext !== undefined) {
      await cleanupPageAttachments(attachmentContext);
      if (attachmentSummaryBeforePage !== undefined) Object.assign(summary.attachments!, attachmentSummaryBeforePage);
    }
    summary[result.kind]++;
  }
  return summary;
}

async function cleanupPageAttachments(context: AttachmentImportContext): Promise<void> {
  for (const id of context.pageCreatedAttachmentIds) {
    await removeAttachmentIfUnreferenced(context.storage, context.options.filesDir, id);
  }
  context.pageCreatedAttachmentIds.clear();
  context.cache.clear();
}
