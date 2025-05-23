import os
import sys
import threading
import time
import json
import queue
import traceback
import pyaudio
import numpy as np

gw = None 
try:
    import pygetwindow as gw # Attempt to import and assign to gw
except ImportError:
    print("ERROR: 'pygetwindow' not found. Please install it: pip install pygetwindow")
    # gw remains None in this case, which is handled by the if not gw: check
except Exception as e:
    print(f"ERROR: Unexpected error importing pygetwindow: {e}")
    traceback.print_exc()

# Try to import whisper and ollama. Provide better error messages if they fail.
try:
    import whisper
except ImportError:
    print("ERROR: 'openai-whisper' not found. Please install it: pip install openai-whisper")
    sys.exit(1)

try:
    import ollama
except ImportError:
    print("ERROR: 'ollama' Python client not found. Please install it: pip install ollama")
    sys.exit(1)

try:
    from flask import Flask, request, jsonify
    from flask_socketio import SocketIO, emit
except ImportError:
    print("ERROR: Flask or Flask-SocketIO not found. Please install them: pip install Flask Flask-SocketIO")
    sys.exit(1)


# --- Configuration ---
# Audio settings
AUDIO_CHUNK_SIZE = 1024       # Size of audio buffer chunks (smaller = more frequent processing)
AUDIO_FORMAT = pyaudio.paInt16
AUDIO_CHANNELS = 1
AUDIO_RATE = 16000            # Sample rate for Whisper (16kHz is optimal)
AUDIO_BUFFER_DURATION = 10    # seconds: Increase this for more context for Whisper/LLM
AUDIO_OVERLAP_DURATION = 3    # seconds: Maintain overlap for smoother transcription

# AI Model settings
WHISPER_MODEL = "small.en"    # Choose based on performance/accuracy: "tiny.en", "base.en", "small.en", "medium.en"
OLLAMA_MODEL = "phi4-mini:latest" # Or "phi4:latest". Phi-3 is generally better.

# Session persistence
SESSION_DATA_FILE = "session_data.json"

# --- Global Application State ---
app = Flask(__name__)
# Flask-SocketIO for real-time communication with Electron frontend
# cors_allowed_origins="*" is for development. Restrict to specific origins in production.
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Flags and Queues for managing audio processing threads
is_listening = False
audio_queue = queue.Queue()       # Stores raw audio data chunks
transcript_queue = queue.Queue()  # Stores transcribed text chunks

# Rolling buffer to provide more context to the LLM
llm_context_buffer = []
MAX_LLM_CONTEXT_LENGTH = 1500 # Max characters in the rolling context for LLM (adjust based on model context window)
# This is a rough estimate; Phi-3 has a 4K or 8K context window usually, so 1500 chars is safe.

# Global chat history for conversational memory
llm_chat_history = []
# This will be used for both entity extraction and Q&A
# Start with a base system message
BASE_SYSTEM_MESSAGE = """

IGNORE_WHEN_COPYING_START

    Use code with caution. Python
    IGNORE_WHEN_COPYING_END

You are an AI assistant specialized in extracting named entities from video transcripts to create a structured cheat sheet, and answering user questions about the video content.
Your primary goal is to help a user follow the narrative or informational content of a video.
Identify entities (Characters, Locations, Organizations, Key Objects/Items, Concepts/Events) that are relevant to the narrative/story/topic of this specific video. Focus on adding or updating concise descriptions for these entities.

For entity extraction, format your output as a JSON array of objects.
Each object MUST have the keys 'type' (e.g., "Character", "Location", "Concept"), 'name', and 'description'.
Do NOT include any other keys or outer objects like 'entities'. Just the array.
If no new or updated entities are found that fit the criteria, return an empty array [].

Example JSON for a Character: {"type": "Character", "name": "John Doe", "description": "A brave knight who served King Arthur."}
Example JSON for a Location: {"type": "Location", "name": "Camelot", "description": "King Arthur's legendary castle."}
"""

# Initialize the LLM's full conversational history
llm_messages_history = [
    {"role": "system", "content": BASE_SYSTEM_MESSAGE}
]

