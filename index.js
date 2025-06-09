import rtms from "@zoom/rtms";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import WebSocket from "ws";
import querystring from "querystring";
import { AssemblyAI } from "assemblyai";
import Anthropic from "@anthropic-ai/sdk";

const execAsync = promisify(exec);
let audioChunks = [];
let rtmsClient = null;
let streamingWs = null;
let stopRequested = false;

// Sales Analysis Setup
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Store conversation data
let conversationHistory = [];
let conversationId = null;
let salesData = {
  summary: [],
  bant: {
    budget: "Not identified",
    authority: "Not identified", 
    need: "Not identified",
    timeline: "Not identified"
  },
  companyInfo: "Not identified",
  salesReminders: [],
  objections: []
};

// Audio buffering for streaming
let audioBuffer = [];
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const TARGET_CHUNK_DURATION_MS = 100;
const TARGET_CHUNK_SIZE = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * TARGET_CHUNK_DURATION_MS) / 1000;

// New v3 Streaming Configuration
const CONNECTION_PARAMS = {
  sample_rate: SAMPLE_RATE,
  format_turns: true,
};
const API_ENDPOINT_BASE_URL = "wss://streaming.assemblyai.com/v3/ws";
const API_ENDPOINT = `${API_ENDPOINT_BASE_URL}?${querystring.stringify(CONNECTION_PARAMS)}`;

// Sales Analysis Tools
const TOOLS = [
  {
    name: "update_summary",
    description: "Add a new bullet point to the conversation summary when there's significant new information. Each bullet should be brief and concise. Only add a new bullet when there's meaningful new information to add.",
    input_schema: {
      type: "object",
      properties: {
        new_point: {
          type: "string",
          description: "A single new bullet point summarizing the latest significant development (without bullet symbol)"
        }
      },
      required: ["new_point"]
    }
  },
  {
    name: "update_bant",
    description: "Update the BANT (Budget, Authority, Need, Timeline) qualification assessment based on the conversation",
    input_schema: {
      type: "object",
      properties: {
        budget: {
          type: "string",
          description: "Identified budget information (anything related to the customers finances) or 'Not identified'"
        },
        authority: {
          type: "string",
          description: "Identified decision-maker information or 'Not identified'"
        },
        need: {
          type: "string",
          description: "Identified business needs or 'Not identified'"
        },
        timeline: {
          type: "string",
          description: "Identified implementation timeline or 'Not identified'"
        }
      },
      required: ["budget", "authority", "need", "timeline"]
    }
  },
  {
    name: "update_company_info",
    description: "Update information about the prospect's or customer's company when new details are discovered. Don't include information on the sales reps company.",
    input_schema: {
      type: "object",
      properties: {
        companyInfo: {
          type: "string",
          description: "Key information about the prospect's company. Don't include information on the sales reps company."
        }
      },
      required: ["companyInfo"]
    }
  },
  {
    name: "update_sales_reminders",
    description: "Add a new bullet point reminder when there's an important new suggestion for the sales representative. Each reminder should be brief and actionable. Only add a new bullet when there's a meaningful new reminder.",
    input_schema: {
      type: "object",
      properties: {
        new_reminder: {
          type: "string",
          description: "A single new bullet point reminder (without bullet symbol)"
        }
      },
      required: ["new_reminder"]
    }
  },
  {
    name: "update_objections",
    description: "Add a new objection and handling strategy when a new customer concern is identified. Only add when there's a clear new objection.",
    input_schema: {
      type: "object",
      properties: {
        new_objection: {
          type: "object",
          properties: {
            objection: {
              type: "string",
              description: "The new customer objection or concern (brief)"
            },
            handling_strategy: {
              type: "string",
              description: "Suggested approach to handle this objection (brief)"
            }
          },
          required: ["objection", "handling_strategy"]
        }
      },
      required: ["new_objection"]
    }
  }
];

function getSystemPrompt(callContext) {
  return `You are an expert sales analyst monitoring an ongoing sales conversation in real-time. 
    Your role is to provide valuable insights to the sales representative by analyzing the conversation as it unfolds. 
    Only make updates that help the sales rep. The insights you are providing should be regarding the customer.

    The conversation may or may not be labeled with speakers (Sales Rep: or Customer:) to help you understand who is speaking.
    If the conversations is not labeled, do your best to infer who is speaking.
    You should focus on identifying key information about the prospect, their needs, and potential opportunities while 
    maintaining an organized understanding of the conversation's progress.
    ${callContext ? `\nAdditional context for this specific call: ${callContext}` : ''}`;
}

