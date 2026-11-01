import 'server-only'
import { isCmsProgramEnabled } from '@/lib/cms/flags'
import type { CmsImportDeps } from '@/lib/cms/import/handler'
import { getCmsAdminAccess } from './access'
import { supabaseCmsImportRepo } from './importRepo'

// Nối dependency thật cho route import CMS (cờ, session super admin + marker QA, repo service role).
export function cmsImportDeps(): CmsImportDeps {
  return {
    enabled: isCmsProgramEnabled(),
    getAccess: getCmsAdminAccess,
    repo: supabaseCmsImportRepo,
    now: () => new Date(),
  }
}
