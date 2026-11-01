'use client'

import { Download } from 'lucide-react'
import { useFixtureActionBlocked } from '@/components/kpi/KpiFixtureBoundary'

// CMS P1-c — link tải file dòng lỗi của một import run (GET /api/cms/import/errors). Trong fixture /ui-catalog bị chặn
// qua useFixtureActionBlocked (0 request export).
export function CmsErrorFileLink({ runId, label = 'Tải' }: { runId: string; label?: string }) {
  const fixtureBlocked = useFixtureActionBlocked()
  return (
    <a
      href={`/api/cms/import/errors?run_id=${encodeURIComponent(runId)}`}
      onClick={(e) => { if (fixtureBlocked()) e.preventDefault() }}
      data-cms-error-file
      className="inline-flex min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 items-center justify-center gap-1 text-[13px] underline-offset-2 hover:underline"
    >
      <Download className="h-4 w-4" /> {label}
    </a>
  )
}
