'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { useLocations, useMessages, type CallMessage } from '@/lib/queries';

/**
 * Messages callers left with the bot: who, how to reach them, what they
 * said. The restaurant was texted when each landed; this is where they are
 * worked off. "Done" is the whole workflow — a message is a callback owed,
 * and once someone has made it there is nothing else to record.
 */
export default function MessagesPage() {
  const { api, activeLocationId, activeTenantId } = useAuth();
  const qc = useQueryClient();
  const locations = useLocations();
  const location = locations.data?.find((l) => l.id === activeLocationId);
  const [view, setView] = useState<'new' | 'done'>('new');
  const messages = useMessages(activeLocationId ?? undefined, view);

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'new' | 'done' }) =>
      api(`/v1/messages/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['messages', activeTenantId, activeLocationId] }),
  });

  if (!activeLocationId) return <p className="text-slate-500">Create a location first (Settings).</p>;
  const list = messages.data?.messages ?? [];
  const newCount = messages.data?.newCount ?? 0;

  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Messages</h1>
          <p className="text-sm text-slate-500">
            What callers asked {location?.name ?? 'the restaurant'} to pass on. Each one is a call back owed.
          </p>
        </div>
        <div className="flex rounded-lg border border-slate-200 text-sm">
          {(['new', 'done'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={
                'px-3 py-1.5 ' +
                (view === v ? 'bg-brayz font-medium text-white' : 'text-slate-600 hover:bg-slate-50')
              }
            >
              {v === 'new' ? `New${newCount ? ` (${newCount})` : ''}` : 'Done'}
            </button>
          ))}
        </div>
      </div>

      {messages.isLoading && <p className="text-slate-500">Loading…</p>}
      {messages.data && list.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
          {view === 'new' ? 'No messages waiting. The bot takes one when a caller asks for a person or a call back.' : 'Nothing marked done yet.'}
        </p>
      )}
      <ul className="space-y-3">
        {list.map((m) => (
          <MessageCard
            key={m.id}
            message={m}
            busy={setStatus.isPending}
            onToggle={() => setStatus.mutate({ id: m.id, status: m.status === 'new' ? 'done' : 'new' })}
          />
        ))}
      </ul>
      {setStatus.isError && (
        <p className="mt-3 text-sm text-red-600">{(setStatus.error as Error).message.replace(/^API \d+ [^:]+: /, '')}</p>
      )}
    </div>
  );
}

function MessageCard({ message: m, busy, onToggle }: { message: CallMessage; busy: boolean; onToggle: () => void }) {
  const when = new Date(m.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <li className={'rounded-xl border border-slate-200 bg-white p-4 ' + (m.status === 'done' ? 'opacity-70' : '')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {m.callerName ?? 'Caller'}
            {m.callbackNumber && (
              <a href={`tel:${m.callbackNumber}`} className="ml-2 text-sm font-normal text-brayz hover:underline">
                {m.callbackNumber}
              </a>
            )}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{m.body}</p>
          <p className="mt-2 text-xs text-slate-500">
            {when}
            {m.notifiedAt ? ' · texted to the restaurant' : ' · not texted'}
            {m.callId && (
              <>
                {' · '}
                <Link href={`/app/calls?call=${m.callId}`} className="hover:underline">
                  see the call
                </Link>
              </>
            )}
          </p>
        </div>
        <button
          onClick={onToggle}
          disabled={busy}
          className={
            'shrink-0 rounded-lg px-3 py-1 text-xs font-medium disabled:opacity-50 ' +
            (m.status === 'new' ? 'bg-brayz text-white hover:bg-brayz-dark' : 'border border-slate-200 text-slate-600 hover:border-slate-300')
          }
        >
          {m.status === 'new' ? 'Mark done' : 'Reopen'}
        </button>
      </div>
    </li>
  );
}
