import rtms from "@zoom/rtms";

import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
let audioChunks = [];
let rtmsClient = null; // Single declaration of the client variable

import { AssemblyAI } from "assemblyai";

const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY,
});

const SAMPLE_RATE = 16_000;
const transcriber = client.realtime.transcriber({
  sampleRate: SAMPLE_RATE,
});

transcriber.on("open", ({ sessionId }) => {
  console.log(`Session opened with ID: ${sessionId}`);
});

transcriber.on("error", (error) => {
  console.error("Error:", error);
});

transcriber.on("close", (code, reason) => {
  console.log("Session closed:", code, reason);
});

transcriber.on("transcript", (transcript) => {
  if (!transcript.text) {
    return;
  }

  if (transcript.message_type === "PartialTranscript") {
    // console.log("Partial:", transcript.text);
    return;
  } else {
    console.log("Final:", transcript.text);
  }
});

await transcriber.connect();

rtms.onWebhookEvent(({ event, payload }) => {
  console.log(event, payload);

  if (event === "meeting.rtms_started") {
    rtmsClient = new rtms.Client();

    rtmsClient.onAudioData((data, timestamp, metadata) => {
      audioChunks.push(data);
      transcriber.sendAudio(data);
    });

    rtmsClient.join(payload);
  } else if (event === "meeting.rtms_stopped") {
    if (audioChunks.length === 0) {
      console.error("No audio data received");
      process.exit(1);
    }

    const meetingId = payload.meeting_uuid.replace(/[^a-zA-Z0-9]/g, "_");
    const rawFilename = `recording_${meetingId}.raw`;
    const wavFilename = `recording_${meetingId}.wav`;

    const combinedBuffer = Buffer.concat(audioChunks);
    fs.writeFileSync(rawFilename, combinedBuffer);

    convertRawToWav(rawFilename, wavFilename)
      .then(async () => {
        console.log("WAV saved: ", wavFilename);

        try {
          const transcript = await client.transcripts.transcribe({
            audio: wavFilename,
          });

          if (transcript.status === "error") {
            console.error(`Transcription failed: ${transcript.error}`);
          } else {
            console.log("Async transcription:\n", transcript.text);
          }
        } catch (error) {
          console.error("Transcription error:", error);
        } finally {
          // Clean up resources regardless of transcription success
          audioChunks = [];
          transcriber.close();
          if (rtmsClient) {
            rtmsClient.leave();
            rtmsClient = null;
          }
          // Optionally clean up the WAV file if you don't need it
          fs.unlinkSync(wavFilename);
        }
      })
      .catch((error) => {
        console.error("Error converting audio:", error);
        audioChunks = [];
        transcriber.close();
        if (rtmsClient) {
          rtmsClient.leave();
          rtmsClient = null;
        }
      });
  }
});

async function convertRawToWav(rawFilename, wavFilename) {
  const command = `ffmpeg -y -f s16le -ar 16000 -ac 1 -i ${rawFilename} ${wavFilename}`;
  await execAsync(command);
  fs.unlinkSync(rawFilename);
}
