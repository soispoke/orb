/** Hide only the exact server-generated attachment transport trailer. The model
 * retains the original text for replay; the UI reports context without exposing
 * staging paths or claiming that a folder selection is a known number of files. */
export function messagePresentation(content: string): { text: string; attached: boolean } {
  const trailer = /\n\n<!-- paloma:attachment:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}) -->\nAttached context: read `\.paloma\/messages\/\1\/\.paloma\/attach\.md` \(paths in that manifest are relative to `\.paloma\/messages\/\1`\)\.$/i;
  const match = trailer.exec(content);
  return match ? { text: content.slice(0, match.index), attached: true } : { text: content, attached: false };
}

/** Sent by the Resume button; shown collapsed so it doesn't read like a user turn. */
export const resumePrompt='Your previous turn was interrupted before it finished. Check what is already done, then continue from there. Do not redo finished work.';
// Core uses a more explicit marker for automatic recovery. Keep both forms
// collapsed so recovery instructions never look like a new user request.
export const interruptedResumePrompt='[Resume interrupted work] Continue the existing task from its current state. Check the workspace and any background jobs before taking action. Do not redo completed work or duplicate running jobs; preserve the original objective, deadline, and any later user instructions.';
export const isResumePrompt = (content: string) => {
  const text = content.trim();
  return text === resumePrompt || text === interruptedResumePrompt;
};

/** Exact coordinator markers; a user's normal request to resume stays a user turn. */
export function isAutomaticRecovery(content: string): boolean {
  return /^\[Automatic (?:recovery|resume after a usage limit)\]/i.test(content.trimStart());
}
