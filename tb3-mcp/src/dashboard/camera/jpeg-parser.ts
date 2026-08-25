const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

// Splits a raw MJPEG byte stream into complete per-frame JPEG buffers. Works on
// both ffmpeg-style bare concatenated JPEGs and multipart/x-mixed-replace
// bodies (the multipart headers between frames contain no SOI/EOI markers,
// so they're skipped).
export class JpegFrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      const soi = this.buf.indexOf(SOI);
      if (soi === -1) {
        // No SOI in the buffered tail -- discard it, EXCEPT a trailing lone
        // 0xFF byte, which may be the first half of the next frame's FFD8
        // marker split across two read chunks.
        this.buf = (this.buf.length > 0 && this.buf[this.buf.length - 1] === 0xff)
          ? this.buf.subarray(this.buf.length - 1)
          : Buffer.alloc(0);
        break;
      }
      if (soi > 0) this.buf = this.buf.subarray(soi);
      const eoi = this.buf.indexOf(EOI, 2);
      if (eoi === -1) break; // incomplete frame -- wait for more data
      const end = eoi + EOI.length;
      frames.push(Buffer.from(this.buf.subarray(0, end)));
      this.buf = this.buf.subarray(end);
    }
    return frames;
  }
}
