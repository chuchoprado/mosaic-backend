/**
 * Submissions Router
 *
 * POST /submissions                      — child submits a task
 * POST /submissions/:id/confirm          — confirm photo upload
 * GET  /submissions                      — list submissions
 * GET  /submissions/:id                  — get single submission
 * GET  /submissions/:id/photo            — redirect to presigned photo URL
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/supabase.js';
import { generateUploadUrl, generateGetUrl, objectExists } from '../lib/r2.js';
import { notifyNewSubmission } from '../lib/firebase.js';

const CreateSubmissionSchema = z.object({
  taskId:   z.string().uuid(),
  note:     z.string().max(1000).optional(),
  hasPhoto: z.boolean().default(false),
});

const ConfirmUploadSchema = z.object({
  uploadKey: z.string().max(500),
});

const ListSubmissionsQuerySchema = z.object({
  childId:  z.string().uuid().optional(),
  taskId:   z.string().uuid().optional(),
  status:   z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
  limit:    z.coerce.number().int().min(1).max(100).default(20),
  cursor:   z.string().optional(),
});

export async function submissionsRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST /submissions ─────────────────────────────────────
  fastify.post(
    '/',
    { preHandler: [fastify.authenticate, fastify.requireChild] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;

      const body = CreateSubmissionSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const { taskId, note, hasPhoto } = body.data;

      // Verify task belongs to this child
      const taskRows = await sql<{
        id: string;
        requiresPhoto: boolean;
        unlockMinutes: number;
        familyId: string;
      }[]>`
        SELECT id, requires_photo, unlock_minutes, family_id
        FROM tasks
        WHERE id = ${taskId}
          AND child_id = ${user.id}
          AND family_id = ${user.familyId}
          AND status = 'active'
        LIMIT 1
      `;

      const task = taskRows[0];
      if (!task) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Task not found' },
        });
      }

      // Check no pending submission already exists
      const existing = await sql<{ id: string }[]>`
        SELECT id FROM task_submissions
        WHERE task_id = ${taskId}
          AND status = 'pending'
        LIMIT 1
      `;

      if (existing[0]) {
        return reply.status(409).send({
          error: {
            code:    'CONFLICT',
            message: 'This task already has a pending submission',
          },
        });
      }

      // Get the child's active device_id (most recent heartbeat)
      const deviceRows = await sql<{ id: string }[]>`
        SELECT id FROM devices
        WHERE child_id = ${user.id}
          AND is_active = TRUE
        ORDER BY last_heartbeat_at DESC NULLS LAST
        LIMIT 1
      `;

      const deviceId = deviceRows[0]?.id ?? null;

      // Create submission
      const rows = await sql<{ id: string; submittedAt: Date; expiresAt: Date }[]>`
        INSERT INTO task_submissions (
          task_id, child_id, family_id, note, status, device_id
        )
        VALUES (
          ${taskId}, ${user.id}, ${user.familyId},
          ${note ?? null}, 'pending', ${deviceId}
        )
        RETURNING id, submitted_at, expires_at
      `;

      const submission = rows[0]!;

      // Generate presigned upload URL if photo is expected
      let uploadUrl: string | undefined;
      let uploadKey: string | undefined;
      let uploadExpiresAt: string | undefined;

      if (hasPhoto || task.requiresPhoto) {
        const presigned = await generateUploadUrl(user.familyId, submission.id);
        uploadUrl = presigned.uploadUrl;
        uploadKey = presigned.key;
        uploadExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }

      // If no photo required, notify parents immediately
      if (!hasPhoto && !task.requiresPhoto) {
        await notifyParentsOfSubmission(user.familyId, user.id, taskId, submission.id);
      }

      return reply.status(201).send({
        id:             submission.id,
        taskId,
        status:         'pending',
        note:           note ?? null,
        uploadUrl,
        uploadKey,
        uploadExpiresAt,
        submittedAt:    submission.submittedAt.toISOString(),
        expiresAt:      submission.expiresAt.toISOString(),
      });
    },
  );

  // ── POST /submissions/:id/confirm ─────────────────────────
  fastify.post(
    '/:submissionId/confirm',
    { preHandler: [fastify.authenticate, fastify.requireChild] },
    async (request: FastifyRequest<{ Params: { submissionId: string } }>, reply) => {
      const { submissionId } = request.params;
      const { user } = request;

      const body = ConfirmUploadSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const { uploadKey } = body.data;

      // Verify submission belongs to this child and is still pending
      const rows = await sql<{ id: string; taskId: string }[]>`
        SELECT id, task_id
        FROM task_submissions
        WHERE id = ${submissionId}
          AND child_id = ${user.id}
          AND status = 'pending'
        LIMIT 1
      `;

      if (!rows[0]) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Submission not found or not pending' },
        });
      }

      // Verify the object actually exists in R2
      const exists = await objectExists(uploadKey);
      if (!exists) {
        return reply.status(400).send({
          error: {
            code:    'UPLOAD_NOT_FOUND',
            message: 'Photo upload not found. Please upload the photo before confirming.',
          },
        });
      }

      // Update submission with evidence key
      await sql`
        UPDATE task_submissions
        SET evidence_photo_key = ${uploadKey}
        WHERE id = ${submissionId}
      `;

      // Notify parents
      await notifyParentsOfSubmission(
        user.familyId,
        user.id,
        rows[0].taskId,
        submissionId,
      );

      return reply.send({
        id:               submissionId,
        status:           'pending',
        evidencePhotoUrl: `/v1/submissions/${submissionId}/photo`,
      });
    },
  );

  // ── GET /submissions/stats ────────────────────────────────
  // Returns balance, streak, and milestone data for a child.
  // Child: always own stats. Parent: must supply ?childId=uuid
  fastify.get(
    '/stats',
    { preHandler: [fastify.authenticate, fastify.requireUser] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;
      const query = request.query as { childId?: string };

      const effectiveChildId = user.role === 'child'
        ? user.id
        : (query.childId ?? null);

      if (!effectiveChildId) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'childId is required for parents' },
        });
      }

      // Total minutes earned from approved approvals
      const balanceRows = await sql<{ totalMinutes: number }[]>`
        SELECT COALESCE(SUM(a.unlock_minutes_granted), 0)::INTEGER AS "totalMinutes"
        FROM approvals a
        JOIN task_submissions ts ON ts.id = a.submission_id
        WHERE ts.child_id  = ${effectiveChildId}
          AND ts.family_id = ${user.familyId}
          AND a.approved   = TRUE
      `;
      const balanceMinutes = balanceRows[0]?.totalMinutes ?? 0;

      // Total approved tasks ever
      const totalApprovedRows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::INTEGER AS count
        FROM approvals a
        JOIN task_submissions ts ON ts.id = a.submission_id
        WHERE ts.child_id  = ${effectiveChildId}
          AND ts.family_id = ${user.familyId}
          AND a.approved   = TRUE
      `;
      const totalApprovedTasks = totalApprovedRows[0]?.count ?? 0;

      // Today's stats (UTC day)
      const todayRows = await sql<{ approved: number }[]>`
        SELECT COUNT(*)::INTEGER AS approved
        FROM approvals a
        JOIN task_submissions ts ON ts.id = a.submission_id
        WHERE ts.child_id   = ${effectiveChildId}
          AND ts.family_id  = ${user.familyId}
          AND a.approved    = TRUE
          AND ts.submitted_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
      `;
      const todayApproved = todayRows[0]?.approved ?? 0;

      const todayTotalRows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::INTEGER AS count
        FROM tasks
        WHERE child_id  = ${effectiveChildId}
          AND family_id = ${user.familyId}
          AND status    = 'active'
      `;
      const todayTotal = todayTotalRows[0]?.count ?? 0;

      // Streak — distinct UTC days with ≥1 approved submission, working backwards from today
      const streakDaysRows = await sql<{ day: string }[]>`
        SELECT DISTINCT date_trunc('day', ts.submitted_at AT TIME ZONE 'UTC')::DATE::TEXT AS day
        FROM approvals a
        JOIN task_submissions ts ON ts.id = a.submission_id
        WHERE ts.child_id  = ${effectiveChildId}
          AND ts.family_id = ${user.familyId}
          AND a.approved   = TRUE
        ORDER BY day DESC
        LIMIT 90
      `;

      let streak = 0;
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const daySet = new Set(streakDaysRows.map(r => r.day));

      for (let i = 0; i <= 90; i++) {
        const d = new Date(today.getTime() - i * 86400000);
        const key = d.toISOString().slice(0, 10);
        if (daySet.has(key)) {
          streak++;
        } else if (i === 0) {
          // Today not completed yet — streak still counts from yesterday
          continue;
        } else {
          break;
        }
      }

      // Milestones
      const milestones: string[] = [];
      if (streak >= 3)  milestones.push('streak_3');
      if (streak >= 7)  milestones.push('streak_7');
      if (streak >= 14) milestones.push('streak_14');
      if (streak >= 30) milestones.push('streak_30');
      if (todayTotal > 0 && todayApproved >= todayTotal) milestones.push('perfect_day');
      if (totalApprovedTasks >= 10)  milestones.push('tasks_10');
      if (totalApprovedTasks >= 50)  milestones.push('tasks_50');
      if (totalApprovedTasks >= 100) milestones.push('tasks_100');
      if (balanceMinutes >= 60)   milestones.push('minutes_60');
      if (balanceMinutes >= 300)  milestones.push('minutes_300');
      if (balanceMinutes >= 600)  milestones.push('minutes_600');

      return reply.send({
        balanceMinutes,
        streak,
        todayApproved,
        todayTotal,
        totalApprovedTasks,
        milestones,
      });
    },
  );

  // ── GET /submissions ──────────────────────────────────────
  fastify.get(
    '/',
    { preHandler: [fastify.authenticate, fastify.requireUser] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;

      const query = ListSubmissionsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: query.error.message },
        });
      }

      const { childId, taskId, status, limit } = query.data;

      // Children can only see their own submissions
      const effectiveChildId = user.role === 'child' ? user.id : childId;

      const submissions = await sql<{
        id: string;
        taskId: string;
        taskTitle: string;
        taskIcon: string | null;
        taskUnlockMinutes: number;
        childId: string;
        childName: string;
        status: string;
        note: string | null;
        evidencePhotoKey: string | null;
        submittedAt: Date;
        expiresAt: Date;
        reviewedAt: Date | null;
        unlockMinutesGranted: number | null;
        approvalComment: string | null;
      }[]>`
        SELECT
          ts.id,
          ts.task_id,
          t.title  AS task_title,
          t.icon   AS task_icon,
          t.unlock_minutes AS task_unlock_minutes,
          ts.child_id,
          u.display_name AS child_name,
          ts.status,
          ts.note,
          ts.evidence_photo_key,
          ts.submitted_at,
          ts.expires_at,
          ts.reviewed_at,
          a.unlock_minutes_granted,
          a.comment AS approval_comment
        FROM task_submissions ts
        JOIN tasks t   ON t.id  = ts.task_id
        JOIN users u   ON u.id  = ts.child_id
        LEFT JOIN approvals a ON a.submission_id = ts.id
        WHERE ts.family_id = ${user.familyId}
          ${effectiveChildId ? sql`AND ts.child_id = ${effectiveChildId}` : sql``}
          ${taskId  ? sql`AND ts.task_id = ${taskId}` : sql``}
          ${status  ? sql`AND ts.status = ${status}::submission_status` : sql``}
        ORDER BY ts.submitted_at DESC
        LIMIT ${limit}
      `;

      return reply.send({
        submissions: submissions.map(s => ({
          id:                   s.id,
          taskId:               s.taskId,
          taskTitle:            s.taskTitle,
          taskEmoji:            s.taskIcon,
          taskUnlockMinutes:    s.taskUnlockMinutes,
          childId:              s.childId,
          childName:            s.childName,
          status:               s.status,
          note:                 s.note,
          hasPhoto:             !!s.evidencePhotoKey,
          submittedAt:          s.submittedAt.toISOString(),
          expiresAt:            s.expiresAt.toISOString(),
          reviewedAt:           s.reviewedAt?.toISOString() ?? null,
          unlockMinutesGranted: s.unlockMinutesGranted ?? null,
          approvalComment:      s.approvalComment ?? null,
        })),
      });
    },
  );

  // ── GET /submissions/:id ──────────────────────────────────
  fastify.get(
    '/:submissionId',
    { preHandler: [fastify.authenticate, fastify.requireUser] },
    async (request: FastifyRequest<{ Params: { submissionId: string } }>, reply) => {
      const { submissionId } = request.params;
      const { user } = request;

      const rows = await sql<{
        id: string;
        taskId: string;
        taskTitle: string;
        taskUnlockMinutes: number;
        childId: string;
        status: string;
        note: string | null;
        evidencePhotoKey: string | null;
        submittedAt: Date;
        expiresAt: Date;
        reviewedAt: Date | null;
        approvedBool: boolean | null;
        approvalComment: string | null;
        unlockMinutesGranted: number | null;
      }[]>`
        SELECT
          ts.id,
          ts.task_id,
          t.title AS task_title,
          t.unlock_minutes AS task_unlock_minutes,
          ts.child_id,
          ts.status,
          ts.note,
          ts.evidence_photo_key,
          ts.submitted_at,
          ts.expires_at,
          ts.reviewed_at,
          a.approved AS approved_bool,
          a.comment  AS approval_comment,
          a.unlock_minutes_granted
        FROM task_submissions ts
        JOIN tasks t ON t.id = ts.task_id
        LEFT JOIN approvals a ON a.submission_id = ts.id
        WHERE ts.id = ${submissionId}
          AND ts.family_id = ${user.familyId}
          ${user.role === 'child' ? sql`AND ts.child_id = ${user.id}` : sql``}
        LIMIT 1
      `;

      const s = rows[0];
      if (!s) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Submission not found' },
        });
      }

      return reply.send({
        id:      s.id,
        taskId:  s.taskId,
        task: {
          title:         s.taskTitle,
          unlockMinutes: s.taskUnlockMinutes,
        },
        childId:         s.childId,
        status:          s.status,
        note:            s.note,
        evidencePhotoUrl:s.evidencePhotoKey
          ? `/v1/submissions/${s.id}/photo`
          : null,
        submittedAt:     s.submittedAt.toISOString(),
        expiresAt:       s.expiresAt.toISOString(),
        reviewedAt:      s.reviewedAt?.toISOString() ?? null,
        approval:        s.approvedBool !== null
          ? {
              approved:             s.approvedBool,
              comment:              s.approvalComment,
              unlockMinutesGranted: s.unlockMinutesGranted,
              reviewedAt:           s.reviewedAt?.toISOString(),
            }
          : null,
      });
    },
  );

  // ── GET /submissions/:id/photo ────────────────────────────
  fastify.get(
    '/:submissionId/photo',
    { preHandler: [fastify.authenticate, fastify.requireUser] },
    async (request: FastifyRequest<{ Params: { submissionId: string } }>, reply) => {
      const { submissionId } = request.params;
      const { user } = request;

      const rows = await sql<{ evidencePhotoKey: string | null }[]>`
        SELECT evidence_photo_key
        FROM task_submissions
        WHERE id = ${submissionId}
          AND family_id = ${user.familyId}
          ${user.role === 'child' ? sql`AND child_id = ${user.id}` : sql``}
        LIMIT 1
      `;

      const photoKey = rows[0]?.evidencePhotoKey;
      if (!photoKey) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Photo not found' },
        });
      }

      const url = await generateGetUrl(photoKey);
      return reply.redirect(302, url);
    },
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function notifyParentsOfSubmission(
  familyId: string,
  childId: string,
  taskId: string,
  submissionId: string,
): Promise<void> {
  const rows = await sql<{
    childName: string;
    taskTitle: string;
    tokens: string[];
  }[]>`
    SELECT
      u.display_name AS child_name,
      t.title AS task_title,
      ARRAY_AGG(nt.token) FILTER (WHERE nt.token IS NOT NULL AND nt.is_active = TRUE) AS tokens
    FROM users u
    CROSS JOIN tasks t
    LEFT JOIN notification_tokens nt
      ON nt.family_id = ${familyId}
      AND nt.is_active = TRUE
      AND nt.user_id IN (
        SELECT id FROM users WHERE family_id = ${familyId} AND role = 'parent'
      )
    WHERE u.id = ${childId}
      AND t.id = ${taskId}
    GROUP BY u.display_name, t.title
    LIMIT 1
  `;

  const data = rows[0];
  if (!data?.tokens?.length) return;

  await notifyNewSubmission(
    data.tokens,
    data.childName,
    data.taskTitle,
    submissionId,
  );
}
