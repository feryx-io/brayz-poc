'use client';

import { useEffect, useState } from 'react';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toHHMM = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const fromHHMM = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export interface HoursInterval {
  dayOfWeek: number;
  opensAt: number;
  closesAt: number;
}

interface DayRow {
  enabled: boolean;
  opensAt: number;
  closesAt: number;
}

const DEFAULT_ROW: DayRow = { enabled: true, opensAt: 11 * 60, closesAt: 21 * 60 };

/**
 * Weekly hours editor. Self-contained; reports the enabled days as intervals via
 * `onChange` (minutes from midnight, matching the API's SetHoursInput).
 */
export function HoursEditor({
  initial,
  onChange,
}: {
  initial?: HoursInterval[];
  onChange: (intervals: HoursInterval[]) => void;
}) {
  const [rows, setRows] = useState<DayRow[]>(() => {
    const base: DayRow[] = DAYS.map(() => ({ ...DEFAULT_ROW }));
    initial?.forEach((iv) => {
      base[iv.dayOfWeek] = { enabled: true, opensAt: iv.opensAt, closesAt: iv.closesAt };
    });
    return base;
  });

  useEffect(() => {
    onChange(
      rows
        .map((r, dayOfWeek) => ({ ...r, dayOfWeek }))
        .filter((r) => r.enabled)
        .map(({ dayOfWeek, opensAt, closesAt }) => ({ dayOfWeek, opensAt, closesAt })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  function update(day: number, patch: Partial<DayRow>) {
    setRows((cur) => cur.map((r, i) => (i === day ? { ...r, ...patch } : r)));
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, day) => (
        <div key={day} className="flex items-center gap-3">
          <label className="flex w-20 items-center gap-2 text-sm">
            <input type="checkbox" checked={row.enabled} onChange={(e) => update(day, { enabled: e.target.checked })} />
            {DAYS[day]}
          </label>
          {row.enabled ? (
            <>
              <input
                type="time"
                value={toHHMM(row.opensAt)}
                onChange={(e) => update(day, { opensAt: fromHHMM(e.target.value) })}
                className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
              />
              <span className="text-slate-400">–</span>
              <input
                type="time"
                value={toHHMM(row.closesAt)}
                onChange={(e) => update(day, { closesAt: fromHHMM(e.target.value) })}
                className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
              />
            </>
          ) : (
            <span className="text-sm text-slate-400">Closed</span>
          )}
        </div>
      ))}
    </div>
  );
}
