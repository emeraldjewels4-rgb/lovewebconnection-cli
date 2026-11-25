/**
 * The explorer's deployable files, in the order the README lists them.
 *
 * Both the FTP uploader and the zip builder read this one list, so a file added
 * to the folder is added to both, and neither can ship a set the other does not.
 * `lookup-state.d.ts` and `README.md` are for the checkout, not the host.
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
