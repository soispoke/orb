/** Recognize only standalone progress questions. Mixed requests, code,
 * attachments and explicit modes stay on the caller's normal send path. */
export function isStatusQuestion(text: string): boolean {
  const question = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[?.!]+$/, "").trim();
  if (question.length > 100 || /[\n\r]/.test(question)) return false;
  return /^(?:(?:quick |current )?(?:status|progress)(?: update)?|eta|eta (?:and|&) status|status (?:and|&) eta|(?:a )?tldr(?: of (?:what (?:you(?:'re| are)|it(?:'s| is)) doing|the progress))?|what (?:are you|is it) doing|what's (?:the status|left)|what is (?:the status|left)|how(?:'s| is) it going|how is (?:the work|the audit|the build) going)(?: please)?$/.test(question);
}