async function executeToolAndGetResult(toolUse) {
  switch (toolUse.name) {
    case 'update_summary':
      salesData.summary.push(toolUse.input.new_point);
      logSalesUpdate('SUMMARY UPDATE', toolUse.input.new_point);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Summary point added successfully"
      };
    case 'update_bant':
      salesData.bant = { ...salesData.bant, ...toolUse.input };
      logSalesUpdate('BANT UPDATE', toolUse.input);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "BANT information updated successfully"
      };
    case 'update_company_info':
      salesData.companyInfo = toolUse.input.companyInfo;
      logSalesUpdate('COMPANY INFO UPDATE', toolUse.input.companyInfo);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Company information updated successfully"
      };
    case 'update_sales_reminders':
      salesData.salesReminders.push(toolUse.input.new_reminder);
      logSalesUpdate('SALES REMINDER', toolUse.input.new_reminder);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Sales reminder added successfully"
      };
    case 'update_objections':
      salesData.objections.push(toolUse.input.new_objection);
      logSalesUpdate('OBJECTION IDENTIFIED', toolUse.input.new_objection);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "New objection added successfully"
      };
    default:
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: "Tool execution completed"
      };
  }
}

function logSalesUpdate(type, data) {
  console.log('\n' + '='.repeat(60));
  console.log(`🔥 ${type} - ${new Date().toLocaleTimeString()}`);
  console.log('='.repeat(60));
  
  if (typeof data === 'object') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
  
  console.log('='.repeat(60) + '\n');
}

function displayCurrentSalesData() {
  console.log('\n' + '█'.repeat(80));
  console.log('🎯 CURRENT SALES INTELLIGENCE DASHBOARD');
  console.log('█'.repeat(80));
  
  console.log('\n📝 CONVERSATION SUMMARY:');
  if (salesData.summary.length > 0) {
    salesData.summary.forEach((point, index) => {
      console.log(`  ${index + 1}. ${point}`);
    });
  } else {
    console.log('  No key points identified yet');
  }
  
  console.log('\n💰 BANT QUALIFICATION:');
  console.log(`  Budget:    ${salesData.bant.budget}`);
  console.log(`  Authority: ${salesData.bant.authority}`);
  console.log(`  Need:      ${salesData.bant.need}`);
  console.log(`  Timeline:  ${salesData.bant.timeline}`);
  
  console.log('\n🏢 COMPANY INFO:');
  console.log(`  ${salesData.companyInfo}`);
  
  console.log('\n💡 SALES REMINDERS:');
  if (salesData.salesReminders.length > 0) {
    salesData.salesReminders.forEach((reminder, index) => {
      console.log(`  ${index + 1}. ${reminder}`);
    });
  } else {
    console.log('  No reminders yet');
  }
  
  console.log('\n⚠️  OBJECTIONS & HANDLING:');
  if (salesData.objections.length > 0) {
    salesData.objections.forEach((obj, index) => {
      console.log(`  ${index + 1}. Objection: ${obj.objection}`);
      console.log(`     Strategy: ${obj.handling_strategy}`);
    });
  } else {
    console.log('  No objections identified yet');
  }
  
  console.log('\n' + '█'.repeat(80) + '\n');
}

async function processTranscript(transcript) {
  if (!transcript.trim()) return;
  
  console.log('\n🔍 Processing transcript for sales insights...');
  console.log(`Transcript: "${transcript}"`);
  
  try {
    const userMessage = {
      role: "user",
      content: `New conversation segment: ${transcript}`
    };
    conversationHistory.push(userMessage);

    // Filter out empty messages
    const validHistory = conversationHistory.filter(msg => {
      if (Array.isArray(msg.content)) {
        return msg.content.length > 0;
      }
      return msg.content && msg.content.trim().length > 0;
    });

    let message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: getSystemPrompt(),
      tools: TOOLS,
      messages: validHistory
    });

    // Process tool uses
    while (message.stop_reason === 'tool_use') {
      const toolResults = [];
      
      for (const content of message.content) {
        if (content.type === 'tool_use') {
          const result = await executeToolAndGetResult(content);
          toolResults.push(result);
        }
      }

      if (message.content && message.content.length > 0) {
        conversationHistory.push({
          role: "assistant",
          content: message.content
        });
      }

      if (toolResults.length > 0) {
        conversationHistory.push({
          role: "user",
          content: toolResults
        });
      }

      // Get next message
      const validHistoryAfterTools = conversationHistory.filter(msg => {
        if (Array.isArray(msg.content)) {
          return msg.content.length > 0;
        }
        return msg.content && msg.content.trim().length > 0;
      });

      message = await anthropic.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        system: getSystemPrompt(),
        tools: TOOLS,
        messages: validHistoryAfterTools
      });
    }

    if (message.stop_reason !== 'tool_use' && message.content && message.content.length > 0) {
      conversationHistory.push({
        role: "assistant",
        content: message.content
      });
    }

    // Save conversation logs
    if (!fs.existsSync('./conversation_logs')) {
      fs.mkdirSync('./conversation_logs');
    }
    fs.writeFileSync(
      `./conversation_logs/${conversationId}.json`, 
      JSON.stringify({
        conversationHistory,
        salesData,
        timestamp: new Date().toISOString()
      }, null, 2)
    );

  } catch (error) {
    console.error('❌ Error processing transcript:', error);
  }
}

