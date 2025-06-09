import rtms from "@zoom/rtms";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import WebSocket from "ws";
import querystring from "querystring";

const execAsync = promisify(exec);
let audioChunks = [];
let rtmsClient = null;
let streamingWs = null;
let stopRequested = false;

// Audio buffering for streaming
let audioBuffer = [];
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2; // 16-bit audio
const TARGET_CHUNK_DURATION_MS = 100; // 100ms chunks (within 50-1000ms range)
const TARGET_CHUNK_SIZE = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * TARGET_CHUNK_DURATION_MS) / 1000;

// New v3 Streaming Configuration
const CONNECTION_PARAMS = {
  sample_rate: SAMPLE_RATE,
  format_turns: true, // Request formatted final transcripts
};
const API_ENDPOINT_BASE_URL = "wss://streaming.assemblyai.com/v3/ws";
const API_ENDPOINT = `${API_ENDPOINT_BASE_URL}?${querystring.stringify(CONNECTION_PARAMS)}`;

function initializeStreamingTranscription() {
  if (streamingWs) {
    streamingWs.close();
  }

  // Reset audio buffer
  audioBuffer = [];

  streamingWs = new WebSocket(API_ENDPOINT, {
    headers: {
      Authorization: process.env.ASSEMBLYAI_API_KEY,
    },
  });

  streamingWs.on("open", () => {
    console.log("Streaming WebSocket connection opened.");
    console.log(`Connected to: ${API_ENDPOINT}`);
    console.log(`Target chunk size: ${TARGET_CHUNK_SIZE} bytes (${TARGET_CHUNK_DURATION_MS}ms)`);
  });

  streamingWs.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      const msgType = data.type;

      if (msgType === "Begin") {
        const sessionId = data.id;
        const expiresAt = data.expires_at;
        console.log(
          `Session began: ID=${sessionId}, ExpiresAt=${new Date(expiresAt * 1000).toISOString()}`
        );
      } else if (msgType === "Turn") {
        const transcript = data.transcript || "";
        const formatted = data.turn_is_formatted;

        if (formatted) {
          // Clear line and print final transcript
          process.stdout.write('\r' + ' '.repeat(80) + '\r');
          console.log("Real-time Final:", transcript);
        } else {
          // Show partial transcript
          process.stdout.write(`\rReal-time Partial: ${transcript}`);
        }
      } else if (msgType === "Termination") {
        const audioDuration = data.audio_duration_seconds;
        const sessionDuration = data.session_duration_seconds;
        console.log(
          `\nSession Terminated: Audio Duration=${audioDuration}s, Session Duration=${sessionDuration}s`
        );
      }
    } catch (error) {
      console.error(`Error handling streaming message: ${error}`);
      console.error(`Message data: ${message}`);
    }
  });

  streamingWs.on("error", (error) => {
    console.error(`Streaming WebSocket Error: ${error}`);
    stopRequested = true;
  });

  streamingWs.on("close", (code, reason) => {
    console.log(`Streaming WebSocket Disconnected: Status=${code}, Msg=${reason}`);
  });
}

function sendBufferedAudio(data) {
  // Add incoming audio data to buffer
  audioBuffer.push(data);
  
  // Calculate total buffered size
  const totalBufferedSize = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
  
  // If we have enough data, send it to streaming API
  if (totalBufferedSize >= TARGET_CHUNK_SIZE) {
    // Combine buffered chunks
    const combinedBuffer = Buffer.concat(audioBuffer);
    
    // Send the target chunk size
    const chunkToSend = combinedBuffer.subarray(0, TARGET_CHUNK_SIZE);
    
    // Keep remaining data in buffer
    const remainingData = combinedBuffer.subarray(TARGET_CHUNK_SIZE);
    audioBuffer = remainingData.length > 0 ? [remainingData] : [];
    
    // Send to streaming API
    if (streamingWs && streamingWs.readyState === WebSocket.OPEN && !stopRequested) {
      try {
        streamingWs.send(chunkToSend);
        // console.log(`Sent ${chunkToSend.length} bytes (${(chunkToSend.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) * 1000).toFixed(1)}ms) to streaming API`);
      } catch (error) {
        console.error("Error sending audio to streaming transcription:", error);
      }
    }
  }
}

