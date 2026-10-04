// Hook duy nhất của repo (PreToolUse). Hai việc, cố ý giữ nhỏ:
//  1. Bash `git commit` → chạy `tsc --noEmit` trong webapp/, lỗi thì chặn (exit 2).
//  2. Edit/Write file .tsx → nhắc load skill circa-ui (additionalContext, không chặn).
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const input = JSON.parse(readFileSync(0, 'utf8'))
const tool = input.tool_name ?? ''
const ti = input.tool_input ?? {}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

if (tool === 'Bash' && /\bgit\s+commit\b/.test(ti.command ?? '')) {
  try {
    execSync('npx tsc --noEmit', { cwd: path.join(repo, 'webapp'), stdio: 'pipe', timeout: 240_000 })
  } catch (e) {
    const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
    process.stderr.write('tsc --noEmit lỗi — sửa trước khi commit:\n' + out.slice(0, 4000))
    process.exit(2)
  }
  process.exit(0)
}

if ((tool === 'Edit' || tool === 'Write') && /\.tsx$/i.test(ti.file_path ?? '')) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: 'File .tsx: nếu chưa load skill webapp/.claude/skills/circa-ui trong phiên này thì load trước khi sửa UI.',
    },
  }))
}
process.exit(0)