function initializeStreamingTranscription() {
  if (streamingWs) {
    streamingWs.close();
  }

  audioBuffer = [];

  streamingWs = new WebSocket(API_ENDPOINT, {
    headers: {
      Authorization: process.env.ASSEMBLYAI_API_KEY,
    },
  });

  streamingWs.on("open", () => {
    console.log("🎙️  Streaming WebSocket connection opened.");
    console.log(`Connected to: ${API_ENDPOINT}`);
    console.log(`Target chunk size: ${TARGET_CHUNK_SIZE} bytes (${TARGET_CHUNK_DURATION_MS}ms)`);
  });

  streamingWs.on("message", async (message) => {
    try {
      const data = JSON.parse(message);
      const msgType = data.type;

      if (msgType === "Begin") {
        const sessionId = data.id;
        const expiresAt = data.expires_at;
        console.log(
          `✅ Session began: ID=${sessionId}, ExpiresAt=${new Date(expiresAt * 1000).toISOString()}`
        );
      } else if (msgType === "Turn") {
        const transcript = data.transcript || "";
        const formatted = data.turn_is_formatted;

        if (formatted) {
          // Clear line and print final transcript
          process.stdout.write('\r' + ' '.repeat(80) + '\r');
          console.log("📝 Real-time Final:", transcript);
          
          // Process transcript for sales insights
          await processTranscript(transcript);
          
          // Display updated dashboard every few transcripts
          displayCurrentSalesData();
        } else {
          // Show partial transcript
          process.stdout.write(`\r📝 Real-time Partial: ${transcript}`);
        }
      } else if (msgType === "Termination") {
        const audioDuration = data.audio_duration_seconds;
        const sessionDuration = data.session_duration_seconds;
        console.log(
          `\n🏁 Session Terminated: Audio Duration=${audioDuration}s, Session Duration=${sessionDuration}s`
        );
        
        // Final sales summary
        console.log('\n🎯 FINAL SALES CALL SUMMARY:');
        displayCurrentSalesData();
      }
    } catch (error) {
      console.error(`❌ Error handling streaming message: ${error}`);
    }
  });

  streamingWs.on("error", (error) => {
    console.error(`❌ Streaming WebSocket Error: ${error}`);
    stopRequested = true;
  });

  streamingWs.on("close", (code, reason) => {
    console.log(`🔌 Streaming WebSocket Disconnected: Status=${code}, Msg=${reason}`);
  });
}

function sendBufferedAudio(data) {
  audioBuffer.push(data);
  
  const totalBufferedSize = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
  
  if (totalBufferedSize >= TARGET_CHUNK_SIZE) {
    const combinedBuffer = Buffer.concat(audioBuffer);
    const chunkToSend = combinedBuffer.subarray(0, TARGET_CHUNK_SIZE);
    const remainingData = combinedBuffer.subarray(TARGET_CHUNK_SIZE);
    audioBuffer = remainingData.length > 0 ? [remainingData] : [];
    
    if (streamingWs && streamingWs.readyState === WebSocket.OPEN && !stopRequested) {
      try {
        streamingWs.send(chunkToSend);
      } catch (error) {
        console.error("❌ Error sending audio to streaming transcription:", error);
      }
    }
  }
}

function flushAudioBuffer() {
  if (audioBuffer.length > 0) {
    const combinedBuffer = Buffer.concat(audioBuffer);
    const minChunkSize = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * 50) / 1000;
    
    if (combinedBuffer.length >= minChunkSize && streamingWs && streamingWs.readyState === WebSocket.OPEN) {
      try {
        streamingWs.send(combinedBuffer);
        console.log(`🔄 Flushed remaining ${combinedBuffer.length} bytes to streaming API`);
      } catch (error) {
        console.error("❌ Error flushing audio buffer:", error);
      }
    }
    
    audioBuffer = [];
  }
}