function flushAudioBuffer() {
  // Send any remaining audio data when the meeting ends
  if (audioBuffer.length > 0) {
    const combinedBuffer = Buffer.concat(audioBuffer);
    
    // Only send if it's at least 50ms (minimum requirement)
    const minChunkSize = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * 50) / 1000;
    
    if (combinedBuffer.length >= minChunkSize && streamingWs && streamingWs.readyState === WebSocket.OPEN) {
      try {
        streamingWs.send(combinedBuffer);
        console.log(`Flushed remaining ${combinedBuffer.length} bytes (${(combinedBuffer.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) * 1000).toFixed(1)}ms) to streaming API`);
      } catch (error) {
        console.error("Error flushing audio buffer:", error);
      }
    }
    
    audioBuffer = [];
  }
}

function cleanupStreamingTranscription() {
  stopRequested = true;
  
  // Flush any remaining audio data
  flushAudioBuffer();
  
  if (streamingWs && [WebSocket.OPEN, WebSocket.CONNECTING].includes(streamingWs.readyState)) {
    try {
      // Send termination message if possible
      if (streamingWs.readyState === WebSocket.OPEN) {
        const terminateMessage = { type: "Terminate" };
        console.log(`Sending termination message: ${JSON.stringify(terminateMessage)}`);
        streamingWs.send(JSON.stringify(terminateMessage));
      }
      
      // Give a moment for final messages to process
      setTimeout(() => {
        if (streamingWs) {
          streamingWs.close();
          streamingWs = null;
        }
      }, 1000);
    } catch (error) {
      console.error(`Error closing streaming WebSocket: ${error}`);
    }
  }
  
  // Reset buffer
  audioBuffer = [];
}

rtms.onWebhookEvent(({ event, payload }) => {
  console.log(event, payload);

  if (event === "meeting.rtms_started") {
    // Initialize streaming transcription
    initializeStreamingTranscription();
    
    rtmsClient = new rtms.Client();

    rtmsClient.onAudioData((data, timestamp, metadata) => {
      // Store audio chunks for post-meeting processing
      audioChunks.push(data);
      
      // Buffer and send audio data to streaming transcription in real-time
      sendBufferedAudio(data);
    });

    rtmsClient.join(payload);
  } else if (event === "meeting.rtms_stopped") {
    // Clean up streaming transcription
    cleanupStreamingTranscription();
    
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
          // Optional: Still do post-meeting transcription for backup/comparison
          console.log("Starting post-meeting transcription for backup...");
          
          // Using the legacy client for post-meeting transcription
          const { AssemblyAI } = await import("assemblyai");
          const client = new AssemblyAI({
            apiKey: process.env.ASSEMBLYAI_API_KEY,
          });
          
          const transcript = await client.transcripts.transcribe({
            audio: wavFilename,
          });

          if (transcript.status === "error") {
            console.error(`Post-meeting transcription failed: ${transcript.error}`);
          } else {
            console.log("Post-meeting transcription completed:\n", transcript.text);
          }
        } catch (error) {
          console.error("Post-meeting transcription error:", error);
        } finally {
          // Clean up resources
          audioChunks = [];
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

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\nCtrl+C received. Stopping...");
  cleanupStreamingTranscription();
  if (rtmsClient) {
    rtmsClient.leave();
  }
  setTimeout(() => process.exit(0), 1000);
});

process.on("SIGTERM", () => {
  console.log("\nTermination signal received. Stopping...");
  cleanupStreamingTranscription();
  if (rtmsClient) {
    rtmsClient.leave();
  }
  setTimeout(() => process.exit(0), 1000);
});

process.on("uncaughtException", (error) => {
  console.error(`\nUncaught exception: ${error}`);
  cleanupStreamingTranscription();
  if (rtmsClient) {
    rtmsClient.leave();
  }
  setTimeout(() => process.exit(1), 1000);
});