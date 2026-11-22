import React from 'react';

export const PostCardSkeleton: React.FC = () => {
  return (
    <div className="h-full flex flex-col justify-between space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="space-y-3">
        {/* Header row: Author & Age */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-4 w-20 rounded-md bg-slate-200 dark:bg-slate-800 animate-pulse" />
            <div className="h-4 w-14 rounded-md bg-slate-200 dark:bg-slate-800 animate-pulse" />
          </div>
          <div className="h-3.5 w-12 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
        </div>

        {/* Media / Excerpt placeholder */}
        <div className="h-36 w-full rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse" />

        {/* Title */}
        <div className="space-y-1.5 pt-1">
          <div className="h-4 w-full rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
          <div className="h-4 w-4/5 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
        </div>
      </div>

      {/* Footer / Meta section */}
      <div className="space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
        <div className="flex items-center justify-between">
          <div className="h-4 w-16 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
          <div className="h-4 w-20 rounded-full bg-slate-200 dark:bg-slate-800 animate-pulse" />
        </div>

        <div className="h-3.5 w-28 rounded bg-slate-200 dark:bg-slate-800 animate-pulse opacity-75" />

        <div className="flex items-center gap-2 pt-1">
          <div className="h-9 flex-1 rounded-lg bg-slate-200 dark:bg-slate-800 animate-pulse" />
          <div className="h-9 w-20 rounded-lg bg-slate-200 dark:bg-slate-800 animate-pulse" />
        </div>
      </div>
    </div>
  );
};