function cleanupStreamingTranscription() {
  stopRequested = true;
  flushAudioBuffer();
  
  if (streamingWs && [WebSocket.OPEN, WebSocket.CONNECTING].includes(streamingWs.readyState)) {
    try {
      if (streamingWs.readyState === WebSocket.OPEN) {
        const terminateMessage = { type: "Terminate" };
        console.log(`📤 Sending termination message: ${JSON.stringify(terminateMessage)}`);
        streamingWs.send(JSON.stringify(terminateMessage));
      }
      
      setTimeout(() => {
        if (streamingWs) {
          streamingWs.close();
          streamingWs = null;
        }
      }, 1000);
    } catch (error) {
      console.error(`❌ Error closing streaming WebSocket: ${error}`);
    }
  }
  
  audioBuffer = [];
}

rtms.onWebhookEvent(({ event, payload }) => {
  console.log('📡', event, payload);

  if (event === "meeting.rtms_started") {
    // Initialize conversation
    conversationId = payload.meeting_uuid.replace(/[^a-zA-Z0-9]/g, "_");
    conversationHistory = [];
    salesData = {
      summary: [],
      bant: {
        budget: "Not identified",
        authority: "Not identified", 
        need: "Not identified",
        timeline: "Not identified"
      },
      companyInfo: "Not identified",
      salesReminders: [],
      objections: []
    };
    
    console.log('\n🚀 STARTING SALES CALL ANALYSIS');
    console.log(`📞 Meeting ID: ${conversationId}`);
    console.log('🤖 AI Sales Assistant is now monitoring the conversation...\n');
    
    initializeStreamingTranscription();
    
    rtmsClient = new rtms.Client();

    rtmsClient.onAudioData((data, timestamp, metadata) => {
      audioChunks.push(data);
      sendBufferedAudio(data);
    });

    rtmsClient.join(payload);
  } else if (event === "meeting.rtms_stopped") {
    cleanupStreamingTranscription();
    
    console.log('\n🏁 MEETING ENDED - GENERATING FINAL REPORT');
    displayCurrentSalesData();
    
    if (audioChunks.length === 0) {
      console.error("❌ No audio data received");
      process.exit(1);
    }

    const meetingId = payload.meeting_uuid.replace(/[^a-zA-Z0-9]/g, "_");
    const rawFilename = `recording_${meetingId}.raw`;
    const wavFilename = `recording_${meetingId}.wav`;

    const combinedBuffer = Buffer.concat(audioChunks);
    fs.writeFileSync(rawFilename, combinedBuffer);

    convertRawToWav(rawFilename, wavFilename)
      .then(async () => {
        console.log("🎵 WAV saved: ", wavFilename);

        try {
          console.log("📄 Starting post-meeting transcription for backup...");
          
          const { AssemblyAI } = await import("assemblyai");
          const client = new AssemblyAI({
            apiKey: process.env.ASSEMBLYAI_API_KEY,
          });
          
          const transcript = await client.transcripts.transcribe({
            audio: wavFilename,
          });

          if (transcript.status === "error") {
            console.error(`❌ Post-meeting transcription failed: ${transcript.error}`);
          } else {
            console.log("✅ Post-meeting transcription completed");
            
            // Save final report
            const finalReport = {
              meetingId,
              timestamp: new Date().toISOString(),
              salesData,
              conversationHistory,
              fullTranscript: transcript.text
            };
            
            fs.writeFileSync(
              `./conversation_logs/${meetingId}_final_report.json`, 
              JSON.stringify(finalReport, null, 2)
            );
            
            console.log(`📊 Final sales report saved: ./conversation_logs/${meetingId}_final_report.json`);
          }
        } catch (error) {
          console.error("❌ Post-meeting transcription error:", error);
        } finally {
          audioChunks = [];
          if (rtmsClient) {
            rtmsClient.leave();
            rtmsClient = null;
          }
          fs.unlinkSync(wavFilename);
        }
      })
      .catch((error) => {
        console.error("❌ Error converting audio:", error);
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
  console.log("\n🛑 Ctrl+C received. Stopping...");
  cleanupStreamingTranscription();
  if (rtmsClient) {
    rtmsClient.leave();
  }
  setTimeout(() => process.exit(0), 1000);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Termination signal received. Stopping...");
  cleanupStreamingTranscription();
  if (rtmsClient) {
    rtmsClient.leave();
  }
  setTimeout(() => process.exit(0), 1000);
});

process.on("uncaughtException", (error) => {
  console.error(`\n❌ Uncaught exception: ${error}`);
  cleanupStreamingTranscription();
  if (rtmsClient) {
    rtmsClient.leave();
  }
  setTimeout(() => process.exit(1), 1000);
});

console.log('\n🎯 ZOOM SALES INTELLIGENCE SYSTEM STARTED');
console.log('🤖 Ready to analyze sales conversations...');
console.log('💡 Make sure your ASSEMBLYAI_API_KEY and ANTHROPIC_API_KEY are set in .env\n');