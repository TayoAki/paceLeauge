import { z } from 'zod';

/**
 * Runtime schemas for clubs (docs/ROADMAP.md 4.5). Field names mirror
 * db/migrations/20261003000200_clubs.sql.
 */
export const clubRoleSchema = z.enum(['owner', 'admin', 'member']);
export type ClubRole = z.infer<typeof clubRoleSchema>;
export const clubVisibilitySchema = z.enum(['public', 'invite_only']);
export type ClubVisibility = z.infer<typeof clubVisibilitySchema>;

export const clubSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  visibility: clubVisibilitySchema,
  status: z.enum(['active', 'closed']),
  member_count: z.number(),
  capacity: z.number(),
  my_role: clubRoleSchema.nullable(),
  is_member: z.boolean(),
  /** Members only. */
  chat_url: z.string().nullable(),
  admins: z.array(z.object({ alias: z.string(), role: clubRoleSchema })),
  can_join: z.boolean(),
  created_at_ms: z.number(),
});
export type Club = z.infer<typeof clubSchema>;
export const clubsSchema = z.array(clubSchema);

const boardRow = z.object({
  member_id: z.string(),
  rank: z.number(),
  alias: z.string().nullable(),
  tier: z.string().nullable(),
  weekly_xp: z.number(),
  role: clubRoleSchema,
  is_me: z.boolean(),
  hidden: z.boolean(),
});
export type ClubBoardRow = z.infer<typeof boardRow>;

export const clubBoardSchema = z.object({
  week_start: z.string(),
  members: z.number(),
  rows: z.array(boardRow),
  me: boardRow.nullable(),
  state: z.enum(['in_progress', 'settling', 'final']),
});
export type ClubBoard = z.infer<typeof clubBoardSchema>;

export const clubMemberSchema = z.object({
  member_id: z.string(),
  alias: z.string().nullable(),
  public_id: z.string().nullable(),
  role: clubRoleSchema,
  is_me: z.boolean(),
  hidden: z.boolean(),
  joined_at_ms: z.number(),
});
export type ClubMember = z.infer<typeof clubMemberSchema>;
export const clubMembersSchema = z.array(clubMemberSchema);

export const clubInviteSchema = z.object({ code: z.string(), expires_at_ms: z.number() });
export const clubLeftSchema = z.object({ left: z.boolean(), club_id: z.string() });
export const groupRunRemovedSchema = z.object({ removed: z.boolean() });
