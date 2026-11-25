'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  callsExportPath,
  isLiveCall,
  useCall,
  useCallDays,
  useCallTranscript,
  useDayCalls,
  useLocations,
  type Call,
  type CallDay,
  type CallRange,
  type TranscriptTurn,
} from '@/lib/queries';
import { useAuth } from '@/lib/auth';
import { dayKeyInTz, dayLabel, rangeInTz, shiftDay } from '@/lib/time';

const STATUS_STYLES: Record<string, string> = {
  started: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-blue-100 text-blue-700',
  transferred: 'bg-amber-100 text-amber-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString();
}
/** Just the clock: the day is the group the row sits in. */
function fmtClock(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function fmtDuration(start: string, end?: string | null) {
  if (!end) return '—';
  const secs = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
/** Offset into the call, so a turn can be found in a recording later. */
function fmtOffset(ms?: number) {
  if (ms == null) return null;
  const secs = Math.round(ms / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={
        'rounded-full px-2 py-0.5 text-xs font-medium ' +
        (STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-600')
      }
    >
      {status}
    </span>
  );
}

type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';

const PRESETS: Array<[Preset, string]> = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['month', 'This month'],
  ['custom', 'Custom'],
];

/** The day keys a preset covers, in the location's timezone. */
function presetDays(preset: Preset, today: string, custom: { from: string; to: string }) {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: shiftDay(today, -1), to: shiftDay(today, -1) };
    case '7d':
      return { from: shiftDay(today, -6), to: today };
    case '30d':
      return { from: shiftDay(today, -29), to: today };
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'custom':
      return custom.from <= custom.to ? custom : { from: custom.to, to: custom.from };
  }
}

