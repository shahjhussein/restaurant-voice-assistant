import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Store reservation data per call
// Key = streamSid, Value = reservation state
const reservations = new Map();

function createEmptyReservation() {
    return {
        name: null,
        date: null,
        time: null,
        partySize: null,
        notes: null,
        step: "ask_name" // first step
    };
}

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = `
You are a friendly, professional restaurant reservation assistant for a single restaurant.

Your ONLY job is to take table bookings over the phone.

You MUST follow this flow, one step at a time:
1) Ask for the caller's name.
2) Ask for the date of the reservation.
3) Ask for the time of the reservation.
4) Ask how many people are in the party.
5) Ask about any special requests or notes (for example window seat, allergies, birthday, etc.).
6) Clearly repeat back the full reservation (name, date, time, party size, notes).
7) Ask the caller to confirm (yes/no). If they confirm, thank them and politely end the call. If they correct something, fix it and confirm again.

Rules:
- Ask EXACTLY ONE question at a time.
- Keep each reply short and clear (one or two sentences).
- If the caller gives multiple details at once, extract what you can, then ask about the next missing detail.
- If the caller goes off-topic, gently steer them back to completing the reservation.
- Never mention that you are an AI or talk about models or APIs. Just act like a normal restaurant receptionist.
`;

const VOICE = 'alloy';
const TEMPERATURE = 0.3; // Lower = more focused, less chatty
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console.
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'session.updated'
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">
    Please wait while we connect your call powered by Syntropy AI.
  </Say>

  <Pause length="1"/>

  <Say voice="Google.en-US-Chirp3-HD-Aoede">
    Okay, you can start talking!
  </Say>

  <Connect>
    <Stream url="wss://restaurant-voice-assistant-0gl9.onrender.com/media-stream"/>
  </Connect>
</Response>`;

    reply.type('text/xml').send(twimlResponse);
});


// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket(
            `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                }
            }
        );

        // Control initial session with OpenAI
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: "gpt-realtime",
                    output_modalities: ["audio"],
                    audio: {
                        input: {
                            format: { type: 'audio/pcmu' },
                            turn_detection: { type: "server_vad" }
                        },
                        output: {
                            format: { type: 'audio/pcmu' },
                            voice: VOICE
                        },
                    },
                    tools: [
                        {
                            type: "function",
                            name: "update_reservation",
                            description: "Update the reservation details extracted from the caller's speech.",
                            parameters: {
                                type: "object",
                                properties: {
                                    name: { type: "string" },
                                    date: { type: "string" },
                                    time: { type: "string" },
                                    partySize: { type: "string" },
                                    notes: { type: "string" },
                                    confirm: { type: "boolean" }
                                }
                            }
                        }
                    ],
                    instructions: SYSTEM_MESSAGE,
                },
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) {
                    console.log(
                        `Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
                    );
                }

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) {
                        console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    }
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                // STEP 6: Handle function/tool calls from OpenAI
                if (response.type === "response.function_call") {
                    const { name, arguments: args } = response;

                    if (name === "update_reservation") {
                        const r = reservations.get(streamSid);
                        if (!r) {
                            console.error("No reservation state found for stream:", streamSid);
                            return;
                        }

                        const parsed = JSON.parse(args);

                        // Update fields if provided
                        if (parsed.name) r.name = parsed.name;
                        if (parsed.date) r.date = parsed.date;
                        if (parsed.time) r.time = parsed.time;
                        if (parsed.partySize) r.partySize = parsed.partySize;
                        if (parsed.notes) r.notes = parsed.notes;

                        // Determine the next step
                        if (parsed.confirm === true) {
                            r.step = "confirmed";
                        } else {
                            if (!r.name) r.step = "ask_name";
                            else if (!r.date) r.step = "ask_date";
                            else if (!r.time) r.step = "ask_time";
                            else if (!r.partySize) r.step = "ask_party_size";
                            else if (!r.notes) r.step = "ask_notes";
                            else r.step = "confirm";
                        }

                        console.log("Updated reservation:", r);

                        // If fully confirmed → final message + hangup
                        if (r.step === "confirmed") {
                            askFinalMessageAndHangup(openAiWs, connection, streamSid);
                            return;
                        }

                        // Otherwise → continue normal flow
                        askNextQuestion(openAiWs, r.step, r);
                        return; // we've handled this event
                    }
                }

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'response.output_audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    // First delta from a new response starts the elapsed time counter
                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) {
                            console.log(
                                `Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`
                            );
                        }
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }

                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) {
                            console.log(
                                `Received media message with timestamp: ${latestMediaTimestamp}ms`
                            );
                        }
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);

                        // Reset timing state
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;

                        // Create a new reservation record for this call
                        reservations.set(streamSid, createEmptyReservation());
                        console.log("New reservation state created for call:", reservations.get(streamSid));
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

function askNextQuestion(openAiWs, step, r) {
    let question = "";

    switch (step) {
        case "ask_name":
            question = "Sure, what's the name for the reservation?";
            break;
        case "ask_date":
            question = "Okay, what date would you like to book?";
            break;
        case "ask_time":
            question = "Great, and what time would you like?";
            break;
        case "ask_party_size":
            question = "How many people will be dining?";
            break;
        case "ask_notes":
            question = "Any special requests, such as allergies or seating preferences?";
            break;
        case "confirm":
            question = `Okay, just to confirm: ${r.name} for ${r.partySize} on ${r.date} at ${r.time}. Should I go ahead and book that?`;
            break;
        default:
            question = "";
            break;
    }

    if (!question) return;

    // AI speaks the question
    openAiWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
            type: "message",
            role: "assistant",
            content: [
                { type: "output_text", text: question }
            ]
        }
    }));

    openAiWs.send(JSON.stringify({ type: "response.create" }));
}

function askFinalMessageAndHangup(openAiWs, connection, streamSid) {
    // Final spoken message
    const msg = "Your reservation is all set. Thank you for calling, and have a wonderful day! Goodbye.";

    // AI speaks the final message
    openAiWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
            type: "message",
            role: "assistant",
            content: [
                { type: "output_text", text: msg }
            ]
        }
    }));
    openAiWs.send(JSON.stringify({ type: "response.create" }));

    // After a short delay, hang up the Twilio call
    setTimeout(() => {
        if (connection.readyState === 1) {
            connection.send(JSON.stringify({
                event: "stop",
                streamSid: streamSid
            }));
        }
    }, 1500); // wait 1.5 seconds for message playback
}

fastify.listen(
    { port: PORT, host: "0.0.0.0" },
    (err) => {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        console.log(`Server is listening on port ${PORT}`);
    }
);

