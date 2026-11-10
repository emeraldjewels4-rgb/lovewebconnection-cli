import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";

export interface RotatingLogOptions {
  path: string;
  /** Rotate before a write would push the file past this many bytes; 0 disables it. */
  maxBytes: number;
}

/**
 * Append-only NDJSON writer with one size-triggered backup. When the next line
 * would exceed `maxBytes`, the active file is renamed to `<path>.1` (replacing
 * the previous backup) and a fresh file starts, so the log never grows past the
 * limit plus a single line. A JSON line is never split.
 */
export class RotatingLog {
  readonly path: string;
  readonly maxBytes: number;
  private bytes: number;

  constructor(options: RotatingLogOptions) {
    this.path = options.path;
    this.maxBytes = options.maxBytes;
    this.bytes = existsSync(this.path) ? statSync(this.path).size : 0;
  }

  append(text: string): void {
    const line = text.endsWith("\n") ? text : `${text}\n`;
    const size = Buffer.byteLength(line, "utf8");

    // Rotating an empty file would just rename a zero-byte file, and a single
    // line larger than the limit still has to be written somewhere.
    if (this.maxBytes > 0 && this.bytes > 0 && this.bytes + size > this.maxBytes) {
      this.rotate();
    }

    appendFileSync(this.path, line);
    this.bytes += size;
  }

  private rotate(): void {
    const backup = `${this.path}.1`;
    rmSync(backup, { force: true });
    renameSync(this.path, backup);
    this.bytes = 0;
  }
}