current_video_title = "Unknown Video" # Global to store detected title

# Data structure to hold our live cheat sheet entities
# Stored as {entity_name: {type, name, description}} for easy lookup and update
cheat_sheet_data = {}

# --- Helper Function: Find Audio Input Device ---
def find_system_audio_input_device():
    """
    Attempts to find a suitable audio input device for capturing system audio.
    Prioritizes Voicemeeter outputs if configured, then generic loopback devices.
    """
    p = pyaudio.PyAudio()
    info = p.get_host_api_info_by_index(0)
    num_devices = info.get('deviceCount')

    found_device_id = -1
    # Ordered preference for common system loopback devices.
    # Adjust this list based on what your system's sound control panel shows
    # or what virtual audio cables/mixers you use.
    preferred_device_keywords = [
        "Voicemeeter Out B1",    # Common Voicemeeter output for loopback
        "Voicemeeter Output",    # More general Voicemeeter output name
        "CABLE Output",          # From VB-Audio Virtual Cable
        "Stereo Mix",            # Common Windows built-in loopback
        "What U Hear",           # Another common built-in loopback name
        "Loopback",              # Generic keyword
    ]

    print("DEBUG: Searching for system audio input device...")
    for i in range(0, num_devices):
        device_info = p.get_device_info_by_host_api_device_index(0, i)
        # Check if device has input channels (is a microphone/input type device)
        if (device_info.get('maxInputChannels')) > 0:
            device_name = device_info.get('name')
            print(f"DEBUG: Checking device: '{device_name}' (ID: {i})")

            for keyword in preferred_device_keywords:
                if keyword.lower() in device_name.lower():
                    print(f"DEBUG: Found preferred input device: '{device_name}' (ID: {i})")
                    found_device_id = i
                    p.terminate() # Terminate PyAudio instance as device is found
                    return found_device_id

    p.terminate() # Terminate PyAudio instance if no device found
    print("WARNING: No suitable system audio input device found from preferred list.")
    print("Please ensure your chosen virtual audio device (e.g., 'Voicemeeter Out B1', 'Stereo Mix') is configured and enabled in Windows Sound settings (Recording tab).")
    print("Audio capture will not work.")
    return -1

def get_active_browser_tab_title():
    """
    Attempts to get the title of the active browser window.
    Prioritizes known browser processes.
    """
    if not gw:
        return "Unknown Video (pygetwindow not installed)"

    active_window = gw.getActiveWindow()
    if active_window:
        title = active_window.title
        # Basic filtering/extraction for common browser patterns
        if " - YouTube" in title:
            return title.replace(" - YouTube", "").strip()
        if " - Google Chrome" in title:
            return title.replace(" - Google Chrome", "").strip()
        if " - Mozilla Firefox" in title:
            return title.replace(" - Mozilla Firefox", "").strip()
        if " - Brave" in title:
            return title.replace(" - Brave", "").strip()
        if " - Microsoft Edge" in title:
            return title.replace(" - Microsoft Edge", "").strip()
        return title # Return full title if no specific pattern found
    return "Unknown Video (no active window)"

