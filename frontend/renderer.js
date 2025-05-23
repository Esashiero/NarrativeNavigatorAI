const toggleButton = document.getElementById('toggleButton');
const statusText = document.getElementById('statusText');
const transcriptDisplay = document.getElementById('transcriptDisplay');
const cheatSheetDisplay = document.getElementById('cheatSheetDisplay');
const logDisplay = document.getElementById('logDisplay');

let isBackendRunning = false;
const cheatSheetEntities = new Map(); // Using a Map to store entities by name for quick lookup/update
const socket = io('http://127.0.0.1:5000'); // Connect to Flask-SocketIO backend

// --- UI Update Functions ---
function updateToggleButton(running) {
    isBackendRunning = running;
    if (running) {
        toggleButton.classList.remove('off');
        toggleButton.classList.add('on');
        toggleButton.textContent = 'Turn Off';
        statusText.textContent = 'Listening and Processing...';
    } else {
        toggleButton.classList.remove('on');
        toggleButton.classList.add('off');
        toggleButton.textContent = 'Turn On';
        statusText.textContent = 'Idle';
    }
}

function appendLog(message) {
    const p = document.createElement('p');
    p.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logDisplay.appendChild(p);
    logDisplay.scrollTop = logDisplay.scrollHeight; // Auto-scroll to bottom
}

function appendTranscript(text) {
    const p = document.createElement('div');
    p.classList.add('transcript-line');
    p.textContent = text;
    transcriptDisplay.appendChild(p);
    transcriptDisplay.scrollTop = transcriptDisplay.scrollHeight; // Auto-scroll
}

function updateCheatSheetItem(entity) {
    let itemElement = document.getElementById(`entity-${entity.name.replace(/\s+/g, '-')}`);
    if (!itemElement) {
        itemElement = document.createElement('div');
        itemElement.id = `entity-${entity.name.replace(/\s+/g, '-')}`;
        itemElement.classList.add('cheat-sheet-item');
        cheatSheetDisplay.appendChild(itemElement); // Add to display
    }

    itemElement.innerHTML = `
        <span class="type">${entity.type}</span>
        <strong>${entity.name}</strong>
        <p>${entity.description}</p>
    `;

    cheatSheetEntities.set(entity.name, entity); // Store in Map

    // Sort the cheat sheet alphabetically by name
    const sortedEntities = Array.from(cheatSheetEntities.values()).sort((a, b) => a.name.localeCompare(b.name));
    cheatSheetDisplay.innerHTML = ''; // Clear current display
    sortedEntities.forEach(e => {
        const existingElement = document.getElementById(`entity-${e.name.replace(/\s+/g, '-')}`);
        if (existingElement) {
            cheatSheetDisplay.appendChild(existingElement); // Re-append existing elements in sorted order
        } else {
            // This case shouldn't happen if logic is correct, but as fallback:
            const newItemElement = document.createElement('div');
            newItemElement.id = `entity-${e.name.replace(/\s+/g, '-')}`;
            newItemElement.classList.add('cheat-sheet-item');
            newItemElement.innerHTML = `
                <span class="type">${e.type}</span>
                <strong>${e.name}</strong>
                <p>${e.description}</p>
            `;
            cheatSheetDisplay.appendChild(newItemElement);
        }
    });

    cheatSheetDisplay.scrollTop = cheatSheetDisplay.scrollHeight; // Auto-scroll
}

// --- Event Listeners ---
toggleButton.addEventListener('click', async () => {
    if (isBackendRunning) {
        const response = await window.electronAPI.stopBackend();
        if (response.success) {
            updateToggleButton(false);
            appendLog('Backend stop command sent.');
            // Clear cheat sheet on stop
            cheatSheetEntities.clear();
            cheatSheetDisplay.innerHTML = '';
            transcriptDisplay.innerHTML = '';
        }
    } else {
        const response = await window.electronAPI.startBackend();
        if (response.success) {
            updateToggleButton(true);
            appendLog('Backend start command sent. Waiting for connection...');
            // Fetch initial cheat sheet data
            const initialCheatSheet = await window.electronAPI.fetchCheatSheet();
            initialCheatSheet.forEach(entity => updateCheatSheetItem(entity));
        }
    }
});

// --- Initial state / Backend Status Check ---
async function initializeUI() {
    const status = await window.electronAPI.fetchStatus();
    updateToggleButton(status.is_listening);
    if (status.is_listening) {
        // If backend was already running, fetch existing cheat sheet
        const initialCheatSheet = await window.electronAPI.fetchCheatSheet();
        initialCheatSheet.forEach(entity => updateCheatSheetItem(entity));
        appendLog('Backend was already running, loaded existing cheat sheet.');
    } else {
        appendLog('App initialized. Backend is idle.');
    }
}

// --- Electron IPC and Socket.IO Event Handlers ---

// Listen for logs from Python backend
window.electronAPI.onPythonLog((message) => {
    appendLog(message);
});

// Socket.IO for real-time updates from Python
socket.on('connect', () => {
    appendLog('Socket.IO connected to backend.');
});

socket.on('disconnect', () => {
    appendLog('Socket.IO disconnected from backend.');
    // If backend disconnected, set UI to off
    updateToggleButton(false); 
});

socket.on('status', (data) => {
    appendLog(`Backend Status: ${data.message}`);
    // If the backend sends a "stopped" status, ensure UI reflects it
    if (data.message.includes('stopped') || data.message.includes('Error')) {
        updateToggleButton(false);
    }
});

socket.on('new_transcript', (data) => {
    appendTranscript(data.text);
    // Basic highlighting logic (can be refined)
    highlightEntitiesInTranscript(data.text);
});

socket.on('update_cheat_sheet', (entity) => {
    updateCheatSheetItem(entity);
    appendLog(`Cheat Sheet Updated: ${entity.name} (${entity.type})`);
});

// Basic Highlighting (MVP): This is a simplified version.
// A more robust solution would check transcript history.
let lastHighlightedEntity = null;
function highlightEntitiesInTranscript(transcriptText) {
    // Remove previous highlight
    if (lastHighlightedEntity) {
        const prevItem = document.getElementById(`entity-${lastHighlightedEntity.replace(/\s+/g, '-')}`);
        if (prevItem) {
            prevItem.classList.remove('highlight');
        }
        lastHighlightedEntity = null;
    }

    // Find if any existing entity name is in the transcript
    let foundEntityName = null;
    for (const [name, entity] of cheatSheetEntities.entries()) {
        // Simple case-insensitive match for MVP
        if (transcriptText.toLowerCase().includes(name.toLowerCase())) {
            foundEntityName = name;
            break; 
        }
    }

    if (foundEntityName) {
        const itemToHighlight = document.getElementById(`entity-${foundEntityName.replace(/\s+/g, '-')}`);
        if (itemToHighlight) {
            itemToHighlight.classList.add('highlight');
            lastHighlightedEntity = foundEntityName;
            // Scroll to highlight
            itemToHighlight.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
}


// --- Initialize UI on load ---
document.addEventListener('DOMContentLoaded', initializeUI);