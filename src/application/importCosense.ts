import { randomUUID } from 'node:crypto';
import { normalizeLines, parseExportFile } from '../core/cosense.ts';
import { ulid } from '../core/id.ts';
import { titleLc } from '../core/title.ts';
import {
  importAttachments,
  type AttachmentImportContext,
  type AttachmentImportOptions,
  type AttachmentImportSummary,
} from './importAttachments.ts';
import { releaseAttachmentClaims } from './attachments.ts';
import { validateImportLines } from './importValidation.ts';
import type {
  Actor,
  AttachmentRepository,
  ImportLine,
  ImportPageInput,
  ImportPageResult,
  PageSnapshot,
  Project,
} from '../storage/types.ts';

export interface ImportRepository extends AttachmentRepository {
  ensureProject(name: string, now: number): Promise<Project>;
  setProjectDisplayName(projectId: string, displayName: string, now: number): Promise<void>;
  upsertActor(actor: Actor, now: number): Promise<string>;
  getActorById(id: string): Promise<Actor | null>;
  getPageByTitle(projectId: string, titleLcValue: string): Promise<PageSnapshot | null>;
  importPage(input: ImportPageInput): Promise<ImportPageResult>;
}

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

export async function importCosense(storage: ImportRepository, data: unknown, options: ImportOptions): Promise<ImportSummary> {
  const exp = parseExportFile(data);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const onConflict = options.onConflict ?? 'skip';
  const project = await storage.ensureProject(options.projectName, now);
  if (exp.displayName !== undefined && exp.displayName !== '') {
    await storage.setProjectDisplayName(project.id, exp.displayName, now);
  }

  const users = exp.users ?? [];
  const effectiveActorId = new Map<string, string>();
  for (const user of users) {
    const effective = await storage.upsertActor(
      { id: user.id, name: user.name, displayName: user.displayName ?? user.name },
      now,
    );
    effectiveActorId.set(user.id, effective);
  }
  const importerActorId = await storage.upsertActor(
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
      actorId: importerActorId,
      now,
      options: options.attachments,
      cache: new Map(),
      claimOwner: randomUUID(),
      summary: summary.attachments,
    };
  }
  for (const page of exp.pages) {
    let lines: ImportLine[] = [];
    for (const line of normalizeLines(page)) {
      let actorId = importerActorId;
      if (line.userId !== null) {
        actorId = effectiveActorId.get(line.userId) ?? line.userId;
        if (await storage.getActorById(actorId) === null) {
          await storage.upsertActor({ id: actorId, name: actorId, displayName: actorId }, now);
        }
      }
      lines.push({
        id: line.id ?? ulid(now * 1000),
        text: line.text,
        created: line.created ?? now,
        updated: line.updated ?? now,
        actorId,
      });
    }
    validateImportLines(page.title, lines);
    if (onConflict === 'skip' && await storage.getPageByTitle(project.id, titleLc(page.title)) !== null) {
      summary.skipped++;
      continue;
    }
    const attachmentSummaryBeforePage = summary.attachments === undefined ? undefined : { ...summary.attachments };
    if (attachmentContext !== undefined) attachmentContext.claimOwner = randomUUID();
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
        actorId: importerActorId,
        now,
        onConflict,
        attachmentClaimOwner: attachmentContext?.claimOwner,
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
  await releaseAttachmentClaims(context.storage, context.options.filesDir, context.claimOwner);
  context.cache.clear();
}