# --- Audio Recording Thread ---
def audio_recorder():
    """
    Captures audio from the selected input device, processes it into chunks,
    and puts chunks into the audio_queue for transcription.
    """
    print("DEBUG: Inside audio_recorder thread.")
    global audio_stream, is_listening
    p = None # Initialize PyAudio instance to None

    try:
        p = pyaudio.PyAudio() # Initialize PyAudio inside the try block
        device_id = find_system_audio_input_device()

        if device_id == -1:
            socketio.emit('status', {'message': 'Error: Audio input device not found. Please check setup.'})
            print("ERROR: Audio input device not found. Stopping audio_recorder thread.")
            is_listening = False
            return # Exit thread if device not found

        print(f"DEBUG: Using audio device ID: {device_id}")
        print(f"DEBUG: Device name: {p.get_device_info_by_host_api_device_index(0, device_id).get('name')}")

        # Open the audio stream
        audio_stream = p.open(format=AUDIO_FORMAT,
                              channels=AUDIO_CHANNELS,
                              rate=AUDIO_RATE,
                              input=True,
                              frames_per_buffer=AUDIO_CHUNK_SIZE,
                              input_device_index=device_id)
        
        socketio.emit('status', {'message': 'Listening to audio...'})
        print("Audio stream started.")

        # Calculate buffer parameters for Whisper chunks
        frames_per_full_buffer = int(AUDIO_RATE * AUDIO_BUFFER_DURATION)
        frames_per_overlap = int(AUDIO_RATE * AUDIO_OVERLAP_DURATION)
        
        # Buffer to accumulate audio before sending to Whisper
        audio_buffer = np.empty(0, dtype=np.int16) 

        while is_listening:
            try:
                # Read audio data
                data = audio_stream.read(AUDIO_CHUNK_SIZE, exception_on_overflow=False)
                audio_np = np.frombuffer(data, dtype=np.int16)
                audio_buffer = np.append(audio_buffer, audio_np)
                
                # If buffer is full, send to queue and maintain overlap
                if len(audio_buffer) >= frames_per_full_buffer:
                    full_audio_data = audio_buffer[:frames_per_full_buffer]
                    audio_queue.put(full_audio_data.tobytes()) # Convert numpy array back to bytes for queue
                    
                    # Keep overlap for next buffer
                    audio_buffer = audio_buffer[frames_per_full_buffer - frames_per_overlap:]

            except IOError as e:
                # Catch specific audio stream errors (e.g., device unplugged)
                print(f"ERROR: Audio stream IOError: {e}")
                socketio.emit('status', {'message': f'Audio error: {e}. Stopping listening.'})
                is_listening = False # Stop the main loop
                break # Exit the while loop
            except Exception as e:
                print(f"CRITICAL ERROR in audio_recorder loop: {e}")
                traceback.print_exc()
                socketio.emit('status', {'message': f'CRITICAL AUDIO ERROR: {e}. Stopping listening.'})
                is_listening = False
                break
            time.sleep(0.01) # Small delay to prevent busy-waiting

    except Exception as e:
        print(f"CRITICAL ERROR starting audio_recorder: {e}")
        traceback.print_exc()
        socketio.emit('status', {'message': f'Error starting audio stream: {e}'})
        is_listening = False # Ensure listening flag is set to False on critical failure
    finally:
        # Cleanup audio resources
        if audio_stream and audio_stream.is_active():
            audio_stream.stop_stream()
            audio_stream.close()
            print("Audio stream stopped.")
        if p: # Ensure PyAudio instance was successfully created before terminating
            p.terminate()
            print("PyAudio terminated.")
        
        socketio.emit('status', {'message': 'Audio capture stopped.'})
        print("Audio recording thread finished.")


# --- Whisper Transcription Thread ---
def transcribe_audio():
    """
    Pulls audio data from audio_queue, transcribes it using Whisper,
    and puts the text into transcript_queue.
    """
    print("DEBUG: Inside transcribe_audio thread.")
    global is_listening
    
    try:
        model = whisper.load_model(WHISPER_MODEL)
        print(f"DEBUG: Whisper model '{WHISPER_MODEL}' loaded.")
        socketio.emit('status', {'message': f'Whisper model loaded: {WHISPER_MODEL}'})
    except Exception as e:
        print(f"ERROR: Failed to load Whisper model: {e}. Ensure models are downloaded and torch/CUDA is configured.")
        traceback.print_exc()
        socketio.emit('status', {'message': f'Error loading Whisper model: {e}'})
        is_listening = False # Critical failure, stop all processing
        return

    while is_listening or not audio_queue.empty():
        if not audio_queue.empty():
            audio_data_bytes = audio_queue.get()
            audio_np = np.frombuffer(audio_data_bytes, dtype=np.int16).flatten().astype(np.float32) / 32768.0
            
            try:
                # Transcribe the audio chunk
                result = model.transcribe(audio_np, fp16=False) # fp16=False if no compatible GPU
                transcript = result["text"].strip()
                
                if transcript: # Only process non-empty transcripts
                    print(f"DEBUG: Transcribed: {transcript}")
                    transcript_queue.put(transcript)
                    # Emit live transcript to Electron UI
                    socketio.emit('new_transcript', {'text': transcript})
            except Exception as e:
                print(f"ERROR: Error during Whisper transcription: {e}")
                traceback.print_exc()
        else:
            time.sleep(0.1) # Wait if audio_queue is empty

    print("Transcription thread stopped.")


