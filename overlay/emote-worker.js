// Decodes animated emotes for the overlay, away from the thread that draws
// the battle, so a chat full of new animated emotes never makes it stutter.
// A few emotes are decoded at a time; each frame is shrunk to the size
// emotes are drawn at and handed to the overlay as a ready image.
//
// Message in:  { key, url, size }  (key: the overlay's name for it, sent back; size: the longest side of a frame, in pixels)
// Message out: { key, frames: [{ image, until }], total }, or frames: null when it cannot be decoded.

/** The longest an animation may be: longer ones keep their first frames. */
const MAX_FRAMES = 150;

/** How many emotes are decoded at the same time. */
const AT_ONCE = 3;

const waiting = [];
let running = 0;

self.onmessage = ({ data }) => {
  waiting.push(data);
  next();
};

function next() {
  while (running < AT_ONCE && waiting.length > 0) {
    const { key, url, size } = waiting.shift();
    running++;
    decode(key, url, size).finally(() => {
      running--;
      next();
    });
  }
}

async function decode(key, url, size) {
  const frames = [];
  try {
    if (typeof ImageDecoder === 'undefined') throw new Error('no ImageDecoder');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const type = response.headers.get('content-type') || 'image/gif';
    if (!(await ImageDecoder.isTypeSupported(type))) throw new Error(`unsupported ${type}`);
    const decoder = new ImageDecoder({ data: await response.arrayBuffer(), type });
    await decoder.tracks.ready;
    const count = Math.min(decoder.tracks.selectedTrack.frameCount, MAX_FRAMES);
    let total = 0;
    for (let index = 0; index < count; index++) {
      const { image } = await decoder.decode({ frameIndex: index });
      const scale = Math.min(1, size / Math.max(image.displayWidth, image.displayHeight));
      // Durations are in microseconds; very short frames are stretched, as browsers do.
      total += Math.max(20, (image.duration || 100_000) / 1000);
      const bitmap = await createImageBitmap(image, {
        resizeWidth: Math.max(1, Math.round(image.displayWidth * scale)),
        resizeHeight: Math.max(1, Math.round(image.displayHeight * scale)),
        resizeQuality: 'medium',
      });
      image.close();
      frames.push({ image: bitmap, until: total });
    }
    decoder.close();
    if (frames.length === 0) throw new Error('no frames');
    self.postMessage({ key, frames, total }, frames.map((frame) => frame.image));
  } catch {
    for (const frame of frames) frame.image.close();
    self.postMessage({ key, frames: null });
  }
}
