// Untrusted text (GitHub PR data, model output) must never reach the terminal with
// control characters in it: ESC starts CSI/OSC sequences (OSC 52 writes the clipboard,
// OSC 0 retitles the window, CSI 2J clears the screen, OSC 8 spoofs links) and the C1
// range (\u0080-\u009f) holds single-byte equivalents (\u009b CSI, \u009d OSC, \u009c ST)
// that some terminals honour too.
//
// Tab and newline are kept. Carriage return is dropped: on its own it moves the cursor to
// column 0 so later text overwrites earlier text, which can disguise what a line says.
// Callers that want CRLF line breaks should normalise \r\n to \n first.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function sanitizeTerminal(s: string): string {
  return s.replace(CONTROL, '');
}