# --- Ollama LLM Processing Thread ---
def process_transcript_with_ollama():
    """
    Pulls transcribed text from transcript_queue, sends it to Ollama,
    parses the response, and updates/emits cheat sheet data.
    """
    print("DEBUG: Inside process_transcript_with_ollama thread.")
    global cheat_sheet_data, is_listening, llm_context_buffer, current_video_title

    # New variables for buffering LLM calls
    llm_processing_buffer_text = ""
    MIN_CHARS_FOR_LLM_CALL = 500  # Adjust this threshold
    LAST_LLM_CALL_TIME = time.time()
    LLM_CALL_INTERVAL_SECONDS = 15  # Call at least every X seconds, even if buffer is small

    while is_listening or not transcript_queue.empty():
        if not transcript_queue.empty():
            latest_transcript = transcript_queue.get()

            # --- Update Rolling Context Buffer ---
            llm_context_buffer.append(latest_transcript)
            
            # Keep buffer within MAX_LLM_CONTEXT_LENGTH
            current_context_text = " ".join(llm_context_buffer)
            while len(current_context_text) > MAX_LLM_CONTEXT_LENGTH and len(llm_context_buffer) > 1:
                llm_context_buffer.pop(0)  # Remove oldest chunk
                current_context_text = " ".join(llm_context_buffer)
            
            print(f"DEBUG: Current LLM context buffer length: {len(current_context_text)} chars.")
            
            # --- Dynamic Title Acquisition ---
            # Update title periodically, not on every single LLM call for performance
            if len(llm_context_buffer) % 5 == 0:  # Check title every 5 transcript chunks
                detected_title = get_active_browser_tab_title()
                if detected_title != current_video_title and "Unknown Video" not in detected_title:
                    current_video_title = detected_title
                    print(f"DEBUG: Detected new video title: '{current_video_title}'")
                    socketio.emit('status', {'message': f'Analyzing: "{current_video_title}"'})
                elif "Unknown Video" in detected_title and current_video_title == "Unknown Video":
                    print(f"DEBUG: Still unable to detect specific video title. Current: {current_video_title}")

            # Add to the processing buffer for the LLM call itself
            llm_processing_buffer_text += " " + latest_transcript

            # Decide when to call LLM
            current_time = time.time()
            if len(llm_processing_buffer_text) >= MIN_CHARS_FOR_LLM_CALL or \
               (current_time - LAST_LLM_CALL_TIME >= LLM_CALL_INTERVAL_SECONDS and len(llm_processing_buffer_text) > 0):
                
                print(f"DEBUG: Triggering LLM call. Buffer chars: {len(llm_processing_buffer_text)}")
                
                # --- Prepare prompt with current context ---
                current_cheat_sheet_json = json.dumps(list(cheat_sheet_data.values()), indent=2)
                
                # Use both the processing buffer and rolling context in the prompt
                prompt = f"""
You are an AI assistant specialized in extracting named entities from video transcripts to create a structured cheat sheet.
Your primary goal is to help a user follow the narrative or informational content of a video.
The current video title is: "{current_video_title}".

Text to analyze for new entities:
{llm_processing_buffer_text}

Broader historical context:
{current_context_text}

Based on this title and the content, identify entities that are relevant to the narrative/story/topic of this specific video. Focus on:

    Characters: Individuals, sentient beings, their roles, and key relationships.

    Locations: Specific places (cities, buildings, fictional realms), their significance.

    Organizations: Groups, factions, institutions relevant to the plot/topic.

    Key Objects/Items: Important artifacts, tools, or unique items that drive the story/topic.

    Concepts/Events: Important ideas, theories, historical events, or major plot points.
    For 'Event' entities, include an optional 'date' key with a relevant date/timeframe if explicitly mentioned.

For each identified entity, provide its 'type' (e.g., "Character", "Location", "Concept"), 'name', and a concise 'description'.
If an entity has been previously mentioned in the context and new information is provided, update its 'description'.
Only include entities that are clearly named or explicitly described in the transcript and are relevant to the main content of the video as suggested by its title and ongoing discussion.

Crucially, format your output as a JSON array of objects.
Each object MUST have the keys 'type', 'name', and 'description'.
For 'Event' type entities, you MAY include an optional 'date' key if a specific date or timeframe is mentioned.
Do NOT include any other keys or outer objects like 'entities'. Just the array.
If no new or updated entities are found that fit the criteria, return an empty array [].

Example JSON for a Character: {{"type": "Character", "name": "John Doe", "description": "A brave knight who served King Arthur."}}
Example JSON for a Location: {{"type": "Location", "name": "Camelot", "description": "King Arthur's legendary castle."}}
Example JSON for an Event: {{"type": "Event", "name": "Battle of Gettysburg", "description": "Major battle of the American Civil War.", "date": "July 1-3, 1863"}}

Current cheat sheet context (as JSON array):
{current_cheat_sheet_json}

JSON Output:
"""
                messages = [
                    {"role": "user", "content": prompt}
                ]

                # Emit the prompt BEFORE the Ollama call
                socketio.emit('llm_communication', {'prompt': prompt})

                try:
                    # Make the call to the local Ollama server
                    response = ollama.chat(model=OLLAMA_MODEL, messages=messages, format='json')
                    content = response['message']['content']

                    # Emit the raw response AFTER the Ollama call (before parsing)
                    socketio.emit('llm_communication', {'response': content})

                    try:
                        extracted_entities = json.loads(content)
                        
                        # --- Robustness: Attempt to unwrap if Ollama put it in an 'entities' object ---
                        if isinstance(extracted_entities, dict) and "entities" in extracted_entities:
                            print("WARNING: Ollama returned an object with 'entities' key. Attempting to unwrap.")
                            extracted_entities = extracted_entities["entities"]

                        if isinstance(extracted_entities, list):
                            print(f"DEBUG: Ollama extracted {len(extracted_entities)} entities from transcript.")
                            for entity in extracted_entities:
                                # --- Robustness: Handle different key names from Ollama if it deviates ---
                                entity_name = entity.get('name') or entity.get('entity') or entity.get('value')
                                entity_type = entity.get('type')
                                entity_description = entity.get('description') or ""

                                # Only process if essential keys are present
                                if entity_name and entity_type:
                                    processed_entity = {
                                        'name': entity_name,
                                        'type': entity_type,
                                        'description': entity_description
                                    }
                                    
                                    existing_entity = cheat_sheet_data.get(processed_entity['name'])
                                    if existing_entity:
                                        # Update description only if new one is more detailed/different
                                        if len(processed_entity['description']) > len(existing_entity['description']) or processed_entity['description'] != existing_entity['description']:
                                            cheat_sheet_data[processed_entity['name']]['description'] = processed_entity['description']
                                            print(f"DEBUG: Updated entity: {processed_entity['name']} ({processed_entity['type']})")
                                            socketio.emit('update_cheat_sheet', cheat_sheet_data[processed_entity['name']])
                                    else:
                                        # Add new entity
                                        cheat_sheet_data[processed_entity['name']] = processed_entity
                                        print(f"DEBUG: New entity found: {processed_entity['name']} ({processed_entity['type']})")
                                        socketio.emit('update_cheat_sheet', cheat_sheet_data[processed_entity['name']])
                                else:
                                    print(f"WARNING: Malformed entity from Ollama (missing 'name'/'type'): {entity}")
                        else:
                            print(f"WARNING: Ollama did not return a JSON array as expected (after unwrap attempt): {content}")

                    except json.JSONDecodeError as e:
                        print(f"ERROR: Failed to decode Ollama JSON: {e}")
                        print(f"ERROR: Content that caused JSON error: {content}")
                    
                except Exception as e:
                    print(f"ERROR: Error calling Ollama API or general processing error: {e}")
                    traceback.print_exc()

                # Reset the processing buffer and timer
                llm_processing_buffer_text = ""
                LAST_LLM_CALL_TIME = current_time
            else:
                # If not calling LLM, skip the rest of the loop and wait for next transcript
                time.sleep(0.1)
                continue  # Go to next iteration of while loop

        else:
            time.sleep(0.1)

    print("Ollama processing thread stopped.")


