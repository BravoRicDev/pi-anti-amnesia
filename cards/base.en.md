# Memory card — template to personalise

This template contains no facts about the current session. Replace the placeholders
with verified information only, then store it with `memory_card({ text: "...", role: "..." })`.
Never copy rules from other roles or plans from old projects.

## Always valid
- Effective role: <verified role>; role prompt: <verified absolute path>.
- Project/cwd: <verified absolute path>.
- After compaction: re-read base.md and your role prompt, then compare against the real state.
- Before executing remembered instructions, check they have not been superseded.

## Active work
- Requested objective: <current task, verified against the user's request>.
- Verified state: <what was actually done, with evidence or path>.
- Next concrete step: <action and relevant absolute file paths>.
- Blockers: <none, or list them>.

## Topic: example, sample
- Archived notes, loaded only when explicitly requested. Move live work to Active work.
