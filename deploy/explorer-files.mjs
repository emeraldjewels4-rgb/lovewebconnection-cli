/**
 * The explorer's deployable files, in the order the README lists them.
 *
 * Both the FTP uploader and the zip builder read this one list, so a file added
 * to the folder is added to both, and neither can ship a set the other does not.
 * `lookup-state.d.ts` and `README.md` are for the checkout, not the host.
 *
 * The formatter below lives here for the same reason: the uploader's plan and
 * the zip builder's report print the same sizes, and one copy is one style.
 */
export const EXPLORER_FILES = [
  "index.html",
  "style.css",
  "app.js",
  "lookup-state.js",
  "presets.json",
  "rpc.php",
  ".htaccess",
];

/** Bytes for a human: B below 1 KiB, then KB and MB with one decimal. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