# --- Flask API Endpoints ---
@app.route('/set_title', methods=['POST'])
def set_title():
    global current_video_title
    data = request.get_json()
    new_title = data.get('title')
    if new_title:
        current_video_title = new_title
        print(f"DEBUG: User-provided video title set: '{current_video_title}'")
        # If already running, update status in UI immediately
        if is_listening:
            socketio.emit('status', {'message': f'Analyzing: "{current_video_title}"'})
        return jsonify({"status": "title set", "title": current_video_title}), 200
    return jsonify({"error": "No title provided"}), 400

@app.route('/start', methods=['POST'])
def start_processing():
    """
    API endpoint to start the audio capture, transcription, and LLM processing threads.
    """
    print("DEBUG: /start endpoint received.")
    global is_listening, cheat_sheet_data, llm_context_buffer, current_video_title
    if not is_listening:
        is_listening = True
        
        # Load data ONLY IF it's not a fresh start
        if not load_session_data(): # Attempt to load previous session
            cheat_sheet_data.clear() # If no session found, start fresh
            llm_context_buffer.clear()
            print("DEBUG: Starting fresh session (no previous data found).")
        else:
            # If loaded, send existing data to frontend for display
            socketio.emit('initial_cheat_sheet', list(cheat_sheet_data.values()))
            socketio.emit('initial_transcript', {"history": llm_context_buffer}) # Send transcript history

        # If no manual title was set, try to get it from the browser
        if current_video_title == "Unknown Video":
            current_video_title = get_active_browser_tab_title()
        
        print(f"DEBUG: App started. Initial/Selected video title: '{current_video_title}'")
        socketio.emit('status', {'message': f'Starting analysis for: "{current_video_title}"'})

        # Start background threads
        print("DEBUG: Launching audio_recorder thread...")
        threading.Thread(target=audio_recorder, daemon=True).start()
        print("DEBUG: Launching transcribe_audio thread...")
        threading.Thread(target=transcribe_audio, daemon=True).start()
        print("DEBUG: Launching process_transcript_with_ollama thread...")
        threading.Thread(target=process_transcript_with_ollama, daemon=True).start()
        print("DEBUG: All threads launched.")
        return jsonify({"status": "started"}), 200
    print("DEBUG: Already listening, /start ignored.")
    return jsonify({"status": "already running"}), 200

