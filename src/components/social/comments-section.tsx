import { useRouter } from 'expo-router';
import { Send, X } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Comment, FeedItem, Reply } from '@/api/feed-schemas';
import { IconButton, PrimaryButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, TextField } from '@/components/ui/elements';
import { timeAgo, useComments, useFeedActions } from '@/features/social/use-feed';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

import { ReportSheet, type ReportTarget } from './report-sheet';

const MAX = 500;

function CommentView({
  comment,
  reply,
  onReply,
  onDelete,
  onReport,
}: {
  comment: Comment | Reply;
  reply?: boolean;
  onReply?: () => void;
  onDelete: () => void;
  onReport: () => void;
}) {
  const router = useRouter();
  if (comment.removed || !comment.author || comment.body === null) {
    return (
      <View style={[styles.comment, reply && styles.reply]}>
        <Text variant="label" tone="secondary" style={styles.removed}>
          Comment removed.
        </Text>
      </View>
    );
  }
  const author = comment.author;
  return (
    <View style={[styles.comment, reply && styles.reply]} testID={`comment-${comment.id}`}>
      <View style={styles.meta}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${author.alias}’s profile`}
          onPress={() => router.push({ pathname: '/runner/[id]', params: { id: author.public_id } })}
          hitSlop={6}>
          <Text variant="labelStrong">{author.alias}</Text>
        </Pressable>
        <Text variant="caption" tone="secondary">
          {timeAgo(comment.created_at_ms)}
        </Text>
      </View>
      <Text variant="body" selectable>
        {comment.body}
      </Text>
      <View style={styles.commentActions}>
        {onReply ? <SmallAction label="Reply" onPress={onReply} /> : null}
        {comment.can_delete ? <SmallAction label="Delete" onPress={onDelete} /> : null}
        {!comment.is_mine ? <SmallAction label="Report" onPress={onReport} /> : null}
      </View>
    </View>
  );
}

function SmallAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={10} style={({ pressed }) => [styles.small, pressed && { opacity: 0.6 }]}>
      <Text variant="caption" tone="secondary" style={styles.smallText}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Comments with one level of replies (docs/ROADMAP.md 4.4). Comments pass the server's filter;
 * the author and the runner can delete them, and anyone else can report them.
 */
export function CommentsSection({ run }: { run: FeedItem }) {
  const comments = useComments(run.run_id);
  const actions = useFeedActions();
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; alias: string } | null>(null);
  const [report, setReport] = useState<ReportTarget | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const threads = comments.data?.data ?? [];
  const trimmed = body.trim();

  const send = async () => {
    if (!trimmed || actions.busy) return;
    const result = await actions.addComment(run.run_id, trimmed, replyTo?.id ?? null);
    if (result) {
      setBody('');
      setReplyTo(null);
    }
  };

  const reportTarget = (c: Comment | Reply): ReportTarget => ({
    kind: 'comment',
    id: c.id,
    owner: c.author ? { public_id: c.author.public_id, alias: c.author.alias } : null,
    runId: run.run_id,
  });

  return (
    <View style={styles.section}>
      <Text variant="section" accessibilityRole="header">
        Comments
      </Text>
      {comments.isError && !comments.data ? <InlineStatus tone="danger" title="Couldn’t load the comments." body="Check your connection and try again." /> : null}
      {threads.length === 0 && comments.data ? (
        <Text variant="label" tone="secondary">
          No comments yet.
        </Text>
      ) : null}
      {threads.map((thread) => (
        <View key={thread.id} style={styles.thread}>
          <CommentView
            comment={thread}
            onReply={thread.author ? () => setReplyTo({ id: thread.id, alias: thread.author!.alias }) : undefined}
            onDelete={() => setDeleting(thread.id)}
            onReport={() => setReport(reportTarget(thread))}
          />
          {thread.replies.map((r) => (
            <CommentView
              key={r.id}
              comment={r}
              reply
              onReply={r.author ? () => setReplyTo({ id: r.id, alias: r.author!.alias }) : undefined}
              onDelete={() => setDeleting(r.id)}
              onReport={() => setReport(reportTarget(r))}
            />
          ))}
        </View>
      ))}

      {replyTo ? (
        <View style={styles.replying}>
          <Text variant="label" tone="secondary" style={{ flex: 1 }}>
            Replying to {replyTo.alias}
          </Text>
          <IconButton icon={X} label="Stop replying" tone="plain" onPress={() => setReplyTo(null)} />
        </View>
      ) : null}
      <TextField
        label={replyTo ? `Reply to ${replyTo.alias}` : 'Add a comment'}
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={MAX}
        placeholder="Be kind. Links aren’t allowed."
        hint={body.length > MAX - 50 ? `${MAX - body.length} characters left` : undefined}
        style={styles.input}
        testID="comment-input"
      />
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      <PrimaryButton label={replyTo ? 'Reply' : 'Comment'} icon={Send} onPress={() => void send()} disabled={!trimmed} loading={actions.busy} testID="comment-send" />

      <ConfirmSheet
        visible={deleting !== null}
        title="Delete this comment?"
        body="It’s removed for everyone. Replies to it stay."
        confirmLabel="Delete"
        destructive
        busy={actions.busy}
        onConfirm={() => void actions.deleteComment(run.run_id, deleting!).then(() => setDeleting(null))}
        onCancel={() => setDeleting(null)}
      />
      <ReportSheet target={report} onClose={() => setReport(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  thread: { gap: space.sm },
  comment: { gap: 2, padding: space.md, borderRadius: radius.control, backgroundColor: colors.surface },
  reply: { marginLeft: space.xl },
  removed: { fontStyle: 'italic' },
  meta: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  commentActions: { flexDirection: 'row', gap: space.lg, marginTop: space.xs },
  small: { minHeight: 32, justifyContent: 'center' },
  smallText: { fontWeight: '600' },
  replying: { flexDirection: 'row', alignItems: 'center' },
  input: { minHeight: 88, textAlignVertical: 'top' },
});
