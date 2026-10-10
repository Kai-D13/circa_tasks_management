import 'server-only'
import { careImportMaxBytes } from '@/lib/care/config'
import { isCareEnabled } from '@/lib/care/flags'
import type { CareImportDeps } from '@/lib/care/import/handler'
import { getCareImportAccess } from './importAccess'
import { supabaseCareImportRepo } from './importRepo'

// Nối dependency thật cho route import CRM (cờ, trần byte, session, repo service role).
export function careImportDeps(): CareImportDeps {
  return {
    enabled: isCareEnabled(),
    maxBytes: careImportMaxBytes(process.env),
    getAccess: getCareImportAccess,
    repo: supabaseCareImportRepo,
    now: () => new Date(),
  }
}
