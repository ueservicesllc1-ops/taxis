const fs = require('fs');
const path = require('path');

const sampleRate = 44100;
const durationSeconds = 1.2;
const numSamples = Math.floor(sampleRate * durationSeconds);
const numChannels = 1;
const bytesPerSample = 2; // 16-bit PCM
const blockAlign = numChannels * bytesPerSample;
const byteRate = sampleRate * blockAlign;
const dataSize = numSamples * blockAlign;

const buffer = Buffer.alloc(44 + dataSize);

// Write RIFF header
buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write('WAVE', 8);

// Write 'fmt ' chunk
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16); // subchunk1size (16 for PCM)
buffer.writeUInt16LE(1, 20);  // audio format (1 = PCM)
buffer.writeUInt16LE(numChannels, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(byteRate, 28);
buffer.writeUInt16LE(blockAlign, 32);
buffer.writeUInt16LE(16, 34); // bits per sample

// Write 'data' chunk
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);

// Generate modern transport dispatch alert sound:
// Dual tone burst:
// Burst 1 (0.0s - 0.25s): 880 Hz + 1320 Hz chime
// Pause (0.25s - 0.35s)
// Burst 2 (0.35s - 0.70s): 1046 Hz + 1568 Hz chime (higher musical major chord)
// Fade out to 1.2s to loop cleanly
for (let i = 0; i < numSamples; i++) {
  const t = i / sampleRate;
  let sample = 0;

  if (t >= 0.0 && t < 0.28) {
    const burstT = t;
    const env = Math.exp(-burstT * 8); // Decay envelope
    const s1 = Math.sin(2 * Math.PI * 880 * burstT);
    const s2 = Math.sin(2 * Math.PI * 1320 * burstT);
    sample = (s1 * 0.6 + s2 * 0.4) * env;
  } else if (t >= 0.32 && t < 0.85) {
    const burstT = t - 0.32;
    const env = Math.exp(-burstT * 6); // Slightly longer decay
    const s1 = Math.sin(2 * Math.PI * 1046.5 * burstT); // C6
    const s2 = Math.sin(2 * Math.PI * 1567.98 * burstT); // G6
    const s3 = Math.sin(2 * Math.PI * 2093.0 * burstT); // C7 harmonic
    sample = (s1 * 0.5 + s2 * 0.35 + s3 * 0.15) * env;
  }

  // Scale to 16-bit integer with good punch
  const intSample = Math.max(-32767, Math.min(32767, Math.floor(sample * 30000)));
  buffer.writeInt16LE(intSample, 44 + i * 2);
}

const outputPath = path.join(__dirname, 'driver-android-native', 'app', 'src', 'main', 'res', 'raw', 'ride_alert.wav');
fs.writeFileSync(outputPath, buffer);
console.log('Generado exitosamente tono de alerta profesional en:', outputPath, `(${buffer.length} bytes)`);
