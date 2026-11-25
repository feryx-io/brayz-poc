'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useLocations, type AssistantProposal, type AssistantReply } from '@/lib/queries';
import { applyMenuFix, describeMenuFix } from '@/lib/menuFix';
import { takeAssistantQuestion } from '@/lib/assistantHandoff';

/**
 * The per-account assistant: a conversation over this location's menu and
 * calls, for an owner working out why the bot handled a call the way it did.
 *
 * It never changes anything itself. An edit it suggests arrives as a card
 * with an Apply button, and applying is the same menu route the editor uses,
 * so it is role-gated and audited like a hand edit. The thread lives in this
 * browser (sessionStorage per location); the API keeps no session.
 */

interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
  proposals?: AssistantProposal[];
}

const STARTERS = [
  'What on my menu will trip the bot up?',
  'Why did the last call go the way it did?',
  'What have callers asked for that we don’t sell?',
  'Which items have no options set up?',
  'What does a typical menu like mine have that I don’t?',
];

export default function AssistantPage() {
  const { api, activeLocationId, canManage, activeTenantId } = useAuth();
  const qc = useQueryClient();
  const locations = useLocations();
  const location = locations.data?.find((l) => l.id === activeLocationId);
  const storageKey = `brayz.assistant.${activeLocationId ?? 'none'}`;

  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState<Record<string, 'done' | 'dismissed'>>({});
  const bottom = useRef<HTMLDivElement>(null);

  // A question parked by another screen (the Menu health card's "Ask the
  // assistant") is sent as soon as the saved thread is loaded, so the owner
  // arrives mid-conversation rather than at an empty box.
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let saved: ThreadMessage[] = [];
    try {
      const raw = sessionStorage.getItem(storageKey);
      saved = raw ? (JSON.parse(raw) as ThreadMessage[]) : [];
      const savedApplied = sessionStorage.getItem(`${storageKey}.applied`);
      setApplied(savedApplied ? (JSON.parse(savedApplied) as Record<string, 'done' | 'dismissed'>) : {});
    } catch {
      saved = [];
    }
    setThread(saved);
    if (activeLocationId) setPending(takeAssistantQuestion(activeLocationId));
  }, [storageKey, activeLocationId]);
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(thread));
      sessionStorage.setItem(`${storageKey}.applied`, JSON.stringify(applied));
    } catch {
      /* fine without */
    }
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread, applied, storageKey]);

  const send = useMutation({
    // Takes the whole thread-to-be rather than the new line alone, so a
    // parked question can be sent against the thread just loaded from
    // storage instead of the stale one a closure would hold.
    mutationFn: async (next: ThreadMessage[]) => {
      setThread(next);
      return api<AssistantReply>(`/v1/locations/${activeLocationId}/assistant/chat`, {
        method: 'POST',
        body: { messages: next.map(({ role, content }) => ({ role, content })) },
      });
    },
    onSuccess: (reply) => {
      setThread((t) => [...t, { role: 'assistant', content: reply.reply, proposals: reply.proposals }]);
    },
  });

  const apply = useMutation({
    mutationFn: (p: AssistantProposal) => applyMenuFix(api, p.fix, activeLocationId!),
    onSuccess: (_r, p) => {
      setApplied((a) => ({ ...a, [p.id]: 'done' }));
      qc.invalidateQueries({ queryKey: ['menu', activeTenantId, activeLocationId] });
      qc.invalidateQueries({ queryKey: ['menu-health', activeTenantId, activeLocationId] });
    },
  });

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || send.isPending || !activeLocationId) return;
    setDraft('');
    send.mutate([...thread, { role: 'user', content: t }]);
  };

  useEffect(() => {
    if (!pending || !canManage || send.isPending) return;
    setPending(null);
    send.mutate([...thread, { role: 'user', content: pending }]);
    // `send` and `thread` are read once, when the parked question arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, canManage]);

  if (!activeLocationId) return <p className="text-slate-500">Create a location first (Settings).</p>;

  return (
    <div className="flex h-[calc(100vh-8rem)] max-w-3xl flex-col">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Assistant</h1>
          <p className="text-sm text-slate-500">
            Reads {location?.name ?? 'this location'}&rsquo;s menu and the last 30 days of calls. Suggests edits
            and new items; never makes them without you.
          </p>
        </div>
        {thread.length > 0 && (
          <button
            onClick={() => {
              setThread([]);
              setApplied({});
            }}
            className="text-xs text-slate-500 hover:underline"
          >
            New conversation
          </button>
        )}
      </div>

      {!canManage && (
        <p className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-600">
          The assistant is for managers and owners — it reads call transcripts and proposes menu changes.
        </p>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4">
        {thread.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-slate-500">Try one of these, or ask anything about the menu or a call.</p>
            <div className="flex flex-wrap gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => submit(s)}
                  disabled={!canManage}
                  className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-700 hover:border-brayz hover:text-brayz disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {thread.map((m, i) => (
          <div key={i} className={'flex ' + (m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className="max-w-[85%] space-y-2">
              <div
                className={
                  'whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ' +
                  (m.role === 'user' ? 'bg-brayz text-white' : 'bg-slate-100 text-slate-800')
                }
              >
                {m.content}
              </div>
              {m.proposals?.map((p) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  state={applied[p.id]}
                  canManage={canManage}
                  busy={apply.isPending}
                  onApply={() => apply.mutate(p)}
                  onDismiss={() => setApplied((a) => ({ ...a, [p.id]: 'dismissed' }))}
                />
              ))}
            </div>
          </div>
        ))}
        {send.isPending && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-slate-100 px-4 py-2 text-sm text-slate-500">Reading…</div>
          </div>
        )}
        {send.isError && (
          <p className="text-sm text-red-600">{(send.error as Error).message.replace(/^API \d+ [^:]+: /, '')}</p>
        )}
        {apply.isError && (
          <p className="text-sm text-red-600">{(apply.error as Error).message.replace(/^API \d+ [^:]+: /, '')}</p>
        )}
        <div ref={bottom} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
        className="mt-3 flex gap-2"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={canManage ? 'Ask about the menu, a call, or what to change…' : 'Managers and owners only'}
          disabled={!canManage || send.isPending}
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={!canManage || send.isPending || !draft.trim()}
          className="rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function ProposalCard({
  proposal,
  state,
  canManage,
  busy,
  onApply,
  onDismiss,
}: {
  proposal: AssistantProposal;
  state?: 'done' | 'dismissed';
  canManage: boolean;
  busy: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={'rounded-xl border border-slate-200 bg-white p-3 text-sm ' + (state ? 'opacity-60' : '')}>
      <p className="font-medium">{proposal.summary}</p>
      <p className="mt-0.5 text-xs text-slate-500">{describeMenuFix(proposal.fix)}</p>
      <p className="mt-1 text-slate-600">{proposal.reason}</p>
      <div className="mt-2 flex items-center gap-2">
        {state === 'done' && <span className="text-xs font-medium text-green-700">Applied</span>}
        {state === 'dismissed' && <span className="text-xs text-slate-500">Dismissed</span>}
        {!state && canManage && (
          <>
            <button
              onClick={onApply}
              disabled={busy}
              className="rounded-lg bg-brayz px-3 py-1 text-xs font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
            >
              {busy ? 'Applying…' : 'Apply'}
            </button>
            <button onClick={onDismiss} className="text-xs text-slate-500 hover:underline">
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  );
}