export default function CallsPage() {
  const { activeLocationId, canManage, apiBlob } = useAuth();
  const locations = useLocations();
  const tz = locations.data?.find((l) => l.id === activeLocationId)?.timezone ?? 'UTC';
  const today = dayKeyInTz(new Date(), tz);

  const [preset, setPreset] = useState<Preset>('7d');
  const [custom, setCustom] = useState({ from: shiftDay(today, -6), to: today });
  const days = presetDays(preset, today, custom);
  const range = useMemo(() => rangeInTz(days.from, days.to, tz), [days.from, days.to, tz]);

  const summary = useCallDays(activeLocationId ?? undefined, range, tz);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A link from elsewhere (a message's "see the call") names the call to open.
  // Read after mount so the server and first client render agree.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('call');
    if (wanted) setSelectedId(wanted);
  }, []);
  // Today opens by itself; every other day is a row until asked. Tracked as
  // explicit toggles so re-fetches never snap a day shut on the reader.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const isOpen = (day: string) => toggled[day] ?? day === today;

  const exporting = useMutation({
    mutationFn: async () => {
      const { blob, filename } = await apiBlob(callsExportPath(activeLocationId!, range, tz));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename ?? `calls-${days.from}-to-${days.to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  const totals = (summary.data?.days ?? []).reduce(
    (t, d) => ({ calls: t.calls + d.calls, orders: t.orders + d.orders }),
    { calls: 0, orders: 0 },
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-bold">Calls</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
            {PRESETS.map(([key, label]) => (
              <button
                key={key}
                onClick={() => setPreset(key)}
                className={
                  'rounded-md px-2.5 py-1 ' +
                  (preset === key ? 'bg-brayz text-white' : 'text-slate-600 hover:bg-slate-50')
                }
              >
                {label}
              </button>
            ))}
          </div>
          {preset === 'custom' && (
            <span className="flex items-center gap-1">
              <input
                type="date"
                value={custom.from}
                max={today}
                onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))}
                className="rounded border border-slate-300 px-2 py-1"
              />
              <span className="text-slate-400">to</span>
              <input
                type="date"
                value={custom.to}
                max={today}
                onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))}
                className="rounded border border-slate-300 px-2 py-1"
              />
            </span>
          )}
          {canManage && (
            // Manager and up: the file carries every caller's number, and the
            // API writes an audit entry for each export.
            <button
              onClick={() => exporting.mutate()}
              disabled={exporting.isPending || !activeLocationId || totals.calls === 0}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-slate-700 hover:border-slate-300 disabled:opacity-50"
              title="Download these days as a CSV"
            >
              {exporting.isPending ? 'Exporting…' : 'Export CSV'}
            </button>
          )}
        </div>
      </div>
      {exporting.isError && (
        <p className="mb-4 text-sm text-red-600">
          {(exporting.error as Error).message.replace(/^API \d+ [^:]+: /, '')}
        </p>
      )}

      {summary.isLoading && <p className="text-slate-500">Loading…</p>}

      {summary.data && summary.data.days.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-400">
          {preset === 'today'
            ? 'No calls yet today.'
            : 'No calls in this range. Widen it, or pick a custom one.'}
        </div>
      )}

      {summary.data && summary.data.days.length > 0 && (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              {totals.calls} call{totals.calls === 1 ? '' : 's'} and {totals.orders} order
              {totals.orders === 1 ? '' : 's'} across {summary.data.days.length} day
              {summary.data.days.length === 1 ? '' : 's'}, in {tz.replace(/_/g, ' ')} time.
            </p>
            {summary.data.days.map((d) => (
              <DayGroup
                key={d.day}
                day={d}
                label={dayLabel(d.day, today)}
                open={isOpen(d.day)}
                live={d.day === today}
                onToggle={() => setToggled((t) => ({ ...t, [d.day]: !isOpen(d.day) }))}
                range={rangeInTz(d.day, d.day, tz)}
                locationId={activeLocationId ?? undefined}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            ))}
          </div>

          <div>
            {selectedId ? (
              <CallDetailPanel id={selectedId} onClose={() => setSelectedId(null)} />
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-400">
                Select a call to read its transcript.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One day of calls: a row with the day's counts that opens into its table.
 * The table is only fetched once the day is open, a page at a time, so a
 * month of a busy restaurant is a list of thirty rows until one is wanted.
 */
function DayGroup({
  day,
  label,
  open,
  live,
  onToggle,
  range,
  locationId,
  selectedId,
  onSelect,
}: {
  day: CallDay;
  label: string;
  open: boolean;
  live: boolean;
  onToggle: () => void;
  range: CallRange;
  locationId: string | undefined;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50"
      >
        <span
          aria-hidden
          className="inline-flex h-5 w-5 items-center justify-center rounded border border-slate-300 font-mono text-xs leading-none text-slate-500"
        >
          {open ? '−' : '+'}
        </span>
        <span className="font-medium">{label}</span>
        <span className="text-xs text-slate-400">{day.day}</span>
        <span className="ml-auto flex gap-3 text-xs tabular-nums text-slate-500">
          <span>
            {day.calls} call{day.calls === 1 ? '' : 's'}
          </span>
          {day.orders > 0 && <span className="text-green-700">{day.orders} ordered</span>}
          {day.transferred > 0 && <span className="text-amber-700">{day.transferred} transferred</span>}
          {day.failed > 0 && <span className="text-red-600">{day.failed} failed</span>}
        </span>
      </button>
      {open && (
        <DayTable range={range} live={live} locationId={locationId} selectedId={selectedId} onSelect={onSelect} />
      )}
    </div>
  );
}

function DayTable({
  range,
  live,
  locationId,
  selectedId,
  onSelect,
}: {
  range: CallRange;
  live: boolean;
  locationId: string | undefined;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const pages = useDayCalls(locationId, range, { live });
  const calls = pages.data?.pages.flatMap((p) => p.calls) ?? [];

  if (pages.isLoading) return <p className="border-t border-slate-100 px-4 py-3 text-sm text-slate-500">Loading…</p>;

  return (
    <div className="border-t border-slate-100">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-slate-500">
          <tr>
            <th className="px-4 py-2 font-medium">From</th>
            <th className="px-4 py-2 font-medium">Time</th>
            <th className="px-4 py-2 font-medium">Duration</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Summary</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {calls.map((c) => {
            const active = c.id === selectedId;
            return (
              <tr
                key={c.id}
                onClick={() => onSelect(c.id)}
                aria-selected={active}
                className={'cursor-pointer ' + (active ? 'bg-brayz/5' : 'hover:bg-slate-50')}
              >
                <td className="px-4 py-2 tabular-nums">{c.fromNumber ?? 'Unknown'}</td>
                <td className="px-4 py-2 tabular-nums text-slate-600">{fmtClock(c.startedAt)}</td>
                <td className="px-4 py-2 tabular-nums text-slate-600">{fmtDuration(c.startedAt, c.endedAt)}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={c.status} />
                </td>
                <td className="max-w-xs truncate px-4 py-2 text-slate-600">{c.summary ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {pages.hasNextPage && (
        <button
          onClick={() => pages.fetchNextPage()}
          disabled={pages.isFetchingNextPage}
          className="w-full border-t border-slate-100 px-4 py-2 text-xs text-brayz hover:bg-slate-50 disabled:opacity-50"
        >
          {pages.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function CallDetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const call = useCall(id);
  const live = isLiveCall(call.data?.status);
  const transcript = useCallTranscript(id, live);

  if (call.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (!call.data) return <p className="text-slate-500">Call not found.</p>;
  const c = call.data;
  const turns = transcript.data?.turns ?? [];

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">
              {c.fromNumber ?? 'Unknown'} <span className="text-slate-400">→</span>{' '}
              {c.toNumber ?? '—'}
            </h2>
            <p className="text-xs text-slate-500">{fmtTime(c.startedAt)}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:border-slate-300"
          >
            Close
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-slate-500">Status</dt>
            <dd className="mt-0.5">
              <StatusBadge status={c.status} />
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Duration</dt>
            <dd className="mt-0.5 tabular-nums">{fmtDuration(c.startedAt, c.endedAt)}</dd>
          </div>
        </dl>

        {c.summary && <p className="mt-4 border-t border-slate-100 pt-4 text-sm">{c.summary}</p>}

        {c.events
          .filter((e) => e.eventType === 'call.message')
          .map((e) => {
            const m = e.payload as { callerName?: string | null; callbackNumber?: string | null; body?: string };
            return (
              <div key={e.id} className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">Message for the restaurant</p>
                <p className="mt-1 text-slate-800">{m.body}</p>
                <p className="mt-1 text-xs text-slate-600">
                  {m.callerName ?? 'Caller'}
                  {m.callbackNumber ? ` · call back ${m.callbackNumber}` : ''}
                </p>
              </div>
            );
          })}

        <RecordingRow call={c} />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="mb-4 flex items-center gap-2 font-semibold">
          Transcript
          {live && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
              live
            </span>
          )}
        </h2>

        {transcript.isLoading && <p className="text-sm text-slate-500">Loading…</p>}

        {!transcript.isLoading && turns.length === 0 && (
          <p className="text-sm text-slate-400">
            {live
              ? 'Waiting for the first words of this call…'
              : 'No transcript was recorded for this call.'}
          </p>
        )}

        <ol className="space-y-3">
          {turns.map((turn, i) => (
            <Turn key={i} turn={turn} />
          ))}
        </ol>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="mb-4 font-semibold">Events</h2>
        {c.events.length === 0 ? (
          <p className="text-sm text-slate-400">No events recorded.</p>
        ) : (
          <ol className="space-y-1 text-sm">
            {c.events.map((e) => (
              <li key={e.id} className="flex justify-between gap-3">
                <span className="text-slate-700">{e.eventType}</span>
                <span className="tabular-nums text-slate-400">
                  {new Date(e.occurredAt).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function Turn({ turn }: { turn: TranscriptTurn }) {
  const caller = turn.speaker === 'caller';
  const offset = fmtOffset(turn.startedAtMs);
  return (
    <li className={'flex flex-col ' + (caller ? 'items-start' : 'items-end')}>
      <div
        className={
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm ' +
          // The tail sits on the bottom corner nearest the speaker's own side,
          // so a glance down the column reads as a conversation rather than a
          // stack of boxes — the same shape the marketing page's sample call
          // uses. Caller on the left, Brayz on the right.
          (caller
            ? 'rounded-bl-sm bg-slate-100 text-slate-800'
            : 'rounded-br-sm bg-brayz/10 text-slate-800')
        }
      >
        {turn.text}
      </div>
      <span className="mt-1 text-[10px] tabular-nums text-slate-400">
        {caller ? 'Caller' : 'Bot'}
        {offset ? ` · ${offset}` : ''}
      </span>
    </li>
  );
}

/** What `GET /v1/calls/:id/recording` hands back. Fetching it is audited. */
interface RecordingAccess {
  status: string | null;
  url: string;
  /** Short-lived signed URL, when Brayz can reach the bucket. */
  playbackUrl: string | null;
  expiresInSeconds: number | null;
}

/**
 * What became of the call's recording. SiphonAI records on the node and uploads
 * afterwards, so "recorded" and "playable" are different states and a staff
 * member chasing a call needs to be told which one they're looking at.
 */
function RecordingRow({ call }: { call: Call }) {
  const { api } = useAuth();
  const [recording, setRecording] = useState<RecordingAccess | null>(null);
  const reveal = useMutation({
    mutationFn: () => api<RecordingAccess>(`/v1/calls/${call.id}/recording`),
    onSuccess: setRecording,
  });

  if (!call.recordingStatus) return null;

  const copy: Record<string, { label: string; tone: string; detail?: string }> = {
    started: { label: 'Recording', tone: 'text-slate-500' },
    stopped: {
      label: 'Recording finished',
      tone: 'text-slate-500',
      detail: 'Uploading — the location appears here once the audio lands in storage.',
    },
    failed: {
      label: 'Recording failed',
      tone: 'text-red-600',
      detail: 'The call itself was unaffected; there is no audio for it.',
    },
    uploaded: { label: 'Recording available', tone: 'text-slate-700' },
    deleted: {
      label: 'Recording deleted',
      tone: 'text-slate-500',
      detail: 'Removed from storage under this location\u2019s retention setting. The transcript and summary are kept.',
    },
  };
  const state = copy[call.recordingStatus] ?? { label: call.recordingStatus, tone: 'text-slate-500' };

  return (
    <div className="mt-4 border-t border-slate-100 pt-4 text-sm">
      <p className={state.tone}>{state.label}</p>
      {state.detail && <p className="mt-0.5 text-xs text-slate-500">{state.detail}</p>}

      {call.recordingStatus === 'uploaded' &&
        (recording ? (
          <div className="mt-2">
            {recording.playbackUrl ? (
              <audio controls preload="none" src={recording.playbackUrl} className="w-full max-w-md">
                Your browser cannot play audio.
              </audio>
            ) : (
              <>
                <p className="text-xs text-slate-500">
                  Brayz has no credentials for the recording bucket, so it can’t play this here.
                </p>
                <p className="mt-1 break-all font-mono text-xs text-slate-500">{recording.url}</p>
              </>
            )}
          </div>
        ) : (
          <button
            onClick={() => reveal.mutate()}
            disabled={reveal.isPending}
            className="mt-1 text-xs text-brayz hover:underline disabled:opacity-50"
          >
            {reveal.isPending ? 'Loading…' : 'Play recording'}
          </button>
        ))}
      {/* Deliberate: reaching for a recording is audited, so it is an action the
          user takes rather than something every list render performs. */}
      {reveal.isError && (
        <p className="mt-1 text-xs text-red-600">
          {(reveal.error as Error).message.replace(/^API \d+ [^:]+: /, '')}
        </p>
      )}
    </div>
  );
}
