import type { ActiveSegment, EpochMs } from './types';

/**
 * Durable recording session state machine (TECHNICAL_SPEC.md "Recorder state machine").
 *
 *   Idle → Recording            start (after preflight + countdown, which are UI-only)
 *   Recording ⇄ Paused          pause / resume (resume opens a new segment)
 *   Recording → Interrupted     process or permission loss
 *   Interrupted → Paused        recover the last checkpoint
 *   Paused | Interrupted → Idle finish (commit a saved run) or confirmed discard
 *
 * Pure: the recording service persists the resulting state in the same SQLite transaction
 * as the point journal, so a crash can never leave the two disagreeing.
 */

export type SessionStatus = 'recording' | 'paused' | 'interrupted';
export type InterruptReason = 'process' | 'permission';

export interface SessionState {
  status: SessionStatus;
  runId: string;
  startedAt: EpochMs;
  /** Closed active intervals, in order. */
  segments: ActiveSegment[];
  /** The open segment while recording; null otherwise. */
  openSegment: { index: number; startAt: EpochMs } | null;
  interruptedAt: EpochMs | null;
  interruptReason: InterruptReason | null;
  /** Sticky: the saved run is labelled interrupted even after recovery and resume. */
  wasInterrupted: boolean;
}

export type SessionCommand =
  | { type: 'start'; runId: string; at: EpochMs }
  | { type: 'pause'; at: EpochMs }
  | { type: 'resume'; at: EpochMs }
  /**
   * The open segment is closed at the last durable evidence of recording (last checkpoint),
   * never at the time the loss was noticed: missing time is not credited.
   */
  | { type: 'interrupt'; at: EpochMs; lastEvidenceAt: EpochMs; reason: InterruptReason }
  | { type: 'recover' }
  | { type: 'finish' }
  | { type: 'discard' };

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: SessionStatus | 'idle',
    readonly command: SessionCommand['type'],
  ) {
    super(`Cannot ${command} while ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

export interface FinishedSession {
  runId: string;
  startedAt: EpochMs;
  endedAt: EpochMs;
  segments: ActiveSegment[];
  interrupted: boolean;
}

export type TransitionResult =
  | { state: SessionState; finished: null; discarded: false }
  | { state: null; finished: FinishedSession | null; discarded: boolean };

function closeOpenSegment(state: SessionState, endAt: EpochMs): ActiveSegment[] {
  if (!state.openSegment) return state.segments;
  const end = Math.max(state.openSegment.startAt, endAt);
  return [...state.segments, { index: state.openSegment.index, startAt: state.openSegment.startAt, endAt: end }];
}

export function transition(state: SessionState | null, command: SessionCommand): TransitionResult {
  const from = state?.status ?? 'idle';
  switch (command.type) {
    case 'start': {
      if (state) throw new InvalidTransitionError(from, command.type);
      return {
        state: {
          status: 'recording',
          runId: command.runId,
          startedAt: command.at,
          segments: [],
          openSegment: { index: 0, startAt: command.at },
          interruptedAt: null,
          interruptReason: null,
          wasInterrupted: false,
        },
        finished: null,
        discarded: false,
      };
    }
    case 'pause': {
      if (!state || state.status !== 'recording') throw new InvalidTransitionError(from, command.type);
      return {
        state: { ...state, status: 'paused', segments: closeOpenSegment(state, command.at), openSegment: null },
        finished: null,
        discarded: false,
      };
    }
    case 'resume': {
      if (!state || state.status !== 'paused') throw new InvalidTransitionError(from, command.type);
      const lastEnd = state.segments[state.segments.length - 1]?.endAt ?? state.startedAt;
      return {
        state: {
          ...state,
          status: 'recording',
          openSegment: { index: state.segments.length, startAt: Math.max(command.at, lastEnd) },
          interruptedAt: null,
          interruptReason: null,
        },
        finished: null,
        discarded: false,
      };
    }
    case 'interrupt': {
      if (!state || state.status !== 'recording') throw new InvalidTransitionError(from, command.type);
      return {
        state: {
          ...state,
          status: 'interrupted',
          segments: closeOpenSegment(state, command.lastEvidenceAt),
          openSegment: null,
          interruptedAt: command.at,
          interruptReason: command.reason,
          wasInterrupted: true,
        },
        finished: null,
        discarded: false,
      };
    }
    case 'recover': {
      if (!state || state.status !== 'interrupted') throw new InvalidTransitionError(from, command.type);
      return { state: { ...state, status: 'paused' }, finished: null, discarded: false };
    }
    case 'finish': {
      if (!state || state.status === 'recording') throw new InvalidTransitionError(from, command.type);
      const lastEnd = state.segments[state.segments.length - 1]?.endAt ?? state.startedAt;
      return {
        state: null,
        finished: {
          runId: state.runId,
          startedAt: state.startedAt,
          endedAt: lastEnd,
          segments: state.segments,
          interrupted: state.wasInterrupted,
        },
        discarded: false,
      };
    }
    case 'discard': {
      if (!state || state.status === 'recording') throw new InvalidTransitionError(from, command.type);
      return { state: null, finished: null, discarded: true };
    }
  }
}

/** Active elapsed time: closed segments plus the open segment up to `now`. */
export function activeElapsedMs(state: SessionState, now: EpochMs): number {
  const closed = state.segments.reduce((sum, s) => sum + (s.endAt - s.startAt), 0);
  const open = state.openSegment ? Math.max(0, now - state.openSegment.startAt) : 0;
  return closed + open;
}
