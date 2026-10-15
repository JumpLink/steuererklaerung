/**
 * Minimal ZIP reader for the ERiC JAR.
 *
 * Replaces `unzip` + `cp` + `rm`, which exist on a Linux workstation but not on Windows. Reads the
 * central directory first and then only the entries asked for — the JAR is 500-850 MB, of which the
 * app needs a tenth, so it is never read whole into memory. Supports stored and deflated entries,
 * which is all a JAR contains; ZIP64 is refused with a clear message.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflated. */
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n === 0) throw new Error('Unexpected end of ZIP file');
    done += n;
  }
  return buf;
}

export class ZipArchive {
  private readonly fd: number;
  readonly entries: ZipEntry[];

  constructor(path: string) {
    this.fd = openSync(path, 'r');
    try {
      this.entries = this.readCentralDirectory();
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }

  private readCentralDirectory(): ZipEntry[] {
    const fileSize = fstatSync(this.fd).size;
    // The end-of-central-directory record is 22 bytes plus a comment of up to 65535 bytes.
    const tailLength = Math.min(fileSize, 22 + 0xffff);
    const tail = readAt(this.fd, tailLength, fileSize - tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record)');

    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || dirSize === ZIP64_MARKER || dirOffset === ZIP64_MARKER) {
      throw new Error('ZIP64 archives are not supported');
    }

    const dir = readAt(this.fd, dirSize, dirOffset);
    const entries: ZipEntry[] = [];
    let pos = 0;
    for (let i = 0; i < count; i++) {
      if (dir.readUInt32LE(pos) !== CENTRAL_SIGNATURE) throw new Error('Corrupt ZIP central directory');
      const method = dir.readUInt16LE(pos + 10);
      const compressedSize = dir.readUInt32LE(pos + 20);
      const size = dir.readUInt32LE(pos + 24);
      const nameLength = dir.readUInt16LE(pos + 28);
      const extraLength = dir.readUInt16LE(pos + 30);
      const commentLength = dir.readUInt16LE(pos + 32);
      const localOffset = dir.readUInt32LE(pos + 42);
      const name = dir.toString('utf8', pos + 46, pos + 46 + nameLength);
      if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
        throw new Error(`ZIP64 entry is not supported: ${name}`);
      }
      entries.push({ name, method, compressedSize, size, localOffset });
      pos += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  /** The decompressed bytes of one entry. */
  read(entry: ZipEntry): Buffer {
    const header = readAt(this.fd, 30, entry.localOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`Corrupt ZIP entry: ${entry.name}`);
    // The local header repeats name and extra field with lengths that can differ from the central
    // directory's, so the data offset comes from here.
    const dataOffset = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = readAt(this.fd, entry.compressedSize, dataOffset);
    if (entry.method === 0) return raw;
    if (entry.method === 8) {
      const data = inflateRawSync(raw);
      if (data.length !== entry.size) throw new Error(`Size mismatch in ZIP entry: ${entry.name}`);
      return data;
    }
    throw new Error(`Unsupported compression method ${entry.method} in ${entry.name}`);
  }

  close(): void {
    closeSync(this.fd);
  }
}