@app.route('/stop', methods=['POST'])
def stop_processing():
    """
    API endpoint to stop all audio processing threads.
    """
    print("DEBUG: /stop endpoint received.")
    global is_listening
    if is_listening:
        is_listening = False # This flag signals threads to stop gracefully
        
        save_session_data() # Save before clearing and stopping
        
        # Clear queues immediately for a clean stop
        while not audio_queue.empty(): audio_queue.get()
        while not transcript_queue.empty(): transcript_queue.get()
        
        # Frontend should NOT clear until it receives a specific command or on fresh start.
        # Data persists in backend until a new session or app restart.

        socketio.emit('status', {'message': 'Stopping...'})
        print("DEBUG: Backend stopping processing threads.")
        return jsonify({"status": "stopping"}), 200
    print("DEBUG: Not running, /stop ignored.")
    return jsonify({"status": "not running"}), 200

@app.route('/status', methods=['GET'])
def get_status():
    """
    API endpoint to get the current status of the backend (listening or idle).
    """
    return jsonify({"is_listening": is_listening, "cheat_sheet_size": len(cheat_sheet_data)}), 200

@app.route('/cheat_sheet', methods=['GET'])
def get_cheat_sheet():
    """
    API endpoint to get the current state of the cheat sheet.
    """
    return jsonify(list(cheat_sheet_data.values())), 200

