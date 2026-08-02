#!/bin/sh
# JFDI PostToolUse hook: format the file the agent just edited, so sessions
# never burn turns on lint-fix loops. Receives the Claude Code hook payload on
# stdin. Always exits 0 — a formatter problem must never fail the agent's edit.
file=$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const f=JSON.parse(d).tool_input?.file_path;if(f)console.log(f)}catch{}})')
[ -n "$file" ] || exit 0
case "$file" in
  *.ts|*.tsx|*.json|*.jsonc)
    cd "$CLAUDE_PROJECT_DIR" && pnpm exec biome check --write "$file" >/dev/null 2>&1
    ;;
esac
exit 0
