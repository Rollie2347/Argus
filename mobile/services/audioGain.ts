/**
 * The one place Argus's playback gain is defined.
 *
 * It lives in its own module because the audio A/B harness previously played
 * the reference clip WITHOUT this transform while real playback applied it,
 * so the harness reported "clear" under every audio configuration while the
 * app sounded muffled. The harness was holding the wrong variable constant.
 * Anything that plays audio imports from here.
 *
 * History worth knowing before changing DEFAULT_GAIN:
 *
 * The gain was escalated 1.6 -> 2.4 -> 3.2 -> 4.5 -> 5.0 across four rounds,
 * each time because playback was "too quiet". Every one of those rounds
 * happened while iOS was routing output to the earpiece receiver instead of
 * the speaker — the actual cause of the quietness, fixed separately by the
 * overrideOutputAudioPort change in patches/expo-av+16.0.8.patch. The gain was
 * never unwound afterwards, so the app has been running ~9 dB of compression
 * to solve a problem that no longer exists.
 *
 * Measured on real captured Gemini audio (backend/scripts/audio-probe.mjs):
 *
 *              crest factor   RMS      >90% full scale
 *   raw            6.49        —            0.00%
 *   gain 5.0       2.35      +10.2 dB       4.76%
 *
 * Speech normally sits at a crest factor of 4-8; 2.35 is close to a square
 * wave. Peak only rose 1.4 dB against RMS's 10.2 dB, i.e. it was almost
 * entirely compression rather than level. Quiet samples were multiplied by
 * 4.9x and loud ones by 1.25x, flattening the transients and consonants that
 * carry intelligibility — which is what "muffled, like talking through a
 * cloth" actually was.
 *
 * The raw audio already peaks at 85% of full scale, so it needs almost no
 * gain at all. Hence a near-unity default and a limiter that only touches
 * the top of the range.
 */

export const DEFAULT_GAIN = 1.15;

// Below this fraction of full scale the transform is exactly linear, so the
// waveform keeps its shape and its dynamics. Only the top of the range is
// rounded off, and only to stop a peak wrapping around. Contrast the previous
// tanh(x * gain), which compressed the ENTIRE range — a sample at 5% of full
// scale was still being multiplied by nearly 5.
const KNEE = 0.8;

/**
 * Applies gain to one normalised sample (-1..1) and returns a normalised
 * sample, linear below the knee and softly limited above it.
 */
export function applyGain(x: number, gain: number): number {
  const scaled = x * gain;
  const mag = Math.abs(scaled);
  if (mag <= KNEE) return scaled;
  const over = (mag - KNEE) / (1 - KNEE);
  const limited = KNEE + (1 - KNEE) * Math.tanh(over);
  return scaled < 0 ? -limited : limited;
}

/**
 * Gemini streams raw PCM16 mono at 24kHz in many small chunks. expo-av can
 * only load audio files/URIs and cannot append to an already-playing sound, so
 * each playable unit needs its own WAV header. Chunks are merged before
 * wrapping rather than wrapped individually, to avoid a load gap at every
 * chunk boundary.
 */
export function pcmChunksToWavBase64(pcmB64Chunks: string[], sampleRate: number, gain: number = DEFAULT_GAIN): string {
  const pcmBins = pcmB64Chunks.map(atob);
  const pcmLen = pcmBins.reduce((sum, bin) => sum + bin.length, 0);
  const headerLen = 44;
  const buf = new ArrayBuffer(headerLen + pcmLen);
  const view = new DataView(buf);
  const writeStr = (offset: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcmLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, pcmLen, true);

  const bytes = new Uint8Array(buf);
  let offset = headerLen;
  for (const bin of pcmBins) {
    for (let i = 0; i < bin.length; i++) bytes[offset + i] = bin.charCodeAt(i);
    offset += bin.length;
  }

  if (gain !== 1) {
    for (let i = headerLen; i < buf.byteLength - 1; i += 2) {
      const sample = view.getInt16(i, true);
      view.setInt16(i, Math.round(applyGain(sample / 32768, gain) * 32767), true);
    }
  }

  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