@app.route('/ask_llm', methods=['POST'])
def ask_llm():
    """
    API endpoint for user to ask specific questions to the LLM.
    Uses the current cheat sheet and recent transcript history as context.
    """
    try:
        data = request.get_json()
        user_question = data.get('question')
        if not user_question:
            return jsonify({"error": "No question provided"}), 400

        print(f"DEBUG: Received LLM question: '{user_question}'")
        global llm_messages_history # Add to global here

        # Prepare context for the LLM
        current_cheat_sheet_json = json.dumps(list(cheat_sheet_data.values()), indent=2)
        current_context_text = " ".join(llm_context_buffer) # Use the rolling buffer

        # Prepare messages for this specific Q&A interaction
        qa_messages = list(llm_messages_history) # Copy for this call
        qa_messages.append({"role": "user", "content": user_question}) # Add user's question

        try:
            response = ollama.chat(model=OLLAMA_MODEL, messages=qa_messages)
            ai_answer = response['message']['content'].strip()

            # Update global history for future interactions
            llm_messages_history.append({"role": "user", "content": user_question})
            llm_messages_history.append({"role": "assistant", "content": ai_answer})
            
            # Prune history (same logic as entity extraction)
            MAX_LLM_HISTORY_MESSAGES = 10 # Adjust as needed
            if len(llm_messages_history) > MAX_LLM_HISTORY_MESSAGES + 1:
                llm_messages_history = [llm_messages_history[0]] + llm_messages_history[-(MAX_LLM_HISTORY_MESSAGES):]

            # Emit the response to the LLM monitor
            socketio.emit('llm_communication', {'response': ai_answer})

            print(f"DEBUG: LLM answered question: '{ai_answer}'")
            return jsonify({"answer": ai_answer}), 200

        except Exception as e:
            print(f"ERROR: Error processing LLM question: {e}")
            traceback.print_exc()
            return jsonify({"error": str(e)}), 500

    except Exception as e:
        print(f"ERROR: Error processing LLM question: {e}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# --- SocketIO Events ---
# These are mainly for initial connection and can be expanded for more direct communication
@socketio.on('connect')
def handle_connect():
    print("DEBUG: Client connected via Socket.IO!")
    # Emit status directly on connect, useful for initial UI state
    emit('status', {'message': 'Connected to backend.'})

@socketio.on('disconnect')
def handle_disconnect():
    print("DEBUG: Client disconnected from Socket.IO.")

def save_session_data():
    """
    Saves the current session data (cheat sheet and transcript history) to a JSON file.
    """
    try:
        data_to_save = {
            "cheat_sheet": list(cheat_sheet_data.values()),
            "transcript_history": list(llm_context_buffer) # Save current context buffer
        }
        with open(SESSION_DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump(data_to_save, f, indent=4)
        print("DEBUG: Session data saved.")
    except Exception as e:
        print(f"ERROR: Failed to save session data: {e}")
        traceback.print_exc()

def load_session_data():
    """
    Loads session data from the JSON file if it exists.
    Returns True if data was loaded successfully, False otherwise.
    """
    global cheat_sheet_data, llm_context_buffer
    try:
        if os.path.exists(SESSION_DATA_FILE):
            with open(SESSION_DATA_FILE, 'r', encoding='utf-8') as f:
                loaded_data = json.load(f)
            
            # Clear current data before loading
            cheat_sheet_data.clear()
            llm_context_buffer.clear()

            for entity in loaded_data.get("cheat_sheet", []):
                if 'name' in entity: # Ensure entity has a name
                    cheat_sheet_data[entity['name']] = entity
            llm_context_buffer.extend(loaded_data.get("transcript_history", []))

            print(f"DEBUG: Session data loaded. {len(cheat_sheet_data)} entities, {len(llm_context_buffer)} transcript chunks.")
            return True
        return False
    except Exception as e:
        print(f"ERROR: Failed to load session data: {e}")
        traceback.print_exc()
        return False

# --- Main execution block ---
if __name__ == '__main__':
    # When run directly, start the Flask/SocketIO server
    # debug=False for production use (or when running via Electron)
    print("DEBUG: Starting Flask/SocketIO server...")
    socketio.run(app, host='127.0.0.1', port=5000, debug=False, allow_unsafe_werkzeug=True)